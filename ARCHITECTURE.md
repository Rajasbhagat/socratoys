# Socratoys Voice Agent — Architecture

## High-Level System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          USER'S BROWSER                             │
│                                                                     │
│  ┌─────────────┐    ┌──────────────────────────────────────────┐   │
│  │ Microphone  │───▶│           index.html (Frontend)          │   │
│  │  (Web API)  │    │                                          │   │
│  └─────────────┘    │  • Agent UI (avatar, transcript panel)   │   │
│                     │  • Audio capture & playback              │   │
│  ┌─────────────┐    │  • WebSocket client (gemini-adapter.js   │   │
│  │   Speaker   │◀───│    OR deepgram-adapter.js)               │   │
│  │  (Web API)  │    │  • Agent routing logic                   │   │
│  └─────────────┘    │  • Long-term memory injection            │   │
│                     └──────────────┬───────────────────────────┘   │
│                                    │  HTTP (REST)                   │
└────────────────────────────────────┼───────────────────────────────┘
                                     │
                          ┌──────────▼──────────┐
                          │   Node.js / Express  │
                          │      (app.js :3000)  │
                          │                      │
                          │  GET  /api/config    │◀── returns API key +
                          │  POST /api/greeting  │    voice provider to browser
                          │  POST /api/handoff-  │
                          │       summary        │
                          │  GET  /api/memory/   │
                          │       :userId        │
                          │  POST /api/session-  │
                          │       start          │
                          │  POST /api/logs      │
                          │  GET  /api/profiles  │
                          │  POST /api/convs/    │
                          │       :id/summarize  │
                          │  + more (see §3)     │
                          │  Static file serve   │
                          └──────┬────────┬──────┘
                                 │        │
               ┌─────────────────┘        └──────────────────┐
               │                                             │
    ┌──────────▼──────────┐                      ┌──────────▼──────────┐
    │  Voice APIs (WSS)   │                      │    SQLite Database   │
    │                     │                      │    (analytics.db)    │
    │  [Active]           │                      │                      │
    │  Gemini Live API    │                      │  • conversations     │
    │  generativelanguage │                      │  • sessions_meta     │
    │  .googleapis.com    │                      │  • user_memory       │
    │  Model: gemini-2.5- │                      │  • session_analytics │
    │  flash-native-      │                      │  • child_interests   │
    │  audio-latest       │                      │  • child_profiles    │
    │                     │                      │  • recommendations   │
    │  [Configured]       │                      │  • agent_prompts     │
    │  Deepgram API       │                      └──────────────────────┘
    │  api.deepgram.com   │
    │  (switchable via    │                      ┌──────────────────────┐
    │  VOICE_PROVIDER env)│                      │  Gemini REST API     │
    └─────────────────────┘                      │  (gemini-2.5-flash)  │
                                                 │                      │
              ▲                                  │  • /api/handoff-     │
              │  WebSocket (WSS)                 │    summary           │
              │  opened directly from            │  • post-session      │
              │  browser using key               │    analysis          │
              │  from /api/config                │  • fact extraction   │
                                                 │  • profile analysis  │
                                                 │  • prompt auto-tune  │
                                                 │  • recommendations   │
                                                 └──────────────────────┘

                                                 ┌──────────────────────┐
                                                 │  Public Facts API    │
                                                 │  uselessfacts.jsph.pl│
                                                 │                      │
                                                 │  • random fun facts  │
                                                 │    for greeting      │
                                                 └──────────────────────┘
