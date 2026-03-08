import Speaker from "speaker";


export default class AudioPlayer {
    constructor(sampleRate) {
        this.speaker = new SpeakerWrapper(sampleRate);
        this.bufferedAudio = [];
        this.targetSpeakerAudioMs = 800;

        setInterval(() => this.#refillSpeaker(), 100);
    }

    play(audio) {
        this.bufferedAudio.push(audio);
        this.#refillSpeaker();
    }

    stop() {
        this.bufferedAudio = [];
    }

    #refillSpeaker() {
        while (this.bufferedAudio.length && this.speaker.getBufferedMs() < this.targetSpeakerAudioMs) {
            this.speaker.write(this.bufferedAudio.shift());
        }
    }
}

class SpeakerWrapper {
    constructor(sampleRate) {
        this.speaker = new Speaker({ channels: 1, bitDepth: 16, sampleRate });
        this.msPerSample = 1000 / sampleRate;
        this.lastWriteTime = Date.now();
        this.bufferedMsAtLastWrite = 0;
    }

    write(audio) {
        this.bufferedMsAtLastWrite = this.getBufferedMs() + this.#getAudioDurationMs(audio);
        this.lastWriteTime = Date.now();

        this.speaker.write(audio);
    }

    getBufferedMs() {
        const msSinceLastWrite = Date.now() - this.lastWriteTime;
        return Math.max(this.bufferedMsAtLastWrite - msSinceLastWrite, 0);
    }

    #getAudioDurationMs(audio) {
        const num_samples = audio.length / 2;
        return this.msPerSample * num_samples;
    }
}
