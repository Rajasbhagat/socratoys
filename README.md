# 🧸 Socratoys: The Interactive Learning Companion

Socratoys is a voice-driven, multi-agent educational platform designed for children aged 5-10. It combines state-of-the-art voice technology with advanced LLM reasoning to create a companion that nurtures curiosity, teaches new concepts, and provides a safe space for brainstorming and emotional processing.

---

## 🌟 Core Features

- **Voice-First Interface**: A fluid, interactive "orb" interface that reacts to the child's voice in real-time.
- **Multi-Agent Architecture**: 
  - **Cosmo (Router)**: The friendly greeter who shares fun facts and guides the child to the right activity.
  - **Knowledge Explorer**: An enthusiastic teacher that uses "Spiral Exploration" to dive deep into topics.
  - **Brainstorming Coach**: A gentle Socratic guide that helps children think through situations and feelings without giving direct solutions.
- **Long-Term Memory**: The system "remembers" what the child likes (e.g., dinosaurs, space) and injects this context into future conversations.
- **Engagement Analytics**: Real-time tracking of attention spans, thinking patterns, and educational progress.
- **Admin Dashboard**: A comprehensive view for parents/developers to monitor growth, edit agent prompts, and view unified child profiles.

---

## 🏗️ Architecture & Functional Flow

For a detailed technical breakdown, please refer to our **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

### The Functional Loop
1. **Connection**: The frontend establishes a persistent WebSocket connection to the **Deepgram Voice Agent API**.
2. **Greeting**: The **Router Agent** initiates the session by fetching a fun educational fact through a backend function call.
3. **Intent Recognition**: Based on the child's response, the Router identifies if they want to **learn** or **brainstorm**, then performs a "Hot Swap" to the specialized agent.
4. **Active Session**: High-fidelity audio is streamed from the microphone to Deepgram, and TTS chunks are streamed back for gapless playback using a custom ring-buffer player.
5. **Post-Session Analysis**: Once the call ends, the transcript is sent to the **Express Backend**.
6. **Gemini Processing**: **Google Gemini 2.0 Flash** analyzes the transcript to:
   - Generate a session summary and engagement score.
   - Extract "User Facts" (e.g., "Child is interested in volcanoes").
   - Identify behavioral and thinking patterns (hypothesis count, persistence, etc.).
7. **Memory Persistence**: Extracted facts are stored in **SQLite** and automatically injected into the system prompt of the next session.

---

## 🛠️ Technology Stack

| Layer | Tool / Service | Purpose |
| :--- | :--- | :--- |
| **Voice Processing** | [Deepgram Voice Agent](https://deepgram.com) | Real-time STT, Reasoning (GPT-4o/mini), and TTS |
| **Intelligence** | [Google Gemini 2.0 Flash](https://ai.google.dev/) | Post-session analytics, summarization, and memory extraction |
| **Backend** | [Node.js](https://nodejs.org/) & [Express](https://expressjs.com/) | API layer, database management, and service orchestration |
| **Database** | [SQLite](https://sqlite.org/) | Lightweight, local persistence for logs, prompts, and memory |
| **Frontend** | Vanilla JS / CSS / HTML | High-performance visual interface and WebSocket management |
| **Icons** | [Lucide React](https://lucide.dev/) | Visual elements and status indicators |

---

## 🚀 Getting Started

### Prerequisites
- Node.js (>= 18.0.0)
- [Deepgram API Key](https://console.deepgram.com/)
- [Google Gemini API Key](https://aistudio.google.com/)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Rajasbhagat/socratoys.git
   cd voice-agent-nodejs-client
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Setup environment variables:
   ```bash
   cp .env.example .env
   # Edit .env and add your API keys
   ```

## Deployment

### Google Cloud (Cloud Run)

The project is configured for one-click deployment to Google Cloud Run with SQLite persistence.

#### Prerequisites
1.  **Google Cloud SDK** installed and authenticated (`gcloud auth login`).
2.  **Project ID** set in your environment or CLI.

#### Deploying
Simply run:
```bash
npm run deploy:gcp
```

This script will:
1.  Build a Docker container from the `Dockerfile`.
2.  Create a Cloud Storage bucket (`socratoys-db-persistence`) for your database.
3.  Deploy to Cloud Run and mount the storage bucket so your data persists across restarts.

4. Run the project:
   ```bash
   npm start
   ```

5. Access the app:
   - Main App: `http://localhost:3000/index.html`
   - Admin Tab: `http://localhost:3000/admin.html`

### Automated GCP Deployment

This project includes a deployment automation script for Google Cloud Run:

```bash
npm run deploy:gcp
```

The script lives at `scripts/deploy-cloud-run.sh` and automates:
- loading secrets from `.env`
- resolving the active GCP project or `PROJECT_ID`
- deploying the app source to Cloud Run
- injecting required runtime environment variables

Optional overrides:

```bash
PROJECT_ID=socratoys REGION=europe-west1 SERVICE_NAME=socratoys npm run deploy:gcp
```

---

## 🔒 Security & Privacy

- **No Hardcoded Keys**: API keys are managed via environment variables and never exposed in the client-side source code.
- **Local Persistence**: All conversation logs and child metadata are stored locally in `analytics.db`.
- **Safety Filters**: Agents are configured with strict safety instructions to encourage talking to trusted adults for sensitive topics.

---

## 📄 License
MIT License - see [LICENSE](./LICENSE) for details.
