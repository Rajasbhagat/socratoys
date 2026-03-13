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

// Map OpenAI model names to Gemini equivalents
const MODEL_MAP = {
    'gpt-4o-mini': 'gemini-2.0-flash-live-001',
    'gpt-4o': 'gemini-2.0-flash-live-001'
};

export default class GeminiAdapter extends VoiceProvider {
    constructor(config) {
        super(config);
        this.ws = null;
        this._currentAgentConfig = null;
        this._isSetupComplete = false;
    }

    /**
     * Build the Gemini Live API WebSocket URL.
     */
    _getWebSocketUrl() {
        const apiKey = this.config.GEMINI_API_KEY;
        const model = this._currentAgentConfig
            ? (MODEL_MAP[this._currentAgentConfig.model] || 'gemini-2.0-flash-live-001')
            : 'gemini-2.0-flash-live-001';
        return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    }

    /**
     * Build the Gemini setup message from agent config.
     */
    _buildSetupMessage(agentConfig) {
        const model = MODEL_MAP[agentConfig.model] || 'gemini-2.0-flash-live-001';
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
                    }
                },
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

            this.ws.onopen = () => {
                console.log(`[Gemini] WebSocket connected for agent: ${agentConfig.agentId}`);

                // Send setup message
                const setupMsg = this._buildSetupMessage(agentConfig);
                console.log('[Gemini] Sending setup:', JSON.stringify(setupMsg).substring(0, 200) + '...');
                this.ws.send(JSON.stringify(setupMsg));
            };

            this.ws.onmessage = (event) => {
                // Binary audio data from Gemini
                if (event.data instanceof ArrayBuffer) {
                    this.emit('audio', event.data);
                    return;
                }

                let message;
                try {
                    message = JSON.parse(event.data);
                } catch (e) {
                    console.error('[Gemini] Failed to parse message:', e);
                    return;
                }

                console.log('[Gemini]', Object.keys(message));

                // Setup complete — ready to stream
                if (message.setupComplete) {
                    this._isSetupComplete = true;
                    console.log('[Gemini] Setup complete, ready for audio');
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
                                // Decode base64 audio to ArrayBuffer
                                const audioBytes = this._base64ToArrayBuffer(part.inlineData.data);
                                this.emit('agent-speaking');
                                this.emit('audio', audioBytes);
                            }

                            // Text response (transcript)
                            if (part.text) {
                                this.emit('transcript', {
                                    role: 'assistant',
                                    content: part.text
                                });
                            }
                        }
                    }

                    // Turn complete
                    if (sc.turnComplete) {
                        this.emit('agent-audio-done');
                    }

                    // Input transcription (what the user said)
                    if (sc.inputTranscription) {
                        this.emit('transcript', {
                            role: 'user',
                            content: sc.inputTranscription.text
                        });
                    }

                    // Output transcription (what the agent said, as text)
                    if (sc.outputTranscription) {
                        this.emit('transcript', {
                            role: 'assistant',
                            content: sc.outputTranscription.text
                        });
                    }

                    // Interrupted by user (barge-in)
                    if (sc.interrupted) {
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

            this.ws.onclose = () => {
                console.log('[Gemini] WebSocket disconnected');
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
