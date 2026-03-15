# Socratoys Voice Agent — Architecture & Documentation

This document explains the technical architecture, core functions, and current state of the Socratoys Voice Agent application.

## 1. System Overview

The application is a voice-driven, multi-agent educational platform for children aged 5-10. It features **Multi-Profile Support**, allowing different children to have personalized experiences and isolated learning data.

1. **Frontend (`index.html`, `admin.html`)**: Handles microphone/speaker streams, Deepgram WebSocket connections, profile switching, and UI state.
2. **Backend (`app.js`, `db.js`)**: An Express.js Node server handling SQLite database operations (analytics, child memory, agent prompts) and Gemini AI completions.
3. **Deepgram Voice Agent API**: Manages the core speech-to-text (STT), LLM reasoning (via OpenAI/Anthropic/Gemini models), and text-to-speech (TTS) pipeline.
4. **Gemini API**: Used asynchronously by the backend (`gemini-2.5-flash`) to summarize conversations, extract facts/memories, evaluate engagement, and generate personalized content recommendations.

---

## 2. Platform Components & Core Functions

### A. Frontend: `index.html` (The Voice Interface)
Main client interface that manages voice sessions and profile context.

**Core Functions:**
*   `loadProfiles()`: Fetches available kid profiles and populates the selection dropdown.
*   `onProfileChanged()`: Updates the active `currentUserId` and persists it to `localStorage`.
*   `connect()`: Opens a persistent WebSocket to `wss://agent.deepgram.com` using the active profile's configuration.
*   `fetchAgentPrompts()`: Dynamically pulls the latest system prompts from the SQLite DB.
*   `getAgentSettings(profileId)`: Injects the active child's **Long-Term Memory** and personalized context into the Deepgram agent config.
*   **Analytics Integration**: Every transcript chunk is POSTed to `/api/logs` with the active `userId` to ensure data isolation.

### B. Backend API: `app.js`
Express server orchestrating logic and AI processing.

**Core Endpoints:**
*   `POST /api/logs`: Receives conversation logs and saves them to SQLite, tagged with the active `userId`.
*   `POST /api/summarize/:sessionId`: Uses **Gemini 2.5 Flash** to extract engagement scores, summaries, and new user facts.
*   `GET /api/conversations/:userId`: Fetches filtered session history exclusive to the requested child.
*   `GET /api/memory/:userId`: Returns accumulated facts for prompt injection.
*   `GET /api/recommendations/:userId`: Generates personalized courses/videos/books based on the child's recorded interests.

### C. Database Layer: `db.js`
Embedded SQLite database (`analytics.db`).

**Key Tables:**
*   `profiles`: Stores child names, ages, and unique user IDs.
*   `conversations`: Stores raw transcripts, now including a `user_id` column for session ownership.
*   `session_analytics`: Comprehensive behavioral metrics (turn counts, affect, reasoning).
*   `user_memory`: Longitudinal facts learned about the child.
*   `agent_prompts`: Active versioned system prompts for the AI agents.

### D. Analytics Dashboard: `admin.html`
Admin portal for tracking child development. Contains a profile switcher that filters all data (Analytics, Learning Insights, Child Profile) to the selected child.

---

## 3. Current Limitations

1. **Authentication**: While profiles are supported, there is no password-protected authentication. It is a "trust-based" selector for now.
2. **Database Concurrency**: Still uses SQLite. For production scaling, a move to PostgreSQL is recommended to avoid file locks.
3. **Vector Search (Memory)**: User memory is currently injected as a full text block. As memories grow, a Vector DB (like Pinecone) will be needed for semantic retrieval.
4. **Offline Support**: The agent requires a continuous internet connection for both Deepgram and Gemini processing.

---

## 4. Technical Debt & Future Roadmap

1. **Agent Registry**: Routing logic (Router -> Knowledge Explorer) is currently handled via a switch statement. A dynamic registry would allow for easier deployment of new agent types.
2. **JWT Integration**: Transition the profile selector to a secure JWT-based authentication flow.
3. **Fallback Greeting Library**: Implement a local fallback for the random facts API to handle potential downtime gracefully.
4. **Tool Use Expansion**: Expand agent capabilities beyond greetings to include interactive mini-games or external search (e.g., Google Search API).
