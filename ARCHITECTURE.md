# Socratoys Voice Agent — Architecture & Documentation

This document explains the technical architecture, core functions, limitations, and hardcoded values of the Socratoys Voice Agent application.

## 1. System Overview

The application is a voice-driven, multi-agent educational platform for children aged 5-8. It consists of:
1. **Frontend (`index.html`, `admin.html`)**: Handles microphone/speaker streams, Deepgram WebSocket connections, and UI state.
2. **Backend (`app.js`, `db.js`)**: An Express.js Node server handling SQLite database operations (analytics, child memory, agent prompts) and Gemini AI completions.
3. **Deepgram Voice Agent API**: Manages the core speech-to-text (STT), LLM reasoning (via OpenAI/Anthropic models configured within Deepgram), and text-to-speech (TTS) pipeline.
4. **Gemini API**: Used asynchronously by the backend to summarize conversations, extract facts/memories, evaluate engagement, and suggest prompt improvements.

---

## 2. Platform Components & Core Functions

### A. Frontend: `index.html` (The Voice Interface)
This file is the main client-facing interface. It connects to the Deepgram WebSocket and streams audio.

**Core Functions:**
*   `connect()`: The central function. It requests microphone access, opens a persistent WebSocket to `wss://agent.deepgram.com`, and attaches event listeners for all incoming Deepgram messages.
*   `setupMicrophone()` / `closeMicrophone()`: Manages the `MediaRecorder` API to capture 16kHz audio blobs from the user's browser, converting them to Base64 to send over the WebSocket.
*   `fetchAgentPrompts()`: Called on load. Connects to `GET /api/prompts` to pull the latest system prompts for all 3 agents (Router, Knowledge Explorer, Brainstorming Coach) from the SQLite DB.
*   `getAgentSettings(profileId)`: Generates the Deepgram connection payload. This configures the Voice Agent with the specific prompt, chosen voice, and available "Functions" (like routing). Included here is the injection of the child's *Long-Term Memory* directly into the system prompt.
*   **WebSocket Message Handlers (`switch(msg.type)`)**:
    *   `SettingsApplied`: Fired when Deepgram successfully applies an agent configuration. Used to trigger greetings.
        *   **Auto-start hack**: For the router agent, a `InjectUserMessage` with content "Hello!" is dispatched to securely kick off the prompt's instructions. Standard greetings use `InjectAgentMessage`.
    *   `AgentAudioReady`: Receives Base64 audio chunks from Deepgram's TTS and pushes them to the `AudioStreamPlayer`.
    *   `FunctionCallRequest`: Fired when the Deepgram LLM decides to hit a function we defined in its payload.
        *   If `route_to_*`: Closes the active connection and connects to the requested agent (`isHotSwap = true`).
        *   If `generate_greeting`: Makes a `POST /api/greeting` call to fetch a fun educational fact, then sends it back via `FunctionCallResponse` so the agent can naturally speak it.
    *   `ConversationText`: Captures transcripts of what the user and the agent said. Pushes these to the `conversationLog` array.
*   `saveLog()`: When the call ends, this POSTs the full `conversationLog` to the backend for storage and Gemini analysis.

### B. Audio Playback: `audio-player.js`
A custom ring-buffer audio player managing the Web Audio API. Deepgram streams TTS audio in tiny chunks; playing them immediately causes clipping.
*   `AudioStreamPlayer`: Queues chunks, decodes them to PCM audio buffers, and schedules them seamlessly using `audioContext.currentTime`. It handles sample-rate conversions effortlessly.

### C. Backend API: `app.js`
An Express.js server managing data persistence and Gemini processing.

**Core Endpoints:**
*   `POST /api/greeting`: Reaches out to the free `uselessfacts.jsph.pl` API to retrieve a random educational fact for the Router's opening statement (saving Gemini credits).
*   `POST /api/logs`: Receives the raw conversation log from the frontend upon disconnect, and saves it to SQLite (`analytics.db`).
*   `POST /api/summarize/:sessionId`: Takes a saved conversation transcript and passes it to **Gemini 2.0 Flash**. Gemini is prompted to return structured JSON containing:
    1. A short summary of the chat.
    2. An engagement score (1-10) tracking the child's attention span.
    3. Specific prompt improvement suggestions.
    4. An array of newly learned `user_facts` (e.g., "Child likes dinosaurs").
