import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Database connection
const dbPath = path.resolve(__dirname, 'analytics.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err);
    } else {
        console.log('Connected to the local SQLite database at:', dbPath);

        // Create the conversations table if it doesn't exist
        db.run(`CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error("Error creating conversations table", err);
            }
        });

        // Create the metadata table for Gemini Summarizations
        db.run(`CREATE TABLE IF NOT EXISTS sessions_meta (
            session_id TEXT PRIMARY KEY,
            title TEXT,
            topic TEXT,
            summary TEXT,
            engagement_score INTEGER,
            prompt_improvement_suggestion TEXT,
            user_facts TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error("Error creating sessions_meta table", err);
            } else {
                // If the table already existed from V1, attempt to inject the new columns gracefully
                db.run("ALTER TABLE sessions_meta ADD COLUMN engagement_score INTEGER", () => { });
                db.run("ALTER TABLE sessions_meta ADD COLUMN prompt_improvement_suggestion TEXT", () => { });
                db.run("ALTER TABLE sessions_meta ADD COLUMN user_facts TEXT", () => { });
            }
        });

        // Create the user memory table for Long-Term Context
        db.run(`CREATE TABLE IF NOT EXISTS user_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            fact TEXT NOT NULL,
            confidence FLOAT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, fact)
        )`, (err) => {
            if (err) {
                console.error("Error creating user_memory table", err);
            }
        });

        // Create the agent prompts table for continuous improvement
        db.run(`CREATE TABLE IF NOT EXISTS agent_prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            prompt_text TEXT NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT 0,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error("Error creating agent_prompts table", err);
            } else {
                seedDefaultPrompts();
            }
        });
    }
});

function seedDefaultPrompts() {
    db.get('SELECT COUNT(*) as count FROM agent_prompts', (err, row) => {
        if (!err && row.count === 0) {
            console.log("Seeding default agent prompts from markdown files...");
            const basePath = path.resolve(__dirname, 'Prompts/Agent 1: Cosmo – Router /Agent 1: Cosmo – Router');

            const fileMap = {
                'router': 'cosmo_router.md',
                'space': 'professor_orbit.md',
                'history': 'drdino.md',
                'science': 'beaker.md'
            };

            for (const [agentId, fileName] of Object.entries(fileMap)) {
                try {
                    const fullPath = path.join(basePath, fileName);
                    if (fs.existsSync(fullPath)) {
                        const promptText = fs.readFileSync(fullPath, 'utf8');
                        const stmt = db.prepare('INSERT INTO agent_prompts (agent_id, version, prompt_text, is_active) VALUES (?, ?, ?, ?)');
                        stmt.run([agentId, 1, promptText, 1]);
                        stmt.finalize();
                    }
                } catch (e) {
                    console.error(`Failed to seed ${agentId} prompt from ${fileName}`, e);
                }
            }
        }
    });
}

// Helper: Save a new message record
function saveMessage(sessionId, role, content) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare('INSERT INTO conversations (session_id, role, content) VALUES (?, ?, ?)');
        stmt.run([sessionId, role, content], function (err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
        stmt.finalize();
    });
}

// Helper: Get all conversation groups (for the Dashboard overview)
function getSessions() {
    return new Promise((resolve, reject) => {
        // Group by session_id, count messages, and join with any Gemini Session Meta
        const query = `
            SELECT 
                c.session_id,
                        COUNT(c.id) as message_count,
                        MAX(c.timestamp) as last_activity,
                        MIN(c.timestamp) as started_at,
                        m.title,
                        m.topic,
                        m.summary,
                        m.engagement_score,
                        m.prompt_improvement_suggestion,
                        m.user_facts
            FROM conversations c
            LEFT JOIN sessions_meta m ON c.session_id = m.session_id
            GROUP BY c.session_id
            ORDER BY last_activity DESC
                        `;
        db.all(query, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Helper: Get full transcript for a specific session
function getMessagesBySession(sessionId) {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT id, role, content, timestamp
            FROM conversations
            WHERE session_id = ?
                        ORDER BY timestamp ASC
                        `;
        db.all(query, [sessionId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Helper: Save Gemini Metadata
function saveSessionMeta(sessionId, title, topic, summary, engagementScore = null, promptImprovementSuggestion = null, userFacts = null) {
    return new Promise((resolve, reject) => {
        const userFactsJson = userFacts ? JSON.stringify(userFacts) : null;
        const stmt = db.prepare(`
            INSERT INTO sessions_meta(session_id, title, topic, summary, engagement_score, prompt_improvement_suggestion, user_facts) 
            VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET 
                title = excluded.title,
                        topic = excluded.topic,
                        summary = excluded.summary,
                        engagement_score = excluded.engagement_score,
                        prompt_improvement_suggestion = excluded.prompt_improvement_suggestion,
                        user_facts = excluded.user_facts,
                        updated_at = CURRENT_TIMESTAMP
                            `);
        stmt.run([sessionId, title, topic, summary, engagementScore, promptImprovementSuggestion, userFactsJson], function (err) {
            if (err) reject(err);
            else resolve(true);
        });
        stmt.finalize();
    });
}

// Helper: Save a new long-term memory fact (deduplicates by fact text)
function saveMemory(userId, fact, confidence) {
    return new Promise((resolve, reject) => {
        // INSERT OR IGNORE avoids duplicate facts for the same user
        const stmt = db.prepare('INSERT OR IGNORE INTO user_memory (user_id, fact, confidence) VALUES (?, ?, ?)');
        stmt.run([userId, fact, confidence], function (err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
        stmt.finalize();
    });
}

// Helper: Get recent memories for a user
function getMemories(userId) {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT fact
            FROM user_memory
            WHERE user_id = ?
                        ORDER BY created_at DESC
            LIMIT 10
                        `;
        db.all(query, [userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows.map(r => r.fact).join(' ')); // returns a flat string sentence of all facts
        });
    });
}

// Helper: Get active prompt versions
function getActivePrompts() {
    return new Promise((resolve, reject) => {
        const query = 'SELECT agent_id, prompt_text, version FROM agent_prompts WHERE is_active = 1';
        db.all(query, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Helper: Update a prompt and mark it active
function updateAgentPrompt(agentId, promptText) {
    return new Promise((resolve, reject) => {
        // Step 1: Disable old active prompt
        db.run('UPDATE agent_prompts SET is_active = 0 WHERE agent_id = ?', [agentId], (err) => {
            if (err) return reject(err);

            // Step 2: Get max version
            db.get('SELECT MAX(version) as max_v FROM agent_prompts WHERE agent_id = ?', [agentId], (err, row) => {
                const nextV = (row && row.max_v) ? row.max_v + 1 : 1;

                // Step 3: Insert new prompt as active
                const stmt = db.prepare('INSERT INTO agent_prompts (agent_id, version, prompt_text, is_active) VALUES (?, ?, ?, 1)');
                stmt.run([agentId, nextV, promptText], function (err) {
                    if (err) reject(err);
                    else resolve({ agentId, version: nextV, id: this.lastID });
                });
                stmt.finalize();
            });
        });
    });
}

// Helper: Fetch suggestions for Admin panel
function getPromptSuggestions() {
    return new Promise((resolve, reject) => {
        const query = 'SELECT prompt_improvement_suggestion, topic, engagement_score, updated_at as created_at FROM sessions_meta WHERE prompt_improvement_suggestion IS NOT NULL ORDER BY updated_at DESC LIMIT 50';
        db.all(query, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Helper: Get all raw memories for a user (for profile view)
function getAllMemoriesByUser(userId) {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT id, fact, confidence, created_at
            FROM user_memory
            WHERE user_id = ?
            ORDER BY confidence DESC, created_at DESC
        `;
        db.all(query, [userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Helper: expose raw db for direct queries (e.g. delete by id list)
function rawDB() { return db; }

export {
    saveMessage,
    getSessions,
    getMessagesBySession,
    saveSessionMeta,
    saveMemory,
    getMemories,
    getAllMemoriesByUser,
    rawDB,
    getActivePrompts,
    updateAgentPrompt,
    getPromptSuggestions
};
