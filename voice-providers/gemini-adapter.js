/**
 * GeminiAdapter — Voice provider adapter for Google Gemini Live API.
 * 
 * Connects to the Gemini Live API WebSocket and translates Gemini-specific
 * message types into the common VoiceProvider event interface.
 * 
 * Gemini Live API Message Flow:
 *   Client → setup (model, config, system instruction, tools)
 *   Server → setupComplete → 'ready'
 *   Client → realtimeInput (audio chunks)
 *   Server → serverContent (audio/text) → 'audio', 'transcript'
 *   Server → toolCall → 'function-call'
 *   Client → toolResponse
 * 
 * Audio format: 16-bit PCM mono
 *   Input:  16kHz (same as Deepgram)
 *   Output: 24kHz (same as Deepgram)
 */
import { VoiceProvider } from './provider-interface.js';

// Gemini voice config names per agent role
const VOICE_NAMES = {
    router: 'Aoede',         // Warm, friendly
    knowledge: 'Kore',       // Bright, engaging
    brainstorm: 'Charon'     // Calm, thoughtful
};

// Map OpenAI model names to Gemini Live equivalents
// gemini-2.5-flash-native-audio-latest is the current live/realtime model for this API key
const MODEL_MAP = {
    'gpt-4o-mini': 'gemini-2.5-flash-native-audio-latest',
    'gpt-4o': 'gemini-2.5-flash-native-audio-latest'
};

export default class GeminiAdapter extends VoiceProvider {
    constructor(config) {
        super(config);
        this.ws = null;
        this._currentAgentConfig = null;
        this._isSetupComplete = false;
        this._outputTranscriptBuffer = '';
        this._inputTranscriptBuffer = '';
        this._inputTranscriptTimer = null;
    }

    /**
     * Build the Gemini Live API WebSocket URL.
     *
     * API keys (both AIzaSy... and AQ... formats) connect directly to generativelanguage.googleapis.com.
     * True Vertex AI OAuth tokens (ya29...) must be proxied via /api/gemini-live-proxy since
     * browsers can't set Authorization headers on WebSocket connections.
     */
    _getWebSocketUrl() {
        const apiKey = this.config.GEMINI_API_KEY;
        // OAuth access tokens (Vertex AI service account tokens) start with 'ya29.' and need proxying.
        // API keys (AIzaSy... or AQ... GCP-linked keys) can connect directly.
        if (apiKey && apiKey.startsWith('ya29.')) {
            const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            return `${wsProto}//${location.host}/api/gemini-live-proxy`;
        }
        return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    }

