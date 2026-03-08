import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './db.js';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json()); // Parses incoming JSON payloads

// Serve static frontend files from this directory
app.use(express.static(path.join(__dirname)));

/**
 * ==========================================
 * ANALYTICS API ENDPOINTS
 * ==========================================
 */

// Helper: strip markdown formatting that TTS reads literally
function stripMarkdown(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** → bold
        .replace(/\*(.+?)\*/g, '$1')         // *italic* → italic
        .replace(/^#{1,6}\s+/gm, '')         // ## Header → Header
        .replace(/^[\s]*[-*+]\s+/gm, '')     // - bullet → (plain)
        .replace(/`(.+?)`/g, '$1')           // `code` → code
        .replace(/\[(.+?)\]\(.+?\)/g, '$1') // [link](url) → link
        .trim();
}

// 1. Save a new message record from the Voice Dashboard
app.post('/api/logs', async (req, res) => {
    try {
        const { sessionId, role, content } = req.body;

        if (!sessionId || !role || !content) {
            return res.status(400).json({ error: "Missing required fields: sessionId, role, or content" });
        }

        // Strip markdown so TTS-generated artifacts don't pollute the transcript
        const cleanContent = stripMarkdown(content);

        // Asynchronously save to SQLite so we don't block the caller
        await db.saveMessage(sessionId, role, cleanContent);

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error("Failed to save log:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

// 2. Fetch all conversation sessions for the Admin overview
app.get('/api/conversations', async (req, res) => {
    try {
        const sessions = await db.getSessions();
        res.json(sessions);
    } catch (err) {
        console.error("Failed to load sessions:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// 3. Fetch full chat transcript for a specific session ID
app.get('/api/conversations/:sessionId', async (req, res) => {
    try {
        const messages = await db.getMessagesBySession(req.params.sessionId);
        res.json(messages);
    } catch (err) {
        console.error("Failed to load transcript:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// 4. Summarize a session using Gemini 2.5 Flash
app.post('/api/conversations/:sessionId/summarize', async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const messages = await db.getMessagesBySession(sessionId);

        if (messages.length === 0) {
            return res.status(404).json({ error: "No messages found to summarize." });
        }

        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        // Format the conversation for the LLM
        const transcriptStr = messages.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join("\\n");
        const sysInstruction = `You are a conversational analyst reviewing a chat between an educational AI and a child (5-8 years old).
You must output a JSON object containing:
1. title: A short, fun, clear title for this session.
2. topic: The core topic discussed (e.g. "Science", "History", "Space", or "Other").
3. summary: A fluid summary of what was discussed. The length should dynamically scale based on how long the conversation is. Keep it detailed but concise.
4. user_facts: An array of definitive facts about the child extracted from this session to be kept in long term memory (e.g., "Child loves T-Rex", "Child is 5 years old", "Child gets scared by loud noises"). Only include absolute facts.
5. engagement_score: An integer from 1 to 10 predicting how interested the child remained (10 being thrilled, 1 being completely distracted or bored). 
6. prompt_improvement_suggestion: A single sentence advising the developer on what to modify in the Agent's system prompt to keep this specific child more engaged next time.`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: transcriptStr,
            config: {
                systemInstruction: sysInstruction,
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        title: { type: "STRING" },
                        topic: { type: "STRING" },
                        summary: { type: "STRING" },
                        engagement_score: { type: "INTEGER" },
                        prompt_improvement_suggestion: { type: "STRING" },
                        user_facts: {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    fact: { type: "STRING" },
                                    confidence: { type: "NUMBER" }
                                },
                                required: ["fact", "confidence"]
                            }
                        }
                    },
                    required: ["title", "topic", "summary", "user_facts", "engagement_score", "prompt_improvement_suggestion"]
                }
            }
        });

        const resultJson = JSON.parse(response.text);

        // Save to SQLite
        await db.saveSessionMeta(
            sessionId,
            resultJson.title,
            resultJson.topic,
            resultJson.summary,
            resultJson.engagement_score,
            resultJson.prompt_improvement_suggestion,
            resultJson.user_facts || []
        );

        // Save Extracted Long Term Memory Facts
        if (resultJson.user_facts && resultJson.user_facts.length > 0) {
            for (const item of resultJson.user_facts) {
                if (item.confidence > 0.6) {
                    await db.saveMemory('kid_1', item.fact, item.confidence); // Hardcoded 'kid_1' for now
                }
            }
        }

        res.json({ success: true, metadata: resultJson });
    } catch (err) {
        console.error("Failed to summarize session:", err);
        res.status(500).json({ error: err + "" });
    }
});

// 5. Fetch long term memory for a specific user
app.get('/api/memory/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const memoriesStr = await db.getMemories(userId);
        res.json({ success: true, memories: memoriesStr });
    } catch (err) {
        console.error("Failed to fetch memories:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// 6. Fetch all active agent prompts (for dynamic frontend loading)
app.get('/api/prompts', async (req, res) => {
    try {
        const prompts = await db.getActivePrompts();
        res.json({ success: true, prompts });
    } catch (err) {
        console.error("Failed to fetch prompts:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// 7. Update an agent prompt (deploy new version from Admin panel)
app.post('/api/prompts/:agentId', async (req, res) => {
    try {
        const { agentId } = req.params;
        const { prompt_text } = req.body;
        if (!prompt_text) return res.status(400).json({ error: "prompt_text is required" });

        const result = await db.updateAgentPrompt(agentId, prompt_text);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error(`Failed to update prompt for ${req.params.agentId}:`, err);
        res.status(500).json({ error: "Database error" });
    }
});

// 8. Fetch AI-generated prompt improvement suggestions
app.get('/api/suggestions', async (req, res) => {
    try {
        const suggestions = await db.getPromptSuggestions();
        res.json({ success: true, suggestions });
    } catch (err) {
        console.error("Failed to fetch suggestions:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// 9. Fetch all raw memory rows for a user (for Child Profile tab)
app.get('/api/memory-all/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const memories = await db.getAllMemoriesByUser(userId);
        res.json({ success: true, memories });
    } catch (err) {
        console.error("Failed to fetch all memories:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// 10. Generate Child Profile (persona, strengths, topic gaps) using Gemini
app.post('/api/profile/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const memories = await db.getAllMemoriesByUser(userId);

        if (memories.length === 0) {
            return res.json({
                success: true,
                profile: {
                    persona: "No data yet. Have a few conversations first!",
                    strengths: [],
                    topic_gaps: [],
                    personality_tags: []
                }
            });
        }

        const factsList = memories.map(m => `- ${m.fact} (confidence: ${Math.round(m.confidence * 100)}%)`).join('\n');

        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: `You are a child learning analyst. Based on these extracted facts about a child from educational AI conversations, create a structured learning profile.

CHILD FACTS:
${factsList}

Generate a JSON response with exactly these fields:
- persona: A warm, 2-3 sentence narrative description of who this child is as a learner (write it as if introducing the child, not about them)
- strengths: Array of 3-5 string phrases describing key intellectual strengths and interests
- personality_tags: Array of 4-6 single-word or short personality descriptors (e.g. "Curious", "Detail-oriented")
- topic_gaps: Array of topics from [Science, History, Space, Geography, Math, Art, Music, Nature] that the child has NOT shown interest in yet, suggesting areas to explore`,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        persona: { type: "STRING" },
                        strengths: { type: "ARRAY", items: { type: "STRING" } },
                        personality_tags: { type: "ARRAY", items: { type: "STRING" } },
                        topic_gaps: { type: "ARRAY", items: { type: "STRING" } }
                    },
                    required: ["persona", "strengths", "personality_tags", "topic_gaps"]
                }
            }
        });

        const profile = JSON.parse(response.text);
        res.json({ success: true, profile });
    } catch (err) {
        console.error("Failed to generate child profile:", err);
        res.status(500).json({ error: err + "" });
    }
});

// 11. Semantic deduplication of user memory facts using Jaccard word similarity
app.post('/api/profile/:userId/deduplicate', async (req, res) => {
    try {
        const userId = req.params.userId;
        const memories = await db.getAllMemoriesByUser(userId);

        if (memories.length < 2) {
            return res.json({ success: true, removed: 0, remaining: memories.length });
        }

        // Tokenize fact into a normalized word set
        function tokenize(text) {
            return new Set(
                text.toLowerCase()
                    .replace(/[^a-z0-9\s]/g, '')
                    .split(/\s+/)
                    .filter(w => w.length > 2)  // skip tiny words
            );
        }

        // Jaccard similarity between two word sets
        function jaccard(setA, setB) {
            const intersection = new Set([...setA].filter(w => setB.has(w)));
            const union = new Set([...setA, ...setB]);
            return union.size === 0 ? 0 : intersection.size / union.size;
        }

        const SIMILARITY_THRESHOLD = 0.55;
        const deleteIds = new Set();
        const tokenized = memories.map(m => ({ ...m, words: tokenize(m.fact) }));

        for (let i = 0; i < tokenized.length; i++) {
            if (deleteIds.has(tokenized[i].id)) continue;
            for (let j = i + 1; j < tokenized.length; j++) {
                if (deleteIds.has(tokenized[j].id)) continue;
                const sim = jaccard(tokenized[i].words, tokenized[j].words);
                if (sim >= SIMILARITY_THRESHOLD) {
                    // Keep the higher confidence one; if tied, keep the longer (more specific) fact
                    const keepI = tokenized[i].confidence > tokenized[j].confidence ||
                        (tokenized[i].confidence === tokenized[j].confidence && tokenized[i].fact.length >= tokenized[j].fact.length);
                    deleteIds.add(keepI ? tokenized[j].id : tokenized[i].id);
                }
            }
        }

        // Delete the duplicates from SQLite
        const toDelete = [...deleteIds];
        if (toDelete.length > 0) {
            await new Promise((resolve, reject) => {
                const placeholders = toDelete.map(() => '?').join(',');
                db.rawDB().run(`DELETE FROM user_memory WHERE id IN (${placeholders})`, toDelete, (err) => {
                    if (err) reject(err); else resolve();
                });
            });
        }

        res.json({ success: true, removed: toDelete.length, remaining: memories.length - toDelete.length, deleted_ids: toDelete });
    } catch (err) {
        console.error("Failed to deduplicate memory:", err);
        res.status(500).json({ error: err + "" });
    }
});

// Start Express Server
app.listen(PORT, () => {
    console.log(`🚀 Voice Agent & Analytics Server running on http://localhost:${PORT}`);
});
