import { getActivePrompts, updateAgentPrompt } from './db.js';

(async () => {
    try {
        const prompts = await getActivePrompts();
        for (const p of prompts) {
            let newText = p.prompt_text;

            if (p.agent_id === "router") {
                newText = newText.replace('You are the friendly greeter', 'You are Asteria, the friendly greeter');
                newText = newText.replace('You are Cosmo, a friendly', 'You are Asteria, a friendly');
            } else if (p.agent_id === "knowledge") {
                newText = newText.replace('You are a curious, enthusiastic', 'You are Luna, a curious, enthusiastic');
            } else if (p.agent_id === "brainstorm") {
                newText = newText.replace('You are a warm, gentle Socratic coach', 'You are Stella, a warm, gentle Socratic coach');
            }

            // Only update if it actually changed
            if (newText !== p.prompt_text) {
                await updateAgentPrompt(p.agent_id, newText);
                console.log(`Updated prompt for ${p.agent_id}`);
            } else {
                console.log(`No changes for ${p.agent_id}`);
            }
        }
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