    /**
     * Build the Gemini setup message from agent config.
     */
    _buildSetupMessage(agentConfig) {
        const model = MODEL_MAP[agentConfig.model] || 'gemini-2.5-flash-native-audio-latest';
        const voiceName = VOICE_NAMES[agentConfig.agentId] || 'Aoede';

        // Convert Deepgram-style function definitions to Gemini tool format
        const tools = [];
        if (agentConfig.functions && agentConfig.functions.length > 0) {
            const functionDeclarations = agentConfig.functions.map(fn => ({
                name: fn.name,
                description: fn.description,
                parameters: fn.parameters
            }));
            tools.push({ functionDeclarations });
        }

        const setup = {
            setup: {
                model: `models/${model}`,
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: voiceName
                            }
                        }
                    },
                    // Disable thinking tokens — prevents internal reasoning from leaking into transcription
                    thinkingConfig: {
                        thinkingBudget: 0
                    }
                },
                // Transcription fields must be at setup top level, NOT inside generationConfig
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                systemInstruction: {
                    parts: [{ text: agentConfig.prompt }]
                }
            }
        };

        if (tools.length > 0) {
            setup.setup.tools = tools;
        }

        return setup;
    }

    /**
     * Connect to Gemini Live API.
     * @param {Object} agentConfig - Same interface as DeepgramAdapter.connect()
     */
    async connect(agentConfig) {
        const apiKey = this.config.GEMINI_API_KEY;
        if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

        this._currentAgentConfig = agentConfig;
        this._isSetupComplete = false;

        return new Promise((resolve, reject) => {
            const url = this._getWebSocketUrl();
            this.ws = new WebSocket(url);
            this.ws.binaryType = 'arraybuffer';

            // Timeout: if setupComplete not received within 10s, reject with a useful error
            let setupTimeout = setTimeout(() => {
                if (!this._isSetupComplete) {
                    console.error('[Gemini] Setup timeout — no setupComplete received within 10s. WS readyState:', this.ws ? this.ws.readyState : 'null');
                    reject(new Error('Setup timeout: Gemini did not respond within 10 seconds. Check API key and network.'));
                    if (this.ws) this.ws.close();
                }
            }, 10000);

            this.ws.onopen = () => {
                console.log(`[Gemini] WebSocket connected for agent: ${agentConfig.agentId}`);

                // Send setup message
                const setupMsg = this._buildSetupMessage(agentConfig);
                this.ws.send(JSON.stringify(setupMsg));
            };

            this.ws.onmessage = (event) => {
                // Gemini sends control messages (setupComplete, serverContent, etc.) as binary frames.
                // Try to decode ArrayBuffers as UTF-8 JSON first; only treat as raw audio if that fails.
                if (event.data instanceof ArrayBuffer) {
                    let text;
                    try {
                        text = new TextDecoder().decode(event.data);
                    } catch (_) {}
                    if (text) {
                        try {
                            const parsed = JSON.parse(text);
                            // It's a JSON control message in a binary frame — fall through to normal handling
                            event = { data: text };
                        } catch (_) {
                            // Not JSON — it's real binary audio
                            this.emit('audio', event.data);
                            return;
                        }
                    } else {
                        this.emit('audio', event.data);
                        return;
                    }
                }

                let message;
                try {
                    message = JSON.parse(event.data);
                } catch (e) {
                    console.error('[Gemini] Failed to parse message:', e);
                    return;
                }

                console.log('[Gemini] message keys:', Object.keys(message));

                // Setup complete — ready to stream
                if (message.setupComplete) {
                    clearTimeout(setupTimeout);
                    this._isSetupComplete = true;
                    console.log('[Gemini] Setup complete, ready for audio');

                    // Inject conversation history as context turns before signaling ready.
                    // Gemini Live doesn't accept history in setup; inject via clientContent instead.
                    if (agentConfig.historyMessages && agentConfig.historyMessages.length > 0) {
                        const turns = agentConfig.historyMessages
                            .filter(m => m.role === 'user' || m.role === 'assistant')
                            .map(m => ({
                                role: m.role === 'assistant' ? 'model' : 'user',
                                parts: [{ text: m.content }]
                            }));
                        if (turns.length > 0) {
                            console.log(`[Gemini] Injecting ${turns.length} history turns as context`);
                            this.ws.send(JSON.stringify({
                                clientContent: { turns, turnComplete: false }
                            }));
                        }
                    }

                    this.emit('ready', { agentId: agentConfig.agentId, isHotSwap: agentConfig.isHotSwap });
                    resolve();
                    return;
                }

                // Server content (audio responses and/or text)
                if (message.serverContent) {
                    const sc = message.serverContent;

                    // Check if model is "thinking" (turn started but no content yet)
                    if (sc.turnComplete === false && (!sc.modelTurn || !sc.modelTurn.parts)) {
                        this.emit('agent-thinking');
                        return;
                    }

                    if (sc.modelTurn && sc.modelTurn.parts) {
                        for (const part of sc.modelTurn.parts) {
                            // Audio response
                            if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.startsWith('audio/')) {
                                const audioBytes = this._base64ToArrayBuffer(part.inlineData.data);
                                this.emit('agent-speaking');
                                this.emit('audio', audioBytes);
                            }
                            // Text parts (non-audio mode fallback) — accumulate into buffer
                            if (part.text) {
                                this._outputTranscriptBuffer += part.text;
                            }
                        }
                    }

                    // Output transcription chunks — accumulate, emit complete on turnComplete
                    if (sc.outputTranscription && sc.outputTranscription.text) {
                        this._outputTranscriptBuffer += sc.outputTranscription.text;
                    }

                    // Input transcription — Gemini sends incremental chunks (new words only per event).
                    // APPEND each chunk to build the full utterance.
                    // Flush when agent starts generating (definitive end-of-user-turn signal).
                    if (sc.inputTranscription && sc.inputTranscription.text) {
                        // Concatenate directly — Gemini sends sub-word chunks so don't add spaces.
                        // Chunks include their own spacing at word boundaries.
                        // Normalize multiple spaces on emit.
                        this._inputTranscriptBuffer += sc.inputTranscription.text;
                        clearTimeout(this._inputTranscriptTimer);
                        this._inputTranscriptTimer = setTimeout(() => {
                            if (this._inputTranscriptBuffer) {
                                this.emit('transcript', { role: 'user', content: this._inputTranscriptBuffer.trim().replace(/\s+/g, ' ') });
                                this._inputTranscriptBuffer = '';
                            }
                        }, 2000);
                    }

                    // Agent starts generating — flush pending user transcript immediately
                    if ((sc.modelTurn || sc.outputTranscription) && this._inputTranscriptBuffer) {
                        clearTimeout(this._inputTranscriptTimer);
                        this.emit('transcript', { role: 'user', content: this._inputTranscriptBuffer.trim().replace(/\s+/g, ' ') });
                        this._inputTranscriptBuffer = '';
                    }

                    // Turn complete — emit the full buffered agent transcript, then signal done
                    if (sc.turnComplete) {
                        if (this._outputTranscriptBuffer.trim()) {
                            this.emit('transcript', {
                                role: 'assistant',
                                content: this._outputTranscriptBuffer.trim()
                            });
                        }
                        this._outputTranscriptBuffer = '';
                        this.emit('agent-audio-done');
                    }

                    // Interrupted by user (barge-in) — discard incomplete agent transcript
                    if (sc.interrupted) {
                        this._outputTranscriptBuffer = '';
                        clearTimeout(this._inputTranscriptTimer);
                        this._inputTranscriptBuffer = '';
                        this.emit('user-speaking');
                    }
                }

                // Tool call from the model
                if (message.toolCall) {
                    const tc = message.toolCall;
                    if (tc.functionCalls) {
                        for (const fc of tc.functionCalls) {
                            console.log(`[Gemini] Function call: ${fc.name}`, fc.args);
                            this.emit('function-call', {
                                id: fc.id,
                                name: fc.name,
                                arguments: JSON.stringify(fc.args || {})
                            });
                        }
                    }
                }

                // Error
                if (message.error) {
                    this.emit('error', { description: message.error.message || 'Unknown Gemini error' });
                }
            };

            this.ws.onclose = (event) => {
                console.log(`[Gemini] WebSocket disconnected — code: ${event.code}, reason: "${event.reason}", wasClean: ${event.wasClean}`);
                if (!this._isSetupComplete) {
                    const msg = `Connection closed before setup (code ${event.code}: ${event.reason || 'no reason'})`;
                    reject(new Error(msg));
                }
                this.emit('disconnected');
            };

            this.ws.onerror = (err) => {
                console.error('[Gemini] WebSocket error:', err);
                this.emit('error', { description: 'WebSocket connection error' });
                reject(err);
            };
        });
    }

    disconnect() {
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close();
            }
            this.ws = null;
        }
        this._isSetupComplete = false;
        this._outputTranscriptBuffer = '';
        clearTimeout(this._inputTranscriptTimer);
        this._inputTranscriptBuffer = '';
        this._inputTranscriptTimer = null;
    }

    /**
     * Send raw PCM audio to Gemini Live API.
     * Gemini expects base64-encoded audio in a realtimeInput message.
     */
    sendAudio(pcmBuffer) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this._isSetupComplete) return;

        const base64Audio = this._arrayBufferToBase64(pcmBuffer);
        this.ws.send(JSON.stringify({
            realtimeInput: {
                mediaChunks: [{
                    mimeType: 'audio/pcm;rate=16000',
                    data: base64Audio
                }]
            }
        }));
    }

    sendFunctionResponse(id, name, content) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        this.ws.send(JSON.stringify({
            toolResponse: {
                functionResponses: [{
                    id: id,
                    name: name,
                    response: { result: content }
                }]
            }
        }));
    }

    /**
     * Inject a user message as text input.
     * Gemini Live accepts text via clientContent.
     */
    injectUserMessage(text) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        this.ws.send(JSON.stringify({
            clientContent: {
                turns: [{
                    role: 'user',
                    parts: [{ text: text }]
                }],
                turnComplete: true
            }
        }));
    }

    /**
     * Inject an agent message. Gemini doesn't have a direct equivalent,
     * so we inject as a model turn in the conversation context.
     */
    injectAgentMessage(text) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        // Use clientContent with model role to seed the conversation
        this.ws.send(JSON.stringify({
            clientContent: {
                turns: [{
                    role: 'model',
                    parts: [{ text: text }]
                }],
                turnComplete: true
            }
        }));
    }

    isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN && this._isSetupComplete;
    }

    // ---- Utility helpers ----

    _arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    _base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }
}
