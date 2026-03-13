/**
 * Database Layer for Socratoys Voice Agent
 *
 * Manages SQLite database operations for:
 * - Conversation transcripts (conversations table)
 * - Session metadata from Gemini analysis (sessions_meta table)
 * - Long-term user memory/facts (user_memory table)
 * - Agent prompt versioning (agent_prompts table)
 *
 * @module db
 */

import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// DATABASE INITIALIZATION
// =============================================================================

const dbPath = path.resolve(__dirname, 'analytics.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err);
        return;
    }

    console.log('Connected to the local SQLite database at:', dbPath);
    initializeTables();
});

/**
 * Initialize all database tables with proper schema.
 * Handles graceful migration for existing V1 tables.
 */
function initializeTables() {
    // Table: conversations - Stores raw chat transcripts
    db.run(`CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, logTableError('conversations'));

    // Table: sessions_meta - Stores Gemini AI analysis results
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
            // Graceful migration: add new columns if upgrading from V1
            db.run("ALTER TABLE sessions_meta ADD COLUMN engagement_score INTEGER", () => {});
            db.run("ALTER TABLE sessions_meta ADD COLUMN prompt_improvement_suggestion TEXT", () => {});
            db.run("ALTER TABLE sessions_meta ADD COLUMN user_facts TEXT", () => {});
        }
    });

    // Table: user_memory - Stores long-term facts about the child
    db.run(`CREATE TABLE IF NOT EXISTS user_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        confidence FLOAT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, fact)
    )`, logTableError('user_memory'));

    // Table: session_analytics - Stores expanded Gemini analysis for learning insights
    db.run(`CREATE TABLE IF NOT EXISTS session_analytics (
        session_id TEXT PRIMARY KEY,
        user_id TEXT,
        agent_type TEXT,
        mode TEXT,
        turn_count INTEGER,
        child_turn_count INTEGER,
        avg_child_utterance_length FLOAT,
        child_question_count INTEGER,
        on_task_ratio FLOAT,
        positive_affect_count INTEGER,
        negative_affect_count INTEGER,
        reasoning_connective_count INTEGER,
        epistemic_marker_count INTEGER,
        hypothesis_count INTEGER,
        self_correction_count INTEGER,
        topics_explored TEXT,
        exploration_style TEXT,
        persistence_score FLOAT,
        help_seeking_count INTEGER,
        safety_alerts TEXT,
        computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, logTableError('session_analytics'));

    // Table: child_interests - Tracks topic interest levels per child over time
    db.run(`CREATE TABLE IF NOT EXISTS child_interests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        session_count INTEGER DEFAULT 1,
        total_time_seconds INTEGER DEFAULT 0,
        avg_engagement FLOAT,
        last_explored DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, topic)
    )`, logTableError('child_interests'));

    // Table: child_profiles - Stores child profile information
    db.run(`CREATE TABLE IF NOT EXISTS child_profiles (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        age INTEGER,
        avatar_color TEXT DEFAULT '#d946ef',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error("Error creating child_profiles table", err);
        } else {
            seedDefaultProfile();
        }
    });

    // Table: recommendations - Caches Gemini-generated content recommendations
    db.run(`CREATE TABLE IF NOT EXISTS recommendations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        reason TEXT,
        topic_match TEXT,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_dismissed BOOLEAN DEFAULT 0
    )`, logTableError('recommendations'));

    // Table: agent_prompts - Version-controlled system prompts for agents
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

/**
 * Create a table creation error logger.
 * @param {string} tableName - Name of the table for error context
 */
function logTableError(tableName) {
    return (err) => {
        if (err) console.error(`Error creating ${tableName} table`, err);
    };
}

// =============================================================================
// DATABASE SEEDING
// =============================================================================

/**
 * Seed a default child profile on first run.
 * Only seeds if the child_profiles table is empty.
 */
function seedDefaultProfile() {
    db.get('SELECT COUNT(*) as count FROM child_profiles', (err, row) => {
        if (err || row.count > 0) return;
        console.log("Seeding default child profile 'kid_1'...");
        db.run(
            'INSERT INTO child_profiles (user_id, display_name, age, avatar_color) VALUES (?, ?, ?, ?)',
            ['kid_1', 'Kid #1', null, '#d946ef']
        );
    });
}

/**
 * Seed default agent prompts from markdown files on first run.
 * Only seeds if the agent_prompts table is empty.
 */
function seedDefaultPrompts() {
    db.get('SELECT COUNT(*) as count FROM agent_prompts', (err, row) => {
        if (err || row.count > 0) return;

        console.log("Seeding default agent prompts from markdown files...");
        const basePath = path.resolve(__dirname, 'Prompts');

        // Map agent IDs to their prompt markdown files
        const agentPromptFiles = {
            'router': 'initial_chat.md',
            'knowledge': 'knowledge_explorer.md',
            'brainstorm': 'brainstorm_coach.md'
        };

        for (const [agentId, fileName] of Object.entries(agentPromptFiles)) {
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
    });
}

// =============================================================================
// CONVERSATION OPERATIONS
// =============================================================================

/**
 * Save a new conversation message to the database.
 * @param {string} sessionId - Unique session identifier
 * @param {string} role - Message role ('user' or 'assistant')
 * @param {string} content - Message content (should be markdown-stripped)
 * @returns {Promise<number>} The inserted row ID
 */
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

/**
 * Get all conversation sessions with metadata for Admin dashboard.
 * Joins with sessions_meta for Gemini analysis results.
 * @returns {Promise<Array>} Array of session objects with message counts and metadata
 */
function getSessions() {
    return new Promise((resolve, reject) => {
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

/**
 * Get the full transcript for a specific session.
 * @param {string} sessionId - Session identifier
 * @returns {Promise<Array>} Array of messages in chronological order
 */
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

// =============================================================================
// SESSION METADATA OPERATIONS
// =============================================================================

/**
 * Save or update Gemini AI analysis results for a session.
 * Uses UPSERT to handle both new and existing sessions.
 * @param {string} sessionId - Session identifier
 * @param {string} title - AI-generated session title
 * @param {string} topic - Topic classification (Science, History, Space, etc.)
 * @param {string} summary - AI-generated conversation summary
 * @param {number|null} engagementScore - Child engagement score (1-10)
 * @param {string|null} promptImprovementSuggestion - AI suggestion for prompt improvement
 * @param {Array|null} userFacts - Extracted facts about the child
 * @returns {Promise<boolean>} Success indicator
 */
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

/**
 * Get prompt improvement suggestions from past sessions.
 * @returns {Promise<Array>} Array of suggestions with topic and engagement context
 */
function getPromptSuggestions() {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT prompt_improvement_suggestion, topic, engagement_score, updated_at as created_at
            FROM sessions_meta
            WHERE prompt_improvement_suggestion IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 50
        `;
        db.all(query, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// =============================================================================
// USER MEMORY OPERATIONS
// =============================================================================

/**
 * Save a new long-term memory fact about a user.
 * Automatically deduplicates by (user_id, fact) unique constraint.
 * @param {string} userId - User identifier
 * @param {string} fact - The fact to remember (e.g., "Child loves dinosaurs")
 * @param {number} confidence - Confidence score (0-1)
 * @returns {Promise<number>} The inserted row ID (0 if duplicate)
 */
function saveMemory(userId, fact, confidence) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare('INSERT OR IGNORE INTO user_memory (user_id, fact, confidence) VALUES (?, ?, ?)');
        stmt.run([userId, fact, confidence], function (err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
        stmt.finalize();
    });
}

