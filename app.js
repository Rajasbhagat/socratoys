import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { WebSocketServer, WebSocket as WS } from 'ws';
import * as db from './db.js';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================================================
// CONFIGURATION CONSTANTS
// =============================================================================

/** Minimum confidence threshold for storing user facts in long-term memory */
const MEMORY_CONFIDENCE_THRESHOLD = 0.6;

/** Jaccard similarity threshold for deduplicating similar memory facts */
const SIMILARITY_THRESHOLD = 0.55;

/** Default user ID - TODO: Replace with proper authentication */
const DEFAULT_USER_ID = 'kid_1';

// =============================================================================
// SHARED SERVICES
// =============================================================================

/**
 * Singleton Gemini AI client instance.
 * Reused across all endpoints to avoid redundant client creation.
 */
const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

/**
 * GET /api/config
 * Returns public configuration and keys for the frontend.
 * This ensures API keys are not hardcoded in the HTML.
 */
const SERVER_START_TIME = Date.now();

app.get('/api/config', (req, res) => {
    const provider = process.env.VOICE_PROVIDER || 'deepgram';
    res.json({
        VOICE_PROVIDER: provider,
        DEEPGRAM_API_KEY: provider === 'deepgram' ? process.env.DEEPGRAM_API_KEY : undefined,
        GEMINI_API_KEY: provider === 'gemini' ? process.env.GEMINI_API_KEY : undefined,
        _v: SERVER_START_TIME, // cache-buster for adapter JS modules
    });
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Strip markdown formatting from text before storing in database.
 * Prevents TTS artifacts (bold, italic, headers, etc.) from polluting transcripts.
 * @param {string} text - Raw text potentially containing markdown
 * @returns {string} Clean text with markdown syntax removed
 */
function stripMarkdown(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, '$1')    // **bold** → bold
        .replace(/\*(.+?)\*/g, '$1')        // *italic* → italic
        .replace(/^#{1,6}\s+/gm, '')        // ## Header → Header
        .replace(/^[\s]*[-*+]\s+/gm, '')    // - bullet → (plain)
        .replace(/`(.+?)`/g, '$1')          // `code` → code
        .replace(/\[(.+?)\]\(.+?\)/g, '$1') // [link](url) → link
        .trim();
}

/**
 * Tokenize text into a normalized word set for Jaccard comparison.
 * Filters out short words (<=2 chars) and punctuation.
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenizeWords(text) {
    return new Set(
        text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 2)
    );
}

/**
 * Calculate Jaccard similarity between two word sets.
 * Returns 0-1 where 1 means identical word sets.
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number}
 */
function jaccardSimilarity(setA, setB) {
    const intersection = new Set([...setA].filter(w => setB.has(w)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Deduplicate a user's memories in-place using Jaccard word similarity.
 * Removes near-duplicate facts, keeping the higher-confidence or longer version.
 * Runs automatically after each session summarization once > 10 facts exist.
 * @param {string} userId
 */
async function autoDeduplicateMemories(userId) {
    try {
        const memories = await db.getAllMemoriesByUser(userId);
        if (memories.length < 10) return; // Not enough facts to bother

        const deleteIds = new Set();
        const tokenized = memories.map(m => ({ ...m, words: tokenizeWords(m.fact) }));

        for (let i = 0; i < tokenized.length; i++) {
            if (deleteIds.has(tokenized[i].id)) continue;
            for (let j = i + 1; j < tokenized.length; j++) {
                if (deleteIds.has(tokenized[j].id)) continue;
                const similarity = jaccardSimilarity(tokenized[i].words, tokenized[j].words);
                if (similarity >= SIMILARITY_THRESHOLD) {
                    const keepFirst = tokenized[i].confidence > tokenized[j].confidence ||
                        (tokenized[i].confidence === tokenized[j].confidence && tokenized[i].fact.length >= tokenized[j].fact.length);
                    deleteIds.add(keepFirst ? tokenized[j].id : tokenized[i].id);
                }
            }
        }

        if (deleteIds.size > 0) {
            const toDelete = [...deleteIds];
            const placeholders = toDelete.map(() => '?').join(',');
            await new Promise((resolve, reject) => {
                db.rawDB().run(`DELETE FROM user_memory WHERE id IN (${placeholders})`, toDelete, (err) => {
                    if (err) reject(err); else resolve();
                });
            });
            console.log(`[Memory] Auto-dedup removed ${deleteIds.size} duplicate facts for ${userId}`);
        }
    } catch (err) {
        console.warn('[Memory] Auto-dedup failed (non-critical):', err.message);
    }
}

// =============================================================================
// ANALYTICS API ENDPOINTS
// =============================================================================

/**
 * POST /api/session-start
 * Seed a minimal session_analytics stub immediately when a session or handoff starts.
 * Ensures agent_type and user_id are recorded even if Gemini summarization fails later.
 * Called by index.html on fresh connect and on every agent handoff.
 */
app.post('/api/session-start', async (req, res) => {
    try {
        const { sessionId, userId, agentType, mode } = req.body;
        if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
        await db.seedSessionAnalytics(sessionId, userId || DEFAULT_USER_ID, agentType || null, mode || null);
        return res.json({ success: true });
    } catch (err) {
        console.error('Failed to seed session stub:', err);
        return res.status(500).json({ error: 'Database error' });
    }
});

/**
 * POST /api/logs
 * Save a conversation message from the Voice Dashboard.
 * Called by index.html when user/agent messages are transcribed.
 */
app.post('/api/logs', async (req, res) => {
    try {
        const { sessionId, role, content, userId } = req.body;

        if (!sessionId || !role || !content) {
            return res.status(400).json({ error: "Missing required fields: sessionId, role, or content" });
        }

        const cleanContent = stripMarkdown(content);
        await db.saveMessage(sessionId, role, cleanContent, userId || 'kid_1');

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error("Failed to save log:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * GET /api/conversations/:userId
 * Fetch all conversation sessions for the Admin dashboard overview.
 * Returns session metadata including message counts and Gemini analysis.
 */
app.get('/api/conversations/:userId', async (req, res) => {
    try {
        const sessions = await db.getSessions(req.params.userId || 'kid_1');
        return res.json(sessions);
    } catch (err) {
        console.error("Failed to load sessions:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * GET /api/sessions/:sessionId
 * Fetch the full chat transcript for a specific session.
 * Returns all messages in chronological order.
 *
 * NOTE: This uses /api/sessions/ (not /api/conversations/) to avoid the Express
 * route collision with GET /api/conversations/:userId which has the same pattern.
 */
app.get('/api/sessions/:sessionId', async (req, res) => {
    try {
        const messages = await db.getMessagesBySession(req.params.sessionId);
        return res.json(messages);
    } catch (err) {
        console.error("Failed to load transcript:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * POST /api/conversations/:sessionId/summarize
 * Analyze a conversation using Gemini AI to extract:
 * - Title and topic classification
 * - Engagement score (1-10)
 * - User facts for long-term memory
 * - Prompt improvement suggestions
 */
app.post('/api/conversations/:sessionId/summarize', async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const messages = await db.getMessagesBySession(sessionId);

        if (messages.length === 0) {
            return res.status(404).json({ error: "No messages found to summarize." });
        }

        // Format the conversation transcript for Gemini analysis
        const transcriptStr = messages.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join("\n");

        const sysInstruction = `You are a conversational analyst reviewing a chat between an educational AI and a child (5-8 years old).
You must output a JSON object containing:
1. title: A short, fun, clear title for this session.
2. topic: The core topic discussed. This can be any topic the child explored (e.g. "Dinosaurs", "Volcanoes", "Friendship", "Feelings", "Space", "Animals", "Problem-Solving", etc.). Be specific rather than generic.
3. summary: A fluid summary of what was discussed. The length should dynamically scale based on how long the conversation is. Keep it detailed but concise.
4. user_facts: An array of definitive facts about the child extracted from this session to be kept in long term memory (e.g., "Child loves T-Rex", "Child is 5 years old", "Child gets scared by loud noises"). Only include absolute facts.
5. engagement_score: An integer from 1 to 10 predicting how interested the child remained (10 being thrilled, 1 being completely distracted or bored).
6. prompt_improvement_suggestion: A single sentence advising the developer on what to modify in the Agent's system prompt to keep this specific child more engaged next time.
7. agent_type: Which agent handled this conversation - "knowledge", "brainstorm", or "router". Infer from conversation style.
8. thinking_patterns: Analyze the CHILD's utterances only:
   - reasoning_connective_count: count of because/so/therefore/if-then in child utterances
   - epistemic_marker_count: count of I think/maybe/I'm not sure/I know in child utterances
   - hypothesis_count: count of what if/maybe it could be/another way in child utterances
   - self_correction_count: count of oh wait/I changed my mind/actually in child utterances
9. behavioral_patterns: Analyze the child's behavior:
   - persistence_score: 0-1 scale, how much child persists with challenging questions vs giving up
   - exploration_style: "broad_sampler" or "deep_diver" based on topic switching patterns
   - help_seeking_count: number of times child asked for help or said I don't know
   - child_question_count: number of questions the child asked
10. engagement_signals: Detailed engagement metrics:
    - child_turn_count: number of child turns
    - avg_child_utterance_length: average words per child utterance
    - on_task_ratio: 0-1, proportion of on-topic child utterances
    - positive_affect_count: count of wow/cool/awesome/fun type expressions
    - negative_affect_count: count of boring/don't care/I don't like type expressions
11. interest_topics: Array of topics discussed with estimated_minutes (integer) and engagement_level ("high", "medium", or "low")
12. safety_alerts: Array of strings describing any safety-relevant moments (empty array if none)`;

        const response = await geminiClient.models.generateContent({
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
                        },
                        agent_type: { type: "STRING" },
                        thinking_patterns: {
                            type: "OBJECT",
                            properties: {
                                reasoning_connective_count: { type: "INTEGER" },
                                epistemic_marker_count: { type: "INTEGER" },
                                hypothesis_count: { type: "INTEGER" },
                                self_correction_count: { type: "INTEGER" }
                            },
                            required: ["reasoning_connective_count", "epistemic_marker_count", "hypothesis_count", "self_correction_count"]
                        },
                        behavioral_patterns: {
                            type: "OBJECT",
                            properties: {
                                persistence_score: { type: "NUMBER" },
                                exploration_style: { type: "STRING" },
                                help_seeking_count: { type: "INTEGER" },
                                child_question_count: { type: "INTEGER" }
                            },
                            required: ["persistence_score", "exploration_style", "help_seeking_count", "child_question_count"]
                        },
                        engagement_signals: {
                            type: "OBJECT",
                            properties: {
                                child_turn_count: { type: "INTEGER" },
                                avg_child_utterance_length: { type: "NUMBER" },
                                on_task_ratio: { type: "NUMBER" },
                                positive_affect_count: { type: "INTEGER" },
                                negative_affect_count: { type: "INTEGER" }
                            },
                            required: ["child_turn_count", "avg_child_utterance_length", "on_task_ratio", "positive_affect_count", "negative_affect_count"]
                        },
                        interest_topics: {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    topic: { type: "STRING" },
                                    estimated_minutes: { type: "INTEGER" },
                                    engagement_level: { type: "STRING" }
                                },
                                required: ["topic", "estimated_minutes", "engagement_level"]
                            }
                        },
                        safety_alerts: {
                            type: "ARRAY",
                            items: { type: "STRING" }
                        }
                    },
                    required: ["title", "topic", "summary", "user_facts", "engagement_score", "prompt_improvement_suggestion",
                        "agent_type", "thinking_patterns", "behavioral_patterns", "engagement_signals", "interest_topics", "safety_alerts"]
                }
            }
        });

        const resultJson = JSON.parse(response.text);

        // Use dynamic user_id from request body, fallback to DEFAULT_USER_ID
        const userId = req.body.user_id || DEFAULT_USER_ID;

        // Save to sessions_meta (existing fields)
        await db.saveSessionMeta(
            sessionId,
            resultJson.title,
            resultJson.topic,
            resultJson.summary,
            resultJson.engagement_score,
            resultJson.prompt_improvement_suggestion,
            resultJson.user_facts || []
        );

        // Save expanded analytics to session_analytics table
        const tp = resultJson.thinking_patterns || {};
        const bp = resultJson.behavioral_patterns || {};
        const es = resultJson.engagement_signals || {};
        await db.saveSessionAnalytics({
            session_id: sessionId,
            user_id: userId,
            agent_type: resultJson.agent_type || null,
            mode: null,
            turn_count: messages.length,
            child_turn_count: es.child_turn_count || null,
            avg_child_utterance_length: es.avg_child_utterance_length || null,
            child_question_count: bp.child_question_count || null,
            on_task_ratio: es.on_task_ratio || null,
            positive_affect_count: es.positive_affect_count || null,
            negative_affect_count: es.negative_affect_count || null,
            reasoning_connective_count: tp.reasoning_connective_count || null,
            epistemic_marker_count: tp.epistemic_marker_count || null,
            hypothesis_count: tp.hypothesis_count || null,
            self_correction_count: tp.self_correction_count || null,
            topics_explored: (resultJson.interest_topics || []).map(t => t.topic),
            exploration_style: bp.exploration_style || null,
            persistence_score: bp.persistence_score || null,
            help_seeking_count: bp.help_seeking_count || null,
            safety_alerts: resultJson.safety_alerts || []
        });

        // Upsert child interests from interest_topics
        if (resultJson.interest_topics && resultJson.interest_topics.length > 0) {
            const engagementMap = { high: 1.0, medium: 0.6, low: 0.3 };
            for (const interest of resultJson.interest_topics) {
                const engagementVal = engagementMap[interest.engagement_level] || 0.5;
                const timeSeconds = (interest.estimated_minutes || 1) * 60;
                await db.upsertChildInterest(userId, interest.topic, timeSeconds, engagementVal);
            }
        }

        // Save high-confidence facts to long-term memory for user personalization
        let newFactsAdded = 0;
        if (resultJson.user_facts && resultJson.user_facts.length > 0) {
            for (const item of resultJson.user_facts) {
                if (item.confidence > MEMORY_CONFIDENCE_THRESHOLD) {
                    await db.saveMemory(userId, item.fact, item.confidence);
                    newFactsAdded++;
                }
            }
        }

        // Auto-deduplicate memories when new facts were added and total exceeds threshold.
        // Runs in background — failure is non-fatal.
        if (newFactsAdded > 0) {
            autoDeduplicateMemories(userId);
        }

        return res.json({ success: true, metadata: resultJson });
    } catch (err) {
        console.error("Failed to summarize session:", err);
        // Record the failure in sessions_meta so admin can see which sessions need re-analysis
        try {
            await db.saveSessionMeta(
                req.params.sessionId,
                '[Analysis Failed]',
                null,
                `Gemini analysis failed: ${err.message}`,
                null, null, []
            );
        } catch (_) { /* best-effort, don't throw */ }
        return res.status(500).json({ error: String(err) });
    }
});

/**
 * GET /api/memory/:userId
 * Fetch long-term memory facts for a specific user.
 * Returns a concatenated string of facts for prompt injection.
 */
app.get('/api/memory/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const memoriesStr = await db.getMemories(userId);
        return res.json({ success: true, memories: memoriesStr });
    } catch (err) {
        console.error("Failed to fetch memories:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * GET /api/prompts
 * Fetch all active agent prompts for dynamic frontend loading.
 * Used by index.html to configure Deepgram voice agents.
 */
app.get('/api/prompts', async (req, res) => {
    try {
        const { userId } = req.query;
        const prompts = userId
            ? await db.getActivePromptsForUser(userId)
            : await db.getActivePrompts();
        return res.json({ success: true, prompts });
    } catch (err) {
        console.error("Failed to fetch prompts:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * POST /api/prompts/:agentId
 * Update the global agent prompt (legacy endpoint, kept for compatibility).
 */
app.post('/api/prompts/:agentId', async (req, res) => {
    try {
        const { agentId } = req.params;
        const { prompt_text } = req.body;
        if (!prompt_text) {
            return res.status(400).json({ error: "prompt_text is required" });
        }

        const result = await db.updateAgentPrompt(agentId, prompt_text);
        return res.json({ success: true, data: result });
    } catch (err) {
        console.error(`Failed to update prompt for ${req.params.agentId}:`, err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * POST /api/prompts/:userId/:agentId
 * Save a user-specific agent prompt (per-kid prompt tuning from Admin panel).
 */
app.post('/api/prompts/:userId/:agentId', async (req, res) => {
    try {
        const { userId, agentId } = req.params;
        const { prompt_text } = req.body;
        if (!prompt_text) {
            return res.status(400).json({ error: "prompt_text is required" });
        }

        const result = await db.saveUserPrompt(userId, agentId, prompt_text);
        return res.json({ success: true, data: result });
    } catch (err) {
        console.error(`Failed to save user prompt for ${req.params.userId}/${req.params.agentId}:`, err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * DELETE /api/prompts/:userId/:agentId
 * Remove a user-specific prompt override, reverting the kid to the global default.
 */
app.delete('/api/prompts/:userId/:agentId', async (req, res) => {
    try {
        const { userId, agentId } = req.params;
        await db.deleteUserPrompt(userId, agentId);
        return res.json({ success: true });
    } catch (err) {
        console.error(`Failed to reset prompt for ${req.params.userId}/${req.params.agentId}:`, err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * GET /api/agent-stats/:userId/:agentType
 * Return session count and avg engagement for one agent + one kid.
 */
app.get('/api/agent-stats/:userId/:agentType', async (req, res) => {
    try {
        const { userId, agentType } = req.params;
        const stats = await db.getAgentStats(userId, agentType);
        return res.json({ success: true, stats });
    } catch (err) {
        console.error('Failed to get agent stats:', err);
        return res.status(500).json({ error: 'Database error' });
    }
});

/**
 * POST /api/prompts/:userId/:agentId/auto-tune
 * Use Gemini to generate a personalised version of an agent's prompt
 * based on the child's interests, memory facts, engagement trends, and
 * past improvement suggestions.
 */
app.post('/api/prompts/:userId/:agentId/auto-tune', async (req, res) => {
    try {
        const { userId, agentId } = req.params;

        // Gather kid context in parallel
        const [profile, interests, memories, engTrends, behavior, suggestions] = await Promise.all([
            db.getChildProfile(userId),
            db.getChildInterests(userId),
            db.getAllMemoriesByUser(userId),
            db.getEngagementTrends(userId),
            db.getBehaviorSummary(userId),
            db.getPromptSuggestions(userId, agentId)
        ]);

        // Get current active prompt for this agent + kid
        const prompts = await db.getActivePromptsForUser(userId);
        const currentPrompt = prompts.find(p => p.agent_id === agentId);
        if (!currentPrompt) {
            return res.status(404).json({ error: 'No active prompt found for this agent' });
        }

        const scores = engTrends.filter(t => t.engagement_score != null).map(t => t.engagement_score);
        const avgEngagement = scores.length > 0
            ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
            : 'unknown';

        const agentNames = {
            router: 'Initial Chat (Router)',
            knowledge: 'Knowledge Explorer',
            brainstorm: 'Brainstorming Coach'
        };

        // Parse onboarding topic preferences for this child
        let parsedPrefs = null;
        try {
            if (profile && profile.preferences) {
                parsedPrefs = typeof profile.preferences === 'string'
                    ? JSON.parse(profile.preferences)
                    : profile.preferences;
            }
        } catch (_) { /* ignore malformed prefs */ }

        const allowedTopicsStr = parsedPrefs && parsedPrefs.allowed && parsedPrefs.allowed.length > 0
            ? parsedPrefs.allowed.join(', ')
            : 'All standard educational topics';
        const blockedTopicsStr = parsedPrefs && parsedPrefs.blocked && parsedPrefs.blocked.length > 0
            ? parsedPrefs.blocked.join(', ')
            : 'None specified';

        const sysInstruction = `You are an expert in child education and AI prompt engineering for conversational agents serving children aged 5-10.
You are given information about a specific child and the current system prompt for an AI agent. Your task is to rewrite the prompt to be specifically personalised for this child while preserving all core educational goals and behavioural instructions.

Child Profile:
- Name: ${profile ? profile.display_name : 'Unknown'}
- Age: ${profile && profile.age ? profile.age + ' years old' : 'Unknown age'}
- Average engagement score with this agent: ${avgEngagement}/10
- Learning style: ${behavior && behavior.predominant_exploration_style ? behavior.predominant_exploration_style.replace('_', ' ') : 'unknown'}
- Persistence score: ${behavior && behavior.avg_persistence_score != null ? (behavior.avg_persistence_score * 100).toFixed(0) + '%' : 'unknown'}

Parent-Configured Topic Preferences (onboarding):
- Allowed topics: ${allowedTopicsStr}
- Blocked topics (MUST remain blocked in rewritten prompt): ${blockedTopicsStr}

Child's Top Interests (use as examples and engagement hooks — only within allowed topics):
${interests.slice(0, 6).map(i => `- ${i.topic} (explored ${i.session_count} time${i.session_count !== 1 ? 's' : ''})`).join('\n') || '- No interests recorded yet'}

Known Facts About This Child (reference naturally where relevant):
${memories.slice(0, 8).map(m => `- ${m.fact}`).join('\n') || '- No facts recorded yet'}

Past AI Suggestions for Improving This Agent With This Child:
${suggestions.slice(0, 5).map(s => `- ${s.prompt_improvement_suggestion}`).join('\n') || '- No suggestions yet'}

CURRENT AGENT PROMPT ("${agentNames[agentId] || agentId}"):
---
${currentPrompt.prompt_text}
---

Rewriting rules:
1. Keep ALL functional instructions (routing logic, function call definitions, safety rules, behavioural guidelines) EXACTLY as-is — do not remove or alter them.
2. CRITICAL: The rewritten prompt MUST preserve or strengthen the blocked topic restrictions. Never remove, soften, or omit any reference to blocked topics. If the current prompt has a [TOPIC BOUNDARIES] section, keep it verbatim and update with the parent's blocked list above.
3. Only use topics from the allowed list when adding interest-based examples or engagement hooks.
4. Personalise tone and examples to match this child's interests and learning style.
5. Add 1-2 specific interest-based example topics or conversation hooks in appropriate places (from allowed topics only).
6. Adjust complexity cues based on age and engagement patterns.
7. If avg engagement is below 6, add more excitement cues, shorter response guidance, and engagement recovery strategies.
8. If the child is a deep_diver, encourage deeper exploration; if broad_sampler, acknowledge topic switching gracefully.
9. Return ONLY the revised prompt text — no explanations, no preamble, no markdown headers.`;

        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: 'Personalise this agent prompt for the child described.',
            config: { systemInstruction: sysInstruction }
        });

        const tunedPrompt = response.text.trim();
        return res.json({ success: true, tuned_prompt: tunedPrompt });
    } catch (err) {
        console.error('Auto-tune failed:', err);
        return res.status(500).json({ error: String(err) });
    }
});

/**
 * GET /api/suggestions
 * Fetch AI-generated prompt improvement suggestions from past sessions.
 * Used by Admin panel to display actionable insights.
 */
app.get('/api/suggestions', async (req, res) => {
    try {
        const { userId, agentId } = req.query;
        const suggestions = await db.getPromptSuggestions(userId || null, agentId || null);
        return res.json({ success: true, suggestions });
    } catch (err) {
        console.error("Failed to fetch suggestions:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * GET /api/memory-all/:userId
 * Fetch all raw memory rows for a user (for Child Profile tab).
 * Returns full memory objects including confidence scores and timestamps.
 */
app.get('/api/memory-all/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const memories = await db.getAllMemoriesByUser(userId);
        return res.json({ success: true, memories });
    } catch (err) {
        console.error("Failed to fetch all memories:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * POST /api/greeting
 * Generate a personalized opening fact for the Router agent.
 * Uses child's top interest (if established) to pick a relevant hook topic,
 * then fetches a random fact as the actual content.
 * Falls back gracefully so the voice agent flow never breaks.
 */
app.post('/api/greeting', async (req, res) => {
    const FALLBACK_GREETING = "Did you know that octopuses actually have three hearts and blue blood? Two hearts pump blood to their gills, and the third pumps it to the rest of their body. Pretty wild, right?";

    try {
        const { userId } = req.body;

        // Fetch interests, profile (for preferences), and a random fact in parallel
        const [interests, profile, factData] = await Promise.all([
            userId ? db.getChildInterests(userId).catch(() => []) : Promise.resolve([]),
            userId ? db.getChildProfile(userId).catch(() => null) : Promise.resolve(null),
            fetch('https://uselessfacts.jsph.pl/api/v2/facts/random')
                .then(r => r.json())
                .catch(() => null)
        ]);

        const randomFact = factData?.text?.trim() || FALLBACK_GREETING;

        // Parse the parent's topic preferences to filter the interest hook
        let blockedTopics = [];
        try {
            if (profile && profile.preferences) {
                const prefs = typeof profile.preferences === 'string'
                    ? JSON.parse(profile.preferences)
                    : profile.preferences;
                blockedTopics = prefs.blocked || [];
            }
        } catch (_) { /* ignore */ }

        // Helper: check if a topic overlaps with any blocked topic string (case-insensitive substring)
        const isTopicBlocked = (topic) => blockedTopics.some(b =>
            topic.toLowerCase().includes(b.toLowerCase().split('&')[0].trim()) ||
            b.toLowerCase().includes(topic.toLowerCase().split('&')[0].trim())
        );

        // If the child has a strong established interest (explored 2+ times) that is NOT blocked,
        // append a callback hook so the router agent can naturally bridge back to their favourite topic
        const topInterest = interests.find(i => i.session_count >= 2 && !isTopicBlocked(i.topic));
        const interestHook = topInterest
            ? ` By the way, last time we talked you were really into ${topInterest.topic} — we could explore that more today if you want!`
            : '';

        return res.json({ success: true, greeting: randomFact + interestHook });
    } catch (err) {
        console.error("Failed to generate greeting:", err);
        return res.json({ success: false, greeting: FALLBACK_GREETING });
    }
});

/**
 * POST /api/profile/:userId
 * Generate a comprehensive child learning profile using Gemini AI.
 * Analyzes accumulated memory facts to identify:
 * - Learning persona narrative
 * - Intellectual strengths and interests
 * - Personality descriptors
 * - Topic gaps to explore
 */
app.post('/api/profile/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const memories = await db.getAllMemoriesByUser(userId);

        // Return empty profile if no data collected yet
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

        // Format facts with confidence percentages for Gemini analysis
        const factsList = memories.map(m => `- ${m.fact} (confidence: ${Math.round(m.confidence * 100)}%)`).join('\n');

        const response = await geminiClient.models.generateContent({
            model: "gemini-2.5-flash",
            contents: `You are a child learning analyst. Based on these extracted facts about a child from educational AI conversations, create a structured learning profile.

CHILD FACTS:
${factsList}

Generate a JSON response with exactly these fields:
- persona: A warm, 2-3 sentence narrative description of who this child is as a learner (write it as if introducing the child, not about them)
- strengths: Array of 3-5 string phrases describing key intellectual strengths and interests
- personality_tags: Array of 4-6 single-word or short personality descriptors (e.g. "Curious", "Detail-oriented")
- topic_gaps: Array of broad topic areas the child has NOT shown interest in yet, suggesting areas to explore (e.g. Science, History, Space, Geography, Math, Art, Music, Nature, Animals, Sports, Technology, Feelings, Problem-Solving)`,
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
        return res.json({ success: true, profile });
    } catch (err) {
        console.error("Failed to generate child profile:", err);
        return res.status(500).json({ error: String(err) });
    }
});

/**
 * POST /api/profile/:userId/deduplicate
 * Remove semantically duplicate memory facts using Jaccard word similarity.
 * Keeps the higher-confidence or more specific (longer) fact when duplicates found.
 */
app.post('/api/profile/:userId/deduplicate', async (req, res) => {
    try {
        const userId = req.params.userId;
        const memories = await db.getAllMemoriesByUser(userId);

        if (memories.length < 2) {
            return res.json({ success: true, removed: 0, remaining: memories.length });
        }

        const deleteIds = new Set();
        const tokenized = memories.map(m => ({ ...m, words: tokenizeWords(m.fact) }));

        // Compare all pairs of facts to find semantic duplicates
        for (let i = 0; i < tokenized.length; i++) {
            if (deleteIds.has(tokenized[i].id)) continue;
            for (let j = i + 1; j < tokenized.length; j++) {
                if (deleteIds.has(tokenized[j].id)) continue;
                const similarity = jaccardSimilarity(tokenized[i].words, tokenized[j].words);
                if (similarity >= SIMILARITY_THRESHOLD) {
                    // Keep the higher confidence fact; if tied, keep the longer (more specific) one
                    const keepFirst = tokenized[i].confidence > tokenized[j].confidence ||
                        (tokenized[i].confidence === tokenized[j].confidence && tokenized[i].fact.length >= tokenized[j].fact.length);
                    deleteIds.add(keepFirst ? tokenized[j].id : tokenized[i].id);
                }
            }
        }

        // Batch delete duplicate facts from SQLite
        const toDelete = [...deleteIds];
        if (toDelete.length > 0) {
            await new Promise((resolve, reject) => {
                const placeholders = toDelete.map(() => '?').join(',');
                db.rawDB().run(`DELETE FROM user_memory WHERE id IN (${placeholders})`, toDelete, (err) => {
                    if (err) reject(err); else resolve();
                });
            });
        }

        return res.json({
            success: true,
            removed: toDelete.length,
            remaining: memories.length - toDelete.length,
            deleted_ids: toDelete
        });
    } catch (err) {
        console.error("Failed to deduplicate memory:", err);
        return res.status(500).json({ error: String(err) });
    }
});

// =============================================================================
// LEARNING INSIGHTS API ENDPOINTS
// =============================================================================

/**
 * GET /api/analytics/engagement/:userId
 * Returns engagement trends for the last 20 sessions.
 */
app.get('/api/analytics/engagement/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const trends = await db.getEngagementTrends(userId);
        return res.json({ success: true, trends });
    } catch (err) {
        console.error("Failed to fetch engagement trends:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * GET /api/analytics/interests/:userId
 * Returns child interest topics ordered by session count.
 */
app.get('/api/analytics/interests/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const interests = await db.getChildInterests(userId);
        return res.json({ success: true, interests });
    } catch (err) {
        console.error("Failed to fetch interests:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * GET /api/analytics/thinking/:userId
 * Returns thinking pattern trends across sessions.
 */
app.get('/api/analytics/thinking/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const patterns = await db.getThinkingPatterns(userId);
        return res.json({ success: true, patterns });
    } catch (err) {
        console.error("Failed to fetch thinking patterns:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * GET /api/analytics/behavior/:userId
 * Returns aggregated behavioral summary.
 */
app.get('/api/analytics/behavior/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const summary = await db.getBehaviorSummary(userId);
        return res.json({ success: true, summary });
    } catch (err) {
        console.error("Failed to fetch behavior summary:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * GET /api/analytics/safety/:userId
 * Returns sessions with non-empty safety alerts.
 */
app.get('/api/analytics/safety/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const alerts = await db.getSafetyAlerts(userId);
        return res.json({ success: true, alerts });
    } catch (err) {
        console.error("Failed to fetch safety alerts:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

// =============================================================================
// CHILD PROFILE API ENDPOINTS
// =============================================================================

/**
 * GET /api/profiles
 * List all child profiles.
 */
app.get('/api/profiles', async (req, res) => {
    try {
        const profiles = await db.getChildProfiles();
        return res.json({ success: true, profiles });
    } catch (err) {
        console.error("Failed to fetch profiles:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * POST /api/profiles
 * Create a new child profile.
 * Body: { display_name, age?, avatar_color?, preferences? }
 */
app.post('/api/profiles', async (req, res) => {
    try {
        const { display_name, age, avatar_color, preferences } = req.body;
        if (!display_name) {
            return res.status(400).json({ error: "display_name is required" });
        }
        // Generate a URL-safe user_id from the display name
        const userId = display_name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + Date.now().toString(36);
        
        // Default to empty JSON if no preferences provided
        const prefsStr = preferences ? JSON.stringify(preferences) : '{}';

        await db.createChildProfile(userId, display_name, age || null, avatar_color || '#d946ef', prefsStr);
        return res.json({ success: true, user_id: userId });
    } catch (err) {
        console.error("Failed to create profile:", err);
        return res.status(500).json({ error: String(err) });
    }
});

/**
 * GET /api/profiles/:userId
 * Get a single child profile.
 */
app.get('/api/profiles/:userId', async (req, res) => {
    try {
        const profile = await db.getChildProfile(req.params.userId);
        if (!profile) return res.status(404).json({ error: "Profile not found" });
        return res.json({ success: true, profile });
    } catch (err) {
        console.error("Failed to fetch profile:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * PUT /api/profiles/:userId
 * Update a child profile.
 * Body: { display_name?, age?, avatar_color?, preferences? }
 * preferences: { allowed: string[], blocked: string[] }
 */
app.put('/api/profiles/:userId', async (req, res) => {
    try {
        const { display_name, age, avatar_color, preferences } = req.body;
        await db.updateChildProfile(req.params.userId, { display_name, age, avatar_color, preferences });
        return res.json({ success: true });
    } catch (err) {
        console.error("Failed to update profile:", err);
        return res.status(500).json({ error: String(err) });
    }
});

/**
 * DELETE /api/profiles/:userId
 * Delete a child profile and all associated data.
 */
app.delete('/api/profiles/:userId', async (req, res) => {
    try {
        await db.deleteChildProfile(req.params.userId);
        return res.json({ success: true });
    } catch (err) {
        console.error("Failed to delete profile:", err);
        return res.status(500).json({ error: String(err) });
    }
});

// =============================================================================
// RECOMMENDATIONS API ENDPOINTS
// =============================================================================

/**
 * POST /api/recommendations/:userId/generate
 * Generate content recommendations using Gemini based on child's interests and patterns.
 */
app.post('/api/recommendations/:userId/generate', async (req, res) => {
    try {
        const userId = req.params.userId;

        // Gather child data for Gemini
        const [interests, memories, behavior, profile] = await Promise.all([
            db.getChildInterests(userId),
            db.getAllMemoriesByUser(userId),
            db.getBehaviorSummary(userId),
            db.getChildProfile(userId)
        ]);

        if (memories.length === 0 && interests.length === 0) {
            return res.json({
                success: true,
                recommendations: [],
                message: "Not enough data yet. Have some conversations first!"
            });
        }

        const childAge = profile?.age || 'unknown';
        const childName = profile?.display_name || 'the child';
        const interestList = interests.map(i => `- ${i.topic} (${i.session_count} sessions, engagement: ${Math.round((i.avg_engagement || 0) * 100)}%)`).join('\n');
        const factList = memories.slice(0, 15).map(m => `- ${m.fact}`).join('\n');
        const explorationStyle = behavior?.predominant_exploration_style === 'deep_diver' ? 'deep diver who likes to explore topics in depth' : 'broad explorer who likes sampling many topics';

        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `You are a children's education recommendation engine. Based on the following data about a child, generate personalized learning recommendations.

CHILD INFO:
- Name: ${childName}
- Age: ${childAge}
- Exploration style: ${explorationStyle}

TOPIC INTERESTS:
${interestList || 'No topics tracked yet.'}

KNOWN FACTS ABOUT THE CHILD:
${factList || 'No facts collected yet.'}

Generate 6-8 specific, actionable recommendations across these categories:
- "course": Online courses or structured learning paths (e.g., Khan Academy Kids, Brilliant.org)
- "video": Educational YouTube channels or specific video series
- "book": Books, blogs, or reading material appropriate for the child's age
- "activity": Hands-on activities, experiments, or creative projects

Each recommendation should be specific (not generic), directly tied to the child's interests, and age-appropriate.`,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        recommendations: {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    type: { type: "STRING" },
                                    title: { type: "STRING" },
                                    description: { type: "STRING" },
                                    reason: { type: "STRING" },
                                    topic_match: { type: "STRING" }
                                },
                                required: ["type", "title", "description", "reason", "topic_match"]
                            }
                        }
                    },
                    required: ["recommendations"]
                }
            }
        });

        const result = JSON.parse(response.text);
        const recommendations = result.recommendations || [];

        // Cache in database
        if (recommendations.length > 0) {
            await db.saveRecommendations(userId, recommendations);
        }

        return res.json({ success: true, recommendations });
    } catch (err) {
        console.error("Failed to generate recommendations:", err);
        return res.status(500).json({ error: String(err) });
    }
});

/**
 * GET /api/recommendations/:userId
 * Get cached recommendations for a user.
 * Optional query param: ?type=course
 */
app.get('/api/recommendations/:userId', async (req, res) => {
    try {
        const type = req.query.type || null;
        const recommendations = await db.getRecommendations(req.params.userId, type);
        return res.json({ success: true, recommendations });
    } catch (err) {
        console.error("Failed to fetch recommendations:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

/**
 * POST /api/recommendations/:id/dismiss
 * Dismiss a recommendation.
 */
app.post('/api/recommendations/:id/dismiss', async (req, res) => {
    try {
        await db.dismissRecommendation(req.params.id);
        return res.json({ success: true });
    } catch (err) {
        console.error("Failed to dismiss recommendation:", err);
        return res.status(500).json({ error: "Database error" });
    }
});

// =============================================================================
// AGENT HANDOFF API ENDPOINTS
// =============================================================================

/**
 * POST /api/handoff-summary
 * Generate a quick conversation summary for agent handoff.
 * Used when switching between agents to preserve context.
 * Uses a fast model with a tight prompt for minimal latency.
 */
app.post('/api/handoff-summary', async (req, res) => {
    try {
        const { messages } = req.body;

        if (!messages || messages.length === 0) {
            return res.json({ success: false, summary: null });
        }

        // Format messages for summarization
        const transcript = messages
            .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
            .join('\n');

        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.5-flash', // Fast model for low latency
            contents: `Summarize this conversation between a child and an educational AI in 2-3 sentences.
Focus on: what topic the child is interested in, what they've learned, and any specific questions they asked.
Keep it conversational and brief - this summary will help a new AI agent pick up the conversation naturally.

CONVERSATION:
${transcript}

SUMMARY:`,
            config: {
                maxOutputTokens: 150 // Keep it short for fast generation
            }
        });

        const summary = response.text.trim();
        console.log(`[Handoff] Generated summary (${messages.length} msgs): "${summary.substring(0, 80)}..."`);

        return res.json({ success: true, summary });
    } catch (err) {
        console.error("Failed to generate handoff summary:", err);
        return res.json({ success: false, summary: null });
    }
});

// =============================================================================
// VERTEX AI GEMINI LIVE WEBSOCKET PROXY
// =============================================================================
// Browsers can't set Authorization headers on WebSocket connections, so Vertex AI
// tokens must be injected server-side. This proxy forwards messages transparently
// between the browser and Vertex AI's BidiGenerateContent endpoint.

const VERTEX_PROJECT = process.env.VERTEX_PROJECT;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    if (req.url === '/api/gemini-live-proxy') {
        wss.handleUpgrade(req, socket, head, (browserWs) => {
            wss.emit('connection', browserWs, req);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (browserWs) => {
    const apiKey = process.env.GEMINI_API_KEY;
    const isVertexAI = apiKey && !apiKey.startsWith('AIza') && VERTEX_PROJECT;

    let upstreamUrl;
    let upstreamHeaders = {};

    if (isVertexAI) {
        upstreamUrl = `wss://${VERTEX_LOCATION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmUtilityService.BidiGenerateContent`;
        upstreamHeaders['Authorization'] = `Bearer ${apiKey}`;
        upstreamHeaders['x-goog-user-project'] = VERTEX_PROJECT;
        console.log(`[GeminiProxy] Connecting to Vertex AI (${VERTEX_LOCATION}, project: ${VERTEX_PROJECT})`);
    } else {
        upstreamUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
        console.log('[GeminiProxy] Connecting to Google AI Studio');
    }

    const upstream = new WS(upstreamUrl, { headers: upstreamHeaders });
    upstream.binaryType = 'arraybuffer';

    upstream.on('open', () => console.log('[GeminiProxy] Upstream connected'));

    upstream.on('message', (data) => {
        if (browserWs.readyState === WS.OPEN) browserWs.send(data);
    });

    upstream.on('close', (code, reason) => {
        console.log(`[GeminiProxy] Upstream closed: ${code}`);
        if (browserWs.readyState === WS.OPEN) browserWs.close(code, reason);
    });

    upstream.on('error', (err) => {
        console.error('[GeminiProxy] Upstream error:', err.message);
        if (browserWs.readyState === WS.OPEN) browserWs.close(1011, 'Upstream error');
    });

    browserWs.on('message', (data) => {
        if (upstream.readyState === WS.OPEN) upstream.send(data);
    });

    browserWs.on('close', () => {
        if (upstream.readyState === WS.OPEN) upstream.close();
    });
});

// Start Server (use http.Server so WebSocket upgrades work)
server.listen(PORT, () => {
    console.log(`🚀 Voice Agent & Analytics Server running on http://localhost:${PORT}`);
});
