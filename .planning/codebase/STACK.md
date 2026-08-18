# Technology Stack

**Analysis Date:** 2026-08-18

## Languages

**Primary:**
- JavaScript (ES6+) - Used across backend service files (`backend/*.js`, `backend/modules/*.js`) and frontend components/hooks (`frontend/src/**/*.js`).

**Secondary:**
- TypeScript (v5.x/implied) - Used in auxiliary backend scripts such as [`backend/get_pot.ts`](file:///Users/chacha/src/youtube-describer/backend/get_pot.ts).
- Shell Script (Bash) - Used in helper/setup scripts such as [`backend/setup_whisper_server.sh`](file:///Users/chacha/src/youtube-describer/backend/setup_whisper_server.sh) and local pipelines [`deploy-prod.sh`](file:///Users/chacha/src/youtube-describer/deploy-prod.sh) / [`deploy-test.sh`](file:///Users/chacha/src/youtube-describer/deploy-test.sh).
- Python (v3) - Used for background cookies maintenance in [`backend/bin/server-refresh-cookies.py`](file:///Users/chacha/src/youtube-describer/backend/bin/server-refresh-cookies.py).

## Runtime

**Environment:**
- Node.js (v18+ / v20+ compatible)

**Package Manager:**
- npm (v9+ / v10+ compatible)
- Lockfile: present ([`backend/package-lock.json`](file:///Users/chacha/src/youtube-describer/backend/package-lock.json) and [`frontend/package-lock.json`](file:///Users/chacha/src/youtube-describer/frontend/package-lock.json))

## Frameworks

**Core:**
- React (v19.1.1) - Frontend UI library.
- Express (v5.1.0) - Backend HTTP server and API routing framework.

**Testing:**
- React Testing Library (v16.3.0) & Jest (via `react-scripts`) - Used for frontend unit and integration tests.

**Build/Dev:**
- `react-scripts` (v5.0.1) - Create React App build pipeline scripts.
- `patch-package` (v8.0.1) - Applied in backend devDependencies to patch node dependencies directly.

## Key Dependencies

**Critical:**
- `@google/generative-ai` (^0.24.1) - Used to call Google Gemini models (`gemini-3.1-pro-preview` / `gemini-2.5-pro` for streaming script generation, and `gemini-2.5-flash` for Welfare Card OCR validation).
- `@google-cloud/text-to-speech` (^6.3.0) - Used for synthesizing Korean audio script chunks on-demand using Chirp3-HD models.
- `better-sqlite3` (^12.4.1) - Used as a local relational database engine to store cached metadata, scripts, and comments.
- `ytdl-core` (^4.11.5) / `youtube-sr` (^4.3.12) - Used for YouTube video metadata fetching and download streaming.

**Infrastructure:**
- `fluent-ffmpeg` (^2.1.3) - Node wrapper to spawn system `ffmpeg` processes for scene change keyframe extraction.
- `jsonwebtoken` (^9.0.3) - Handles JSON Web Token signature/generation for session authentication.
- `node-vad` (^1.1.3) / `wav` (^1.0.2) - Used for offline Voice Activity Detection and audio processing tasks.
- `check-disk-space` (^3.4.0) - Used to check system drive statistics in index.js to manage audio file cache cleanup.
- `dotenv` (^17.2.3) - Loads local environment variables from `backend/.env`.
- `cors` (^2.8.5) - Express middleware facilitating Cross-Origin Resource Sharing.

## Configuration

**Environment:**
- Configured via a local environment file ([`backend/.env`](file:///Users/chacha/src/youtube-describer/backend/.env)) loading keys into `process.env`.
- Key configs required: API keys (`GOOGLE_API_KEY`, `YOUTUBE_API_KEY`), model settings (`GEMINI_MODEL`), local speech-to-text settings (`WHISPER_BIN`, `WHISPER_MODEL`, `WHISPER_THREADS`), and external systems integration parameters (`SILOAM_API_URL`, `SILOAM_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).

**Build:**
- Frontend build settings, proxy routing, and dependencies are defined in [`frontend/package.json`](file:///Users/chacha/src/youtube-describer/frontend/package.json).
- Backend dependencies, entry script, and helper tasks are defined in [`backend/package.json`](file:///Users/chacha/src/youtube-describer/backend/package.json).

## Platform Requirements

**Development:**
- macOS or Linux workstation. System path must include compiled dependencies: `ffmpeg`, `yt-dlp`, and `whisper.cpp` (`whisper-cli`) alongside the `ggml-tiny-q5_1.bin` quantized language model.

**Production:**
- Google Cloud Platform VM (custom machine type: `e2-custom-4-8192` with 4 vCPUs, 8 GB RAM) running Ubuntu Linux. Reverse proxy is managed by Nginx, and backend execution is monitored via PM2.

---

*Stack analysis: 2026-08-18*
