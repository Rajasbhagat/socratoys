/**
 * DeepgramAdapter — Voice provider adapter for Deepgram's Voice Agent API.
 * 
 * Connects to wss://agent.deepgram.com via WebSocket and translates 
 * Deepgram-specific message types into the common VoiceProvider event interface.
 * 
 * Deepgram Message Types → Common Events:
 *   Welcome           → (internal, no event)
 *   SettingsApplied   → 'ready'
 *   UserStartedSpeaking → 'user-speaking'
 *   AgentThinking     → 'agent-thinking'
 *   AgentStartedSpeaking → 'agent-speaking'
 *   AgentAudioDone    → 'agent-audio-done'
 *   ConversationText  → 'transcript'
 *   FunctionCallRequest → 'function-call'
 *   Error             → 'error'
 *   Binary data       → 'audio'
 */
import { VoiceProvider } from './provider-interface.js';

// Voice model mapping per agent role
const VOICE_MODELS = {
    router: 'aura-asteria-en',      // Warm, sweet
    knowledge: 'aura-luna-en',      // Friendly, warm
    brainstorm: 'aura-stella-en'    // Gentle, calming
};

export default class DeepgramAdapter extends VoiceProvider {
    constructor(config) {
        super(config);
        this.ws = null;
        this.url = 'wss://agent.deepgram.com/v1/agent/converse';
    }

    /**
     * Connect to Deepgram Voice Agent API.
     * @param {Object} agentConfig - {
     *   agentId: string,      // 'router' | 'knowledge' | 'brainstorm'
     *   prompt: string,       // Full system prompt (with memory, mode, handoff context injected)
     *   model: string,        // LLM model name (e.g. 'gpt-4o-mini')
     *   functions: Array,     // Function definitions for the agent
     *   historyMessages: Array, // Conversation history for context
     *   isHotSwap: boolean    // Whether this is a mid-session agent swap
     * }
     */
    async connect(agentConfig) {
        const apiKey = this.config.DEEPGRAM_API_KEY;
        if (!apiKey) throw new Error('DEEPGRAM_API_KEY not configured');

        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url, ['token', apiKey]);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                console.log(`[Deepgram] WebSocket connected for agent: ${agentConfig.agentId}`);

                // Build and send Deepgram Settings payload
                const voiceModel = VOICE_MODELS[agentConfig.agentId] || 'aura-asteria-en';
                const payload = {
                    type: 'Settings',
                    audio: {
                        input: { encoding: 'linear16', sample_rate: 16000 },
                        output: { encoding: 'linear16', sample_rate: 24000, container: 'none' }
                    },
                    agent: {
                        listen: {
                            provider: { type: 'deepgram', model: 'nova-2', smart_format: true }
                        },
                        think: {
                            provider: { type: 'open_ai', model: agentConfig.model },
                            prompt: agentConfig.prompt,
                            functions: agentConfig.functions
                        },
                        speak: {
                            provider: { type: 'deepgram', model: voiceModel }
                        }
                    }
                };

                // Attach conversation history if available
                if (agentConfig.historyMessages && agentConfig.historyMessages.length > 0) {
                    payload.agent.context = { messages: agentConfig.historyMessages };
                }

                console.log('[Deepgram] Sending Settings payload');
                this.ws.send(JSON.stringify(payload));
            };

            this.ws.onmessage = (event) => {
                // Binary audio data
                if (event.data instanceof ArrayBuffer) {
                    this.emit('audio', event.data);
                    return;
                }

                // JSON message
                const message = JSON.parse(event.data);
                console.log('[Deepgram]', message);

                switch (message.type) {
                    case 'Welcome':
                        // Settings not yet applied, wait for SettingsApplied
                        break;

                    case 'SettingsApplied':
                        this.emit('ready', { agentId: agentConfig.agentId, isHotSwap: agentConfig.isHotSwap });
                        resolve(); // Connection complete
                        break;

                    case 'UserStartedSpeaking':
                        this.emit('user-speaking');
                        break;

                    case 'AgentThinking':
                        this.emit('agent-thinking');
                        break;

                    case 'AgentStartedSpeaking':
                        this.emit('agent-speaking');
                        break;

                    case 'AgentAudioDone':
                        this.emit('agent-audio-done');
                        break;

                    case 'FunctionCallRequest': {
                        const funcData = message.functions[0];
                        console.log(`[Deepgram] Function call: ${funcData.name}`, funcData.arguments);
                        this.emit('function-call', {
                            id: funcData.id,
                            name: funcData.name,
                            arguments: funcData.arguments
                        });
                        break;
                    }

                    case 'ConversationText':
                        this.emit('transcript', {
                            role: message.role,
                            content: message.content
                        });
                        break;

                    case 'Error':
                        this.emit('error', { description: message.description });
                        break;
                }
            };

            this.ws.onclose = () => {
                console.log('[Deepgram] WebSocket disconnected');
                this.emit('disconnected');
            };

            this.ws.onerror = (err) => {
                console.error('[Deepgram] WebSocket error:', err);
                this.emit('error', { description: 'WebSocket connection error' });
                reject(err);
            };
        });
    }

    disconnect() {
        if (this.ws) {
            // Unbind handlers to prevent cascading disconnect events
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close();
            }
            this.ws = null;
        }
    }

    sendAudio(pcmBuffer) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(pcmBuffer);
        }
    }

    sendFunctionResponse(id, name, content) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'FunctionCallResponse',
                id,
                name,
                content
            }));
        }
    }

    injectUserMessage(text) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'InjectUserMessage',
                content: text
            }));
        }
    }

    injectAgentMessage(text) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'InjectAgentMessage',
                content: text
            }));
        }
    }

    isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }
}