```

**Key data flow**: The browser fetches `/api/config` to get the active voice provider and API key, then opens a **direct WebSocket** to Gemini Live (or Deepgram) — audio never passes through the Node.js server. All AI inference is done by Gemini only — there is no Anthropic/Claude dependency.

---

## Gemini Live WebSocket Message Flow

```
Browser (gemini-adapter.js)              Gemini Live API
         │                                     │
         │──── WSS Connect ──────────────────▶│
         │     (key in URL query param)        │
         │                                     │
         │──── setup message (JSON) ─────────▶│
         │     {                               │
         │       setup: {                      │
         │         model: "models/gemini-2.5-  │
         │           flash-native-audio-latest"│
         │         systemInstruction,          │
         │         tools (function schemas),   │
         │         generationConfig: {         │
         │           responseModalities:['AUDIO│
         │           speechConfig: { voice },  │
         │           thinkingConfig: {         │
         │             thinkingBudget: 0 }     │
         │         },                          │
         │         inputAudioTranscription: {},│
         │         outputAudioTranscription: {}│
         │       }                             │
         │     }                               │
         │                                     │
         │◀─── setupComplete (binary frame) ───│  ← decoded as UTF-8 JSON
         │     {"setupComplete":{}}            │    (NOT a text frame — critical!)
         │                                     │
         │──── realtimeInput (PCM audio) ────▶│  ← 16kHz, 16-bit, mono
         │     (continuous binary frames)      │
         │                                     │
         │◀─── serverContent ─────────────────│
         │     outputTranscription.text chunks │  ← accumulated into buffer
         │     modelTurn.parts[].inlineData    │  ← audio bytes played back
         │                                     │
         │◀─── turnComplete ───────────────────│  ← emit full agent transcript
         │                                     │
         │◀─── inputTranscription.text chunks ─│  ← user speech, direct concat
         │                                     │
         │◀─── interrupted ────────────────────│  ← user started speaking
         │                                     │
         │──── toolResponse (JSON) ──────────▶│  ← after agent calls a function
         │                                     │
         │──── close ────────────────────────▶│  ← on agent swap or page unload
```

---

## Detailed Component Architecture

### 1. Frontend (`index.html`)

The entire frontend is a single HTML file with embedded JavaScript. No build step, no bundler.

**Key responsibilities:**

| Module / Function | Purpose |
|---|---|
| `loadVoiceProvider()` | Calls `GET /api/config`, dynamically imports the correct adapter (`gemini-adapter.js` or `deepgram-adapter.js`) with a cache-bust param `?v=SERVER_START_TIME` |
| `connect()` | Opens voice WebSocket, injects system prompt + tools, starts audio capture |
| `getAgentSettings(profileId)` | Builds system prompt + tools payload for each agent persona |
| `handleAgentHandoff(target)` | Hot-swaps active WebSocket to a new agent without interrupting mic |
| `summarizeConversationForHandoff()` | Calls `POST /api/handoff-summary` → Gemini 2.5 Flash 2–3 sentence summary |
| `fetchLongTermMemory(userId)` | Calls `GET /api/memory/:userId` for persistent user facts |
| `routeToAgent(name)` | Tool handler called by the router agent; triggers preload + handoff |
| `generate_greeting` tool handler | Returns pre-fetched result from `POST /api/greeting` |
| Audio capture | `AudioContext` (16kHz) → `ScriptProcessorNode` → float32 → PCM16 → WebSocket |
| Audio playback | base64 PCM from Gemini → `AudioBufferSourceNode` (24kHz) → Speaker |
| Transcript panel | Renders per-turn bubbles; buffered from complete turns, not per chunk |

**Agent personas (defined as `AGENT_PROFILES` in frontend):**

| Profile key | Agent name | Voice | Role |
|---|---|---|---|
| `router` | **Cosmo** | Aoede | Friendly greeter — welcomes child, identifies intent, routes |
| `knowledge` | **Nova** | Kore | Knowledge Explorer — teaches any topic via spiral exploration |
| `brainstorm` | **Sage** | Charon | Socratic coach — helps children think through problems/feelings |

All three agents map to the same Gemini model (`gemini-2.5-flash-native-audio-latest`) — the profile's `model` field (`gpt-4o-mini`/`gpt-4o`) is a legacy label that `gemini-adapter.js` remaps via `MODEL_MAP`.

**Handoff sequence (optimized):**

```
routeToAgent() fires (router calls route_to_knowledge / route_to_brainstorm)
      │
      ├──▶ window.handoffPreload = Promise.all([
      │         summarizeConversationForHandoff(),   ← POST /api/handoff-summary (parallel)
      │         fetchLongTermMemory(userId)          ← GET /api/memory/:userId (parallel)
      │    ])
      │
      ├──▶ drain remaining audio (50ms buffer)
      │
      └──▶ handleAgentHandoff()
                │
                ├──▶ await window.handoffPreload  ← already in-flight, often resolved
                ├──▶ disconnect old adapter (close WebSocket)
                ├──▶ build new system prompt with handoff context + memory
                └──▶ connect new adapter (new WebSocket to Gemini)
```

---

### 2. Voice Provider Layer (`voice-providers/`)

The frontend uses a **pluggable adapter pattern**. Two adapters exist, selected at runtime via `VOICE_PROVIDER` in `.env`:

| Adapter | When active | WebSocket target |
|---|---|---|
| `gemini-adapter.js` | `VOICE_PROVIDER=gemini` (current) | `wss://generativelanguage.googleapis.com/ws/...?key=API_KEY` |
| `deepgram-adapter.js` | `VOICE_PROVIDER=deepgram` | `wss://agent.deepgram.com/...` |

Both implement the same `VoiceProvider` interface (`provider-interface.js`), emitting identical events (`audio`, `transcript`, `function-call`, `agent-audio-done`, etc.) so the frontend is agnostic to which is active.

**GeminiAdapter key design decisions:**

**Binary frame handling** — Gemini sends control messages (`setupComplete`) as binary WebSocket frames, not text. The adapter decodes every binary frame as UTF-8 first; if it parses as JSON it's a control message; otherwise it's raw audio.

```
onmessage(event):
  if ArrayBuffer:
    decode as UTF-8 → try JSON.parse
      success → handle as control message
      fail    → emit('audio', data)   ← raw PCM for playback
  else (text):
    JSON.parse(event.data) → handle control message
```

**Transcript buffering** — Gemini streams transcription in sub-word increments. The adapter accumulates and emits one complete string per turn:
- `outputTranscription.text` chunks → `_outputTranscriptBuffer` → emitted on `turnComplete`
- `inputTranscription.text` chunks → `_inputTranscriptBuffer` → flushed when agent starts generating (or after 2s debounce), normalized with `replace(/\s+/g, ' ')`

**Thinking token suppression** — `generationConfig.thinkingConfig.thinkingBudget: 0` prevents Gemini 2.5 Flash from leaking chain-of-thought into transcripts.

**Setup timeout** — 10-second timeout rejects the connection promise if `setupComplete` is not received.

**WebSocket URL routing** — API keys (`AQ...` or `AIzaSy...`) connect directly to `generativelanguage.googleapis.com`. OAuth tokens (`ya29...`) are proxied through `/api/gemini-live-proxy` (browsers can't set `Authorization` headers on WebSocket connections).

---

### 3. Backend Server (`app.js`)

Express.js server (port 3000) serving static files and REST endpoints.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/config` | GET | Returns `VOICE_PROVIDER`, the active API key, and `_v` (server start time for cache-busting) |
| `/api/session-start` | POST | Creates a new session record in SQLite |
| `/api/logs` | POST | Saves a transcript turn to the `conversations` table |
| `/api/conversations/:userId` | GET | List past sessions for a user |
| `/api/sessions/:sessionId` | GET | Fetch full session detail |
| `/api/conversations/:sessionId/summarize` | POST | Post-session Gemini analysis: title, topic, `user_facts`, engagement score, prompt suggestions |
| `/api/memory/:userId` | GET | Fetch long-term memory facts for prompt injection |
| `/api/handoff-summary` | POST | Real-time handoff: Gemini 2.5 Flash summarises current convo in 2–3 sentences |
| `/api/greeting` | POST | Returns random fun fact (from public API) + optional interest hook — **no AI inference** |
| `/api/profiles` | GET / POST | List or create child profiles |
| `/api/profiles/:userId` | GET / PUT / DELETE | Single profile operations |
| `/api/prompts` | GET | Fetch agent prompts (global or per-user override) |
| `/api/prompts/:agentId` | POST | Create/update a global prompt |
| `/api/prompts/:userId/:agentId` | POST / DELETE | Upsert or delete per-child prompt override |
| `/api/prompts/:userId/:agentId/auto-tune` | POST | Gemini 2.5 Flash rewrites a prompt personalised for the child |
| `/api/profile/:userId` | POST | Gemini 2.5 Flash generates a learning profile narrative from memory facts |
| `/api/profile/:userId/deduplicate` | POST | Jaccard-deduplicates `user_memory` facts |
| `/api/agent-stats/:userId/:agentType` | GET | Engagement stats per agent |
| `/api/analytics/engagement/:userId` | GET | Engagement trend data |
| `/api/analytics/interests/:userId` | GET | Interest breakdown |
| `/api/analytics/thinking/:userId` | GET | Curiosity/thinking analytics |
| `/api/analytics/behavior/:userId` | GET | Behavior pattern analytics |
| `/api/analytics/safety/:userId` | GET | Safety event log |
| `/api/recommendations/:userId/generate` | POST | Gemini 2.5 Flash generates personalised learning recommendations |
| `/api/recommendations/:userId` | GET | Fetch cached recommendations |
| `/api/recommendations/:id/dismiss` | POST | Dismiss a recommendation |
| `/api/suggestions` | GET | Fetch prompt improvement suggestions |
| `/api/memory-all/:userId` | GET | Fetch full memory rows with confidence scores (Child Profile tab) |

**Environment variables (`.env`):**

```
GEMINI_API_KEY=AQ.Ab8...        ← Used for both Gemini Live WebSocket and REST
VOICE_PROVIDER=gemini           ← Set to 'deepgram' to switch provider
DEEPGRAM_API_KEY=78c4d5...      ← Used when VOICE_PROVIDER=deepgram
VERTEX_PROJECT=socratoys        ← Vertex AI project (for OAuth-based deployments)
VERTEX_LOCATION=us-central1
PROJECT_ID=socratoys
PORT=3000
```

> There is no Anthropic / Claude API key — all AI inference is Gemini only.

---

### 4. Database (`analytics.db` — SQLite)

Local SQLite database managed via the `better-sqlite3` library, initialized in `db.js`.

**Schema (8 tables):**

```sql
-- Raw chat transcripts (one row per turn)
CREATE TABLE conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,       -- 'user' | 'assistant'
    content    TEXT NOT NULL,
    user_id    TEXT,
    timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Gemini post-session AI analysis results
CREATE TABLE sessions_meta (
    session_id               TEXT PRIMARY KEY,
    title                    TEXT,
    topic                    TEXT,
    summary                  TEXT,
    engagement_score         INTEGER,
    user_facts               TEXT,   -- JSON array of extracted facts
    prompt_improvement_suggestion TEXT,
    ...
);

-- Long-term memory facts per child
CREATE TABLE user_memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    fact       TEXT NOT NULL,
    confidence FLOAT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, fact)
);

