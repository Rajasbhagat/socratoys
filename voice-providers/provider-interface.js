/**
 * VoiceProvider — Base class defining the common interface for all voice providers.
 * 
 * Every adapter (Deepgram, Gemini, etc.) extends this class and implements
 * the abstract methods. The frontend uses ONLY these methods, never 
 * provider-specific APIs.
 * 
 * EVENTS EMITTED:
 *   'ready'          → Provider connected and ready to stream
 *   'user-speaking'  → User started speaking (barge-in trigger)
 *   'agent-thinking' → Agent is processing input
 *   'agent-speaking' → Agent started producing audio
 *   'agent-audio-done' → Agent finished speaking
 *   'audio'          → ArrayBuffer of PCM audio to play
 *   'transcript'     → { role: 'user'|'assistant', content: string }
 *   'function-call'  → { id, name, arguments }
 *   'error'          → { description: string }
 *   'disconnected'   → Connection closed
 */
export class VoiceProvider {
    constructor(config) {
        this.config = config;
        this._listeners = {};
    }

    // ---- Event Emitter ----

    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
        return this; // chainable
    }

    off(event, callback) {
        if (!this._listeners[event]) return;
        this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
    }

    emit(event, data) {
        if (this._listeners[event]) {
            this._listeners[event].forEach(cb => {
                try { cb(data); } catch (e) { console.error(`[VoiceProvider] Listener error on '${event}':`, e); }
            });
        }
    }

    // ---- Abstract Methods (must be overridden) ----

    /**
     * Connect to the voice provider and configure the agent.
     * @param {Object} agentConfig - { prompt, model, functions, voiceId, historyMessages, isHotSwap }
     * @returns {Promise<void>}
     */
    async connect(agentConfig) {
        throw new Error('connect() must be implemented by provider adapter');
    }

    /**
     * Disconnect from the voice provider.
     */
    disconnect() {
        throw new Error('disconnect() must be implemented by provider adapter');
    }

    /**
     * Send raw PCM audio from the microphone.
     * @param {ArrayBuffer} pcmBuffer - Int16 PCM audio data
     */
    sendAudio(pcmBuffer) {
        throw new Error('sendAudio() must be implemented by provider adapter');
    }

    /**
     * Respond to a function call from the agent.
     * @param {string} id - Function call ID
     * @param {string} name - Function name
     * @param {string} content - Response content
     */
    sendFunctionResponse(id, name, content) {
        throw new Error('sendFunctionResponse() must be implemented by provider adapter');
    }

    /**
     * Inject a message as if the user said it (triggers agent response).
     * @param {string} text - User message text
     */
    injectUserMessage(text) {
        throw new Error('injectUserMessage() must be implemented by provider adapter');
    }

    /**
     * Inject a message as if the agent said it (for greetings, etc).
     * @param {string} text - Agent message text
     */
    injectAgentMessage(text) {
        throw new Error('injectAgentMessage() must be implemented by provider adapter');
    }

    /**
     * Check if the provider is currently connected.
     * @returns {boolean}
     */
    isConnected() {
        return false;
    }
}