*   `GET /api/memory/:userId`: Returns the accumulated, deduplicated child memories (long-term context) to inject into `index.html` agent configurations.
*   `GET /api/prompts` & `POST /api/prompts/:agentId`: Endpoints to fetch and update the system prompts directly from the database.

### D. Database operations: `db.js`
Creates and manages the embedded SQLite database (`analytics.db`). Uses `sqlite3` driver.
*   **Tables:**
    *   `sessions`: Stores raw conversation transcripts.
    *   `sessions_meta`: Stores the Gemini-processed metadata (engagement, summaries, suggestions).
    *   `user_memory`: Stores longitudinal facts learned about the child across all sessions.
    *   `agent_prompts`: Stores the active instructional system prompts for the agents.

### E. Analytics Dashboard: `admin.html`
A React/Tailwind/Recharts internal dashboard for viewing conversation logs, tracking engagement metrics over time, viewing the child's unified profile (Persona/Memory UI), and directly editing Agent Prompts.

---

## 3. Current Limitations

1. **Authentication/User Management:** There is NO authentication. User sessions and logins do not exist.
2. **Database Concurrency:** SQLite is file-based. As traffic scales, multiple simultaneous writes (e.g., a burst of `POST /api/logs`) will result in `SQLITE_BUSY` locks and crashes. PostgreSQL would be required for production.
3. **Deepgram Disconnects & Latency:** During a "hot swap" from Router -> Knowledge/Brainstorm agent, the WebSocket is explicitly closed and reopened. This takes ~1-3 seconds.
4. **Rate Limits (Gemini Free Tier):** The `gemini-2.0-flash` key currently operates on the Google AI Studio free tier, capped at 15 Requests Per Minute (RPM) and 1,500 Requests Per Day. Burst traffic on the summarize endpoints will throw `RESOURCE_EXHAUSTED` (429) errors.
5. **Session Management:** If a child closes the browser window directly without clicking "End Call", the `saveLog()` function never fires, and that conversation transcript is permanently lost.
6. **No Vector Database:** Child facts (`user_memory`) are simply stored as strings in SQLite. As the child grows, passing hundreds of facts into the prompt will blow up the Deepgram context window. This requires integration to a vector store (e.g. Pinecone/Chroma) and semantic chunking to inject only *relevant* context to the immediate conversation topic.

---

## 4. Hardcoded Values & Technical Debt

To finalize testing, several variables were hardcoded. These MUST be parameterized before production:

1. **User ID:**
   *   *Where*: `index.html` (lines 804, 1076), `admin.html` (lines 100, 484), `app.js` (line 233).
   *   *Value*: `'kid_1'`
   *   *Why*: Simulates a logged-in user to retrieve memories and route analytics.
   *   *Fix*: Needs to be tied to a standard JWT / OAuth flow state.

2. **Agent Profiles / Routing IDs:**
   *   *Where*: Throughout `index.html` `switch` statements, config arrays, and `patch_router.mjs`.
   *   *Value*: `'router'`, `'knowledge'`, `'brainstorm'`
   *   *Why*: Hardcoded switch routing logic limits dynamic agent creation.
   *   *Fix*: Build an Agent Registry array pulled from the database, and dynamically inject functions based on the registry, rather than static `if/else` checks.

3. **Admin Dashboard Analytics User Filter:**
   *   *Where*: `admin.html` -> Memory fetching logic.
   *   *Value*: Hardcoded user `'kid_1'` for extracting child strength/personas.
   *   *Fix*: The admin panel needs a dropdown to select *which* child's profile to inspect.

4. **Greeting API Fallback:**
   *   *Where*: `app.js` (line 241)
   *   *Value*: `Did you know that octopuses actually have three hearts...`
   *   *Why*: If the free `uselessfacts.jsph.pl` API goes down, the connection hangs.
   *   *Fix*: Fallback array of 100+ local string facts.

5. **Deepgram Configs:**
   *   *Where*: `index.html` (`CONFIG` object at line 583)
   *   *Value*:
       *   `provider: 'openai'` / `model: 'gpt-4o-mini'`
   *   *Why*: Hardcoded into the client schema. If we want to test Anthropic (Claude 3.5 Sonnet), we have to manually edit the frontend HTML bundle.
   *   *Fix*: Provide this payload dynamically via an Express backend endpoint.