-- Expanded per-session learning analytics
CREATE TABLE session_analytics (
    session_id    TEXT PRIMARY KEY,
    user_id       TEXT,
    agent_type    TEXT,
    turn_count    INTEGER,
    safety_alerts TEXT,
    computed_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    ...
);

-- Tracks topic interest frequency per child
CREATE TABLE child_interests (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            TEXT NOT NULL,
    topic              TEXT NOT NULL,
    session_count      INTEGER DEFAULT 1,
    total_time_seconds INTEGER DEFAULT 0,
    last_explored      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, topic)
);

-- Child profiles (name, age, avatar, parent topic preferences)
CREATE TABLE child_profiles (
    user_id      TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    age          INTEGER,
    avatar_color TEXT DEFAULT '#d946ef',
    preferences  TEXT    -- JSON blob: { allowed: [...], blocked: [...] }
);

-- Cached Gemini-generated learning recommendations
CREATE TABLE recommendations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_dismissed BOOLEAN DEFAULT 0
);

-- Version-controlled system prompts per agent (supports per-user overrides)
CREATE TABLE agent_prompts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    version     INTEGER NOT NULL,
    prompt_text TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT 0,
    ...
);
```

**Memory deduplication** — When `user_facts` are extracted from a session, Jaccard word-overlap similarity (`threshold = 0.55`) is computed against all existing `user_memory` rows for that user. Duplicates are deleted before inserting new facts to prevent stale or redundant entries.

---

### 5. Audio Pipeline

```
Microphone
    │
    ▼
