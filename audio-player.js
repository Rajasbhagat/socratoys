/**
 * Audio Player Module
 *
 * Custom ring-buffer audio player for streaming TTS audio from Deepgram.
 * Deepgram sends audio in small chunks; playing them immediately causes clipping.
 * This module queues and schedules chunks seamlessly to prevent audio artifacts.
 *
 * @module audio-player
 */

import Speaker from "speaker";

/** Target buffer size in milliseconds to prevent audio underrun */
const TARGET_BUFFER_MS = 800;

/** Interval in ms to check and refill the speaker buffer */
const REFILL_INTERVAL_MS = 100;

/**
 * AudioPlayer manages buffered audio playback for streaming TTS.
 * Queues incoming audio chunks and feeds them to the speaker at a controlled rate.
 */
export default class AudioPlayer {
    constructor(sampleRate) {
        this.speaker = new SpeakerWrapper(sampleRate);
        this.bufferedAudio = [];

        // Periodically check if speaker needs more audio
        setInterval(() => this.#refillSpeaker(), REFILL_INTERVAL_MS);
    }

    /**
     * Queue an audio chunk for playback.
     * @param {Buffer} audio - Raw PCM audio data (16-bit, mono)
     */
    play(audio) {
        this.bufferedAudio.push(audio);
        this.#refillSpeaker();
    }

    /**
     * Stop playback and clear the audio buffer.
     */
    stop() {
        this.bufferedAudio = [];
    }

    /**
     * Feed queued audio to the speaker while maintaining target buffer level.
     * @private
     */
    #refillSpeaker() {
        while (this.bufferedAudio.length && this.speaker.getBufferedMs() < TARGET_BUFFER_MS) {
            this.speaker.write(this.bufferedAudio.shift());
        }
    }
}

/**
 * SpeakerWrapper provides buffer-level tracking for the native Speaker.
 * Tracks how much audio is currently buffered to prevent underrun.
 */
class SpeakerWrapper {
    constructor(sampleRate) {
        this.speaker = new Speaker({ channels: 1, bitDepth: 16, sampleRate });
        this.msPerSample = 1000 / sampleRate;
        this.lastWriteTime = Date.now();
        this.bufferedMsAtLastWrite = 0;
    }

    /**
     * Write audio data to the speaker and update buffer tracking.
     * @param {Buffer} audio - Raw PCM audio data
     */
    write(audio) {
        this.bufferedMsAtLastWrite = this.getBufferedMs() + this.#getAudioDurationMs(audio);
        this.lastWriteTime = Date.now();
        this.speaker.write(audio);
    }

    /**
     * Estimate the current buffered audio duration in milliseconds.
     * @returns {number} Estimated buffered audio in ms
     */
    getBufferedMs() {
        const msSinceLastWrite = Date.now() - this.lastWriteTime;
        return Math.max(this.bufferedMsAtLastWrite - msSinceLastWrite, 0);
    }

    /**
     * Calculate the duration of an audio buffer in milliseconds.
     * @param {Buffer} audio - Raw PCM audio data (16-bit = 2 bytes per sample)
     * @returns {number} Duration in milliseconds
     * @private
     */
    #getAudioDurationMs(audio) {
        const numSamples = audio.length / 2;
        return this.msPerSample * numSamples;
    }
}