/**
 * Get recent memories for a user as a concatenated string.
 * Used for injecting context into agent system prompts.
 * @param {string} userId - User identifier
 * @returns {Promise<string>} Space-separated facts string
 */
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
            else resolve(rows.map(r => r.fact).join(' '));
        });
    });
}

/**
 * Get all memories for a user with full metadata.
 * Used for Child Profile tab in Admin dashboard.
 * @param {string} userId - User identifier
 * @returns {Promise<Array>} Array of memory objects with id, fact, confidence, created_at
 */
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

// =============================================================================
// AGENT PROMPT OPERATIONS
// =============================================================================

/**
 * Get all currently active agent prompts.
 * @returns {Promise<Array>} Array of active prompts with agent_id, prompt_text, version
 */
function getActivePrompts() {
    return new Promise((resolve, reject) => {
        const query = 'SELECT agent_id, prompt_text, version FROM agent_prompts WHERE is_active = 1';
        db.all(query, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

/**
 * Update an agent's system prompt with version control.
 * Deactivates the current prompt and inserts a new version as active.
 * @param {string} agentId - Agent identifier (router, knowledge, brainstorm)
 * @param {string} promptText - New system prompt content
 * @returns {Promise<Object>} Object with agentId, new version number, and row ID
 */
function updateAgentPrompt(agentId, promptText) {
    return new Promise((resolve, reject) => {
        // Step 1: Deactivate current active prompt
        db.run('UPDATE agent_prompts SET is_active = 0 WHERE agent_id = ?', [agentId], (err) => {
            if (err) return reject(err);

            // Step 2: Determine next version number
            db.get('SELECT MAX(version) as max_v FROM agent_prompts WHERE agent_id = ?', [agentId], (getErr, row) => {
                if (getErr) return reject(getErr);

                const nextVersion = (row && row.max_v) ? row.max_v + 1 : 1;

                // Step 3: Insert new prompt as active
                const stmt = db.prepare('INSERT INTO agent_prompts (agent_id, version, prompt_text, is_active) VALUES (?, ?, ?, 1)');
                stmt.run([agentId, nextVersion, promptText], function (insertErr) {
                    if (insertErr) reject(insertErr);
                    else resolve({ agentId, version: nextVersion, id: this.lastID });
                });
                stmt.finalize();
            });
        });
    });
}

// =============================================================================
// SESSION ANALYTICS OPERATIONS
// =============================================================================

/**
 * Save expanded session analytics data from Gemini analysis.
 * @param {Object} data - Analytics data object
 * @returns {Promise<boolean>} Success indicator
 */
function saveSessionAnalytics(data) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT INTO session_analytics (
                session_id, user_id, agent_type, mode, turn_count, child_turn_count,
                avg_child_utterance_length, child_question_count, on_task_ratio,
                positive_affect_count, negative_affect_count, reasoning_connective_count,
                epistemic_marker_count, hypothesis_count, self_correction_count,
                topics_explored, exploration_style, persistence_score,
                help_seeking_count, safety_alerts
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                user_id = excluded.user_id,
                agent_type = excluded.agent_type,
                mode = excluded.mode,
                turn_count = excluded.turn_count,
                child_turn_count = excluded.child_turn_count,
                avg_child_utterance_length = excluded.avg_child_utterance_length,
                child_question_count = excluded.child_question_count,
                on_task_ratio = excluded.on_task_ratio,
                positive_affect_count = excluded.positive_affect_count,
                negative_affect_count = excluded.negative_affect_count,
                reasoning_connective_count = excluded.reasoning_connective_count,
                epistemic_marker_count = excluded.epistemic_marker_count,
                hypothesis_count = excluded.hypothesis_count,
                self_correction_count = excluded.self_correction_count,
                topics_explored = excluded.topics_explored,
                exploration_style = excluded.exploration_style,
                persistence_score = excluded.persistence_score,
                help_seeking_count = excluded.help_seeking_count,
                safety_alerts = excluded.safety_alerts,
                computed_at = CURRENT_TIMESTAMP
        `);
        stmt.run([
            data.session_id,
            data.user_id || null,
            data.agent_type || null,
            data.mode || null,
            data.turn_count || null,
            data.child_turn_count || null,
            data.avg_child_utterance_length || null,
            data.child_question_count || null,
            data.on_task_ratio || null,
            data.positive_affect_count || null,
            data.negative_affect_count || null,
            data.reasoning_connective_count || null,
            data.epistemic_marker_count || null,
            data.hypothesis_count || null,
            data.self_correction_count || null,
            data.topics_explored ? JSON.stringify(data.topics_explored) : null,
            data.exploration_style || null,
            data.persistence_score || null,
            data.help_seeking_count || null,
            data.safety_alerts ? JSON.stringify(data.safety_alerts) : null
        ], function (err) {
            if (err) reject(err);
            else resolve(true);
        });
        stmt.finalize();
    });
}

/**
 * Upsert a child interest topic, incrementing session count and updating engagement.
 * @param {string} userId - User identifier
 * @param {string} topic - Topic name
 * @param {number} timeSeconds - Estimated time spent in seconds
 * @param {number} engagement - Engagement level (0-1 scale, mapped from high/medium/low)
 * @returns {Promise<boolean>} Success indicator
 */
function upsertChildInterest(userId, topic, timeSeconds, engagement) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT INTO child_interests (user_id, topic, session_count, total_time_seconds, avg_engagement, last_explored)
            VALUES (?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, topic) DO UPDATE SET
                session_count = session_count + 1,
                total_time_seconds = total_time_seconds + excluded.total_time_seconds,
                avg_engagement = (avg_engagement * session_count + excluded.avg_engagement) / (session_count + 1),
                last_explored = CURRENT_TIMESTAMP
        `);
        stmt.run([userId, topic, timeSeconds, engagement], function (err) {
            if (err) reject(err);
            else resolve(true);
        });
        stmt.finalize();
    });
}

/**
 * Get engagement trends for a user from session_analytics.
 * @param {string} userId - User identifier
 * @returns {Promise<Array>} Last 20 sessions with engagement data
 */
function getEngagementTrends(userId) {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT sa.session_id, sm.engagement_score, sa.child_turn_count,
                   sa.on_task_ratio, sa.positive_affect_count, sa.computed_at
            FROM session_analytics sa
            LEFT JOIN sessions_meta sm ON sa.session_id = sm.session_id
            WHERE sa.user_id = ?
            ORDER BY sa.computed_at DESC
            LIMIT 20
        `;
        db.all(query, [userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

/**
 * Get child interests ordered by session count.
 * @param {string} userId - User identifier
 * @returns {Promise<Array>} Array of interest objects
 */
function getChildInterests(userId) {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT topic, session_count, total_time_seconds, avg_engagement, last_explored
            FROM child_interests
            WHERE user_id = ?
            ORDER BY session_count DESC
        `;
        db.all(query, [userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

/**
 * Get thinking pattern trends for a user.
 * @param {string} userId - User identifier
 * @returns {Promise<Array>} Sessions with thinking pattern counts
 */
function getThinkingPatterns(userId) {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT session_id, reasoning_connective_count, epistemic_marker_count,
                   hypothesis_count, self_correction_count, computed_at
            FROM session_analytics
            WHERE user_id = ?
            ORDER BY computed_at DESC
        `;
        db.all(query, [userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

/**
 * Get behavioral summary for a user.
 * @param {string} userId - User identifier
 * @returns {Promise<Object>} Aggregated behavioral metrics
 */
function getBehaviorSummary(userId) {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT
                AVG(persistence_score) as avg_persistence_score,
                exploration_style,
                SUM(help_seeking_count) as total_help_seeking_count,
                AVG(child_question_count) as avg_child_question_count,
                COUNT(*) as session_count
            FROM session_analytics
            WHERE user_id = ?
        `;
        db.get(query, [userId], (err, row) => {
            if (err) reject(err);
            else {
                // Get predominant exploration style
                const styleQuery = `
                    SELECT exploration_style, COUNT(*) as cnt
                    FROM session_analytics
                    WHERE user_id = ? AND exploration_style IS NOT NULL
                    GROUP BY exploration_style
                    ORDER BY cnt DESC
                    LIMIT 1
                `;
                db.get(styleQuery, [userId], (err2, styleRow) => {
                    if (err2) reject(err2);
                    else resolve({
                        avg_persistence_score: row ? row.avg_persistence_score : null,
                        predominant_exploration_style: styleRow ? styleRow.exploration_style : null,
                        total_help_seeking_count: row ? row.total_help_seeking_count : 0,
                        avg_child_question_count: row ? row.avg_child_question_count : null,
                        session_count: row ? row.session_count : 0
                    });
                });
            }
        });
    });
}

/**
 * Get sessions with safety alerts for a user.
 * @param {string} userId - User identifier
 * @returns {Promise<Array>} Sessions with non-empty safety alerts
 */
function getSafetyAlerts(userId) {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT session_id, safety_alerts, computed_at
            FROM session_analytics
            WHERE user_id = ? AND safety_alerts IS NOT NULL AND safety_alerts != '[]'
            ORDER BY computed_at DESC
        `;
        db.all(query, [userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// =============================================================================
// CHILD PROFILE OPERATIONS
// =============================================================================

/**
 * Create a new child profile.
 * @param {string} userId - Unique user identifier
 * @param {string} displayName - Child's display name
 * @param {number|null} age - Child's age
 * @param {string} avatarColor - Hex color for avatar
 * @returns {Promise<boolean>} Success indicator
 */
function createChildProfile(userId, displayName, age = null, avatarColor = '#d946ef') {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(
            'INSERT INTO child_profiles (user_id, display_name, age, avatar_color) VALUES (?, ?, ?, ?)'
        );
        stmt.run([userId, displayName, age, avatarColor], function (err) {
            if (err) reject(err);
            else resolve(true);
        });
        stmt.finalize();
    });
}

/**
 * Get all child profiles ordered by last activity.
 * @returns {Promise<Array>} Array of profile objects
 */
function getChildProfiles() {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT * FROM child_profiles ORDER BY last_active DESC',
            [],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

/**
 * Get a single child profile.
 * @param {string} userId - User identifier
 * @returns {Promise<Object|null>} Profile object or null
 */
function getChildProfile(userId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT * FROM child_profiles WHERE user_id = ?',
            [userId],
            (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            }
        );
    });
}

/**
 * Update a child profile's fields.
 * @param {string} userId - User identifier
 * @param {Object} fields - Fields to update { display_name?, age?, avatar_color? }
 * @returns {Promise<boolean>} Success indicator
 */
function updateChildProfile(userId, fields) {
    return new Promise((resolve, reject) => {
        const setClauses = [];
        const values = [];
        if (fields.display_name !== undefined) { setClauses.push('display_name = ?'); values.push(fields.display_name); }
        if (fields.age !== undefined) { setClauses.push('age = ?'); values.push(fields.age); }
        if (fields.avatar_color !== undefined) { setClauses.push('avatar_color = ?'); values.push(fields.avatar_color); }
        if (setClauses.length === 0) return resolve(true);
        values.push(userId);
        db.run(`UPDATE child_profiles SET ${setClauses.join(', ')} WHERE user_id = ?`, values, (err) => {
            if (err) reject(err);
            else resolve(true);
        });
    });
}

/**
 * Delete a child profile and all associated data.
 * @param {string} userId - User identifier
 * @returns {Promise<boolean>} Success indicator
 */
function deleteChildProfile(userId) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('DELETE FROM user_memory WHERE user_id = ?', [userId]);
            db.run('DELETE FROM session_analytics WHERE user_id = ?', [userId]);
            db.run('DELETE FROM child_interests WHERE user_id = ?', [userId]);
            db.run('DELETE FROM recommendations WHERE user_id = ?', [userId]);
            db.run('DELETE FROM child_profiles WHERE user_id = ?', [userId], (err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    });
}

/**
 * Update last_active timestamp for a child profile.
 * @param {string} userId - User identifier
 * @returns {Promise<boolean>} Success indicator
 */
function touchProfileActivity(userId) {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE child_profiles SET last_active = CURRENT_TIMESTAMP WHERE user_id = ?',
            [userId],
            (err) => {
                if (err) reject(err);
                else resolve(true);
            }
        );
    });
}

// =============================================================================
// RECOMMENDATION OPERATIONS
// =============================================================================

/**
 * Save a batch of recommendations for a user.
 * Clears existing non-dismissed recommendations before inserting.
 * @param {string} userId - User identifier
 * @param {Array} recommendations - Array of { type, title, description, reason, topic_match }
 * @returns {Promise<boolean>} Success indicator
 */
function saveRecommendations(userId, recommendations) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // Clear previous non-dismissed recommendations
            db.run('DELETE FROM recommendations WHERE user_id = ? AND is_dismissed = 0', [userId]);

            const stmt = db.prepare(
                'INSERT INTO recommendations (user_id, type, title, description, reason, topic_match) VALUES (?, ?, ?, ?, ?, ?)'
            );
            for (const rec of recommendations) {
                stmt.run([userId, rec.type, rec.title, rec.description || null, rec.reason || null, rec.topic_match || null]);
            }
            stmt.finalize((err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    });
}

/**
 * Get recommendations for a user, optionally filtered by type.
 * Excludes dismissed recommendations.
 * @param {string} userId - User identifier
 * @param {string|null} type - Optional type filter
 * @returns {Promise<Array>} Array of recommendation objects
 */
function getRecommendations(userId, type = null) {
    return new Promise((resolve, reject) => {
        let query = 'SELECT * FROM recommendations WHERE user_id = ? AND is_dismissed = 0';
        const params = [userId];
        if (type) {
            query += ' AND type = ?';
            params.push(type);
        }
        query += ' ORDER BY generated_at DESC';
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

/**
 * Dismiss a recommendation by ID.
 * @param {number} id - Recommendation ID
 * @returns {Promise<boolean>} Success indicator
 */
function dismissRecommendation(id) {
    return new Promise((resolve, reject) => {
        db.run('UPDATE recommendations SET is_dismissed = 1 WHERE id = ?', [id], (err) => {
            if (err) reject(err);
            else resolve(true);
        });
    });
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Expose raw SQLite database connection for direct queries.
 * Use sparingly - prefer using the abstracted functions above.
 * @returns {sqlite3.Database} Raw database connection
 */
function rawDB() {
    return db;
}

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
    getPromptSuggestions,
    saveSessionAnalytics,
    upsertChildInterest,
    getEngagementTrends,
    getChildInterests,
    getThinkingPatterns,
    getBehaviorSummary,
    getSafetyAlerts,
    createChildProfile,
    getChildProfiles,
    getChildProfile,
    updateChildProfile,
    deleteChildProfile,
    touchProfileActivity,
    saveRecommendations,
    getRecommendations,
    dismissRecommendation
};