getUserMedia({ audio: true })
    │
    ▼
AudioContext (sampleRate: 16000)
    │
    ▼
ScriptProcessorNode (bufferSize: 4096)
    │  onaudioprocess callback
    ▼
Float32Array samples
    │  convert: Math.max(-1, Math.min(1, s)) * 32767 → Int16
    ▼
PCM-16 binary frames  (16kHz, mono)
    │
    ▼
WebSocket.send(ArrayBuffer) ──────▶ Gemini Live API
                                          │
                                          │ serverContent.modelTurn
                                          │ .parts[].inlineData (base64 PCM, 24kHz)
                                          ▼
                                   atob() → Uint8Array
                                          │
                                          ▼
                                   AudioContext.decodeAudioData
                                          │
                                          ▼
                                   AudioBufferSourceNode.start(scheduledTime)
                                          │
                                          ▼
                                       Speaker
```

Playback chunks are scheduled sequentially by tracking a `nextPlayTime` cursor. Each new chunk starts at `max(currentTime, nextPlayTime)`, preventing gaps and overlaps between audio fragments.

---

### 6. Memory System

Long-term memory flows in two directions:

**Write path (triggered after each session ends):**
```
User ends session
    │
    ▼
POST /api/conversations/:sessionId/summarize
(called from admin dashboard or session-end hook)
    │
    ▼
