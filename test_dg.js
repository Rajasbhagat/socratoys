import WebSocket from 'ws';

function testFormat(formatName, formatArray) {
    return new Promise((resolve) => {
        const ws = new WebSocket('wss://agent.deepgram.com/v1/agent/converse', {
            headers: { 'Authorization': 'Token 78c4d5cfa2c4fb0541f961a82e9d207e6a23e0ee' }
        });

        ws.on('open', () => {
            const payload = {
                type: "Settings",
                audio: { input: { encoding: "linear16", sample_rate: 16000 }, output: { encoding: "linear16", sample_rate: 24000, container: "none" } },
                agent: {
                    listen: { provider: { type: "deepgram", model: "nova-2", smart_format: true } },
                    think: { provider: { type: "open_ai", model: "gpt-4o-mini" }, prompt: "Say hello" },
                    speak: { provider: { type: "deepgram", model: "aura-asteria-en" } },
                    context: { messages: formatArray }
                }
            };
            ws.send(JSON.stringify(payload));
        });

        ws.on('message', (msg) => {
            const parsed = JSON.parse(msg.toString());
            if (parsed.type === 'Error') {
                console.log(`[X] Failed: ${formatName} - ${parsed.description}`);
                resolve(false);
            } else if (parsed.type === 'SettingsApplied' || parsed.type === 'Welcome') {
                // Ignore Welcome, wait for SettingsApplied
            }
            if (parsed.type === 'SettingsApplied') {
                console.log(`[OK] Success: ${formatName}`);
                ws.close();
                resolve(true);
            }
        });
        ws.on('error', () => resolve(false));
    });
}

async function runTests() {
    await testFormat('Just role and content', [{ role: "user", content: "Hello" }]);
    await testFormat('With type: Message', [{ type: "Message", role: "user", content: "Hello" }]);
    await testFormat('With type: ConversationText', [{ type: "ConversationText", role: "user", content: "Hello" }]);
    await testFormat('With type: History', [{ type: "History", role: "user", content: "Hello" }]);
    await testFormat('With type: message', [{ type: "message", role: "user", content: "Hello" }]);
    await testFormat('Just content', [{ content: "Hello" }]);
    await testFormat('role user content array', [{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
    await testFormat('role user msg', [{ role: "user", message: "Hello" }]);
    console.log("Tests complete.");
    process.exit(0);
}

runTests();