Gemini 2.5 Flash analyzes full transcript:
  → title, topic, summary
  → user_facts[] — definitive facts about the child
  → engagement_score (1–10)
  → prompt_improvement_suggestion
    │
    ▼
Jaccard deduplication (threshold 0.55) against existing user_memory
    │
    ▼
INSERT high-confidence facts into user_memory
INSERT analysis into sessions_meta
```

**Read path (on session start and agent handoff):**
```
GET /api/memory/:userId
    │
    ▼
SELECT fact FROM user_memory WHERE user_id = ?
    │
    ▼
Injected into agent system prompt as:
"BACKGROUND NOTES ABOUT THIS CHILD
 (use to inform your style and empathy —
  do NOT use to decide what topic to start with)"
```

Memory informs the agent's *tone and empathy*, not the opening topic.

---

### 7. Greeting System

The `/api/greeting` endpoint assembles a personalised greeting **without any AI inference**:

```
POST /api/greeting { userId }
    │
    ├──▶ db.getChildInterests(userId)          ← parallel: recurring topics
    ├──▶ db.getChildProfile(userId)            ← parallel: blocked topic preferences
    └──▶ fetch uselessfacts.jsph.pl/random     ← parallel: random fun fact
              │
              ▼
    greeting = randomFact
              │
    if child has a recurring interest (session_count ≥ 2) AND not blocked:
        greeting += " By the way, last time we talked you were really into {topic}..."
              │
              ▼
    return { greeting }
```

This endpoint is pre-fetched in parallel with WebSocket setup (`window.prefetchedGreeting`) so Cosmo can respond instantly when Gemini calls the `generate_greeting` tool.

---

### 8. Agent Prompt Architecture

Each agent's system prompt is assembled from layers at connection time:

```
┌──────────────────────────────────────────────────────────────┐
│  0. IDENTITY GUARD (prepended by frontend, non-negotiable)   │
│     "Your name is {Cosmo/Nova/Sage}. Always introduce        │
│      yourself as {name} and ONLY as {name}."                 │
│     Companion agent names are also listed here.              │
├──────────────────────────────────────────────────────────────┤
│  1. TRANSITION STYLE (prepended by frontend)                 │
│     "Never switch abruptly. Acknowledge → Bridge → Route."   │
├──────────────────────────────────────────────────────────────┤
│  2. PERSONA (from AGENT_PROFILES or agent_prompts DB)        │
│     Role, speaking style, interaction framework, safety rules│
├──────────────────────────────────────────────────────────────┤
│  3. PARENT TOPIC PREFERENCES (injected if profile exists)    │
│     Allowed topics (parent-approved, prioritised)            │
│     Blocked topics (parent-restricted, not discussed)        │
├──────────────────────────────────────────────────────────────┤
│  4. BACKGROUND NOTES (long-term memory from user_memory)     │
│     Facts from past sessions                                 │
│     → informs empathy/style, NOT opening topic              │
├──────────────────────────────────────────────────────────────┤
│  5. HANDOFF CONTEXT (on agent swap only)                     │
│     Gemini 2.5 Flash summary of current conversation         │
│     Previous agent identity                                  │
│     → provides continuity without prescribing what to say   │
├──────────────────────────────────────────────────────────────┤
│  6. TOOLS                                                    │
│     generate_greeting   — fetch warm opener (router only)    │
│     route_to_knowledge  — hand off to Nova                   │
│     route_to_brainstorm — hand off to Sage                   │
│     route_to_router     — return to Cosmo                    │
└──────────────────────────────────────────────────────────────┘
```

Prompts are version-controlled in the `agent_prompts` table and can be overridden per-child. Auto-tuning (`/api/prompts/:userId/:agentId/auto-tune`) uses Gemini 2.5 Flash to generate a personalised variant based on the child's memory facts, interest history, and past engagement scores.

---

### 9. Session Startup Sequence (optimized)

```
User clicks "Talk to Agent"
         │
         ├──▶ GET /api/config              ← get VOICE_PROVIDER + API key
         │
         ├──▶ loadVoiceProvider()          ← dynamic import of adapter (cache-busted ?v=...)
         │
         ├──▶ window.prefetchedGreeting =
         │         POST /api/greeting      ← pre-fetched in parallel
         │
         ├──▶ getUserMedia({ audio })      ← mic permission prompt
         │
         ├──▶ GET /api/memory/:userId      ← long-term memory for system prompt
         │
         ├──▶ new GeminiAdapter(config)
         │
         ├──▶ adapter.connect()
         │         │
         │         ├──▶ WebSocket open to generativelanguage.googleapis.com
         │         ├──▶ send setup message (model + system prompt + tools)
         │         └──▶ await setupComplete (binary frame, typically < 1s)
         │
         ├──▶ POST /api/session-start      ← log session to SQLite
         │
         ├──▶ start audio capture loop
         │
         └──▶ Gemini calls generate_greeting tool
                   │
                   └──▶ await window.prefetchedGreeting  ← already resolved
                             │
                             └──▶ Cosmo speaks greeting immediately
```

---

## Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Vanilla JS, single HTML file | No build step, no bundler — easy to iterate |
| Voice API (active) | Gemini Live (`BidiGenerateContent` WebSocket) | Direct browser→Gemini WSS; audio never touches Node.js server |
| Voice API (configured) | Deepgram Voice Agent WebSocket | Switchable via `VOICE_PROVIDER=deepgram` in `.env` |
| Live voice model | `gemini-2.5-flash-native-audio-latest` | All 3 agents use this; voice differs (Aoede/Kore/Charon) |
| Text AI (summaries, analysis) | `gemini-2.5-flash` via `@google/genai` REST | Used for all non-real-time inference |
| Greeting data | `uselessfacts.jsph.pl` (public API) | No AI cost; random fun fact + interest hook |
| Backend | Node.js + Express (`app.js`, port 3000) | Thin REST layer + SQLite access |
| Database | SQLite via `better-sqlite3` | Local, zero-config, 8 tables |
| Audio encoding | Web Audio API (`ScriptProcessorNode`) | PCM-16 @ 16kHz input, 24kHz output |

---

## Security Considerations

- **API key exposure** — The active API key is sent to the browser via `GET /api/config` so the browser can open the direct WebSocket. This is acceptable for development; in production, consider proxying the WebSocket through the server (`/api/gemini-live-proxy`) so the key never leaves the server.
- **System prompts hidden** — Setup payloads (containing the full system prompt) are not logged to the browser console.
- **Child-safe by design** — All agent personas have explicit safety rules; Cosmo only routes to approved agents; parent-configured blocked topics are respected everywhere.
- **Input validation** — All `/api/*` endpoints validate required fields before processing.
- **No cross-user data leakage** — All DB queries are scoped by `userId`; no endpoint returns all users' data to the frontend.
