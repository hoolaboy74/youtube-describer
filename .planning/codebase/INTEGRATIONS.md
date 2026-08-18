# External Integrations

**Analysis Date:** 2026-08-18

## APIs & External Services

**AI & Language Processing:**
- Google Gemini API - Used for context-aware screen description generation (via `gemini-3.1-pro-preview`) and optical character recognition on Welfare Cards (via `gemini-2.5-flash`).
  - SDK/Client: `@google/generative-ai`
  - Auth: `GOOGLE_API_KEY` (with fallback to `GEMINI_API_KEY`)

**Speech Synthesis:**
- Google Cloud Text-to-Speech API - Converts description text chunks into natural Korean speech on-demand (specifically using Chirp3-HD flagship generative model `ko-KR-Chirp3-HD-Sulafat`).
  - SDK/Client: `@google-cloud/text-to-speech`
  - Auth: `GOOGLE_API_KEY`

**Identity & Membership:**
- Siloam Member Database API - Validates user registration data against verified blind user records.
  - SDK/Client: Native Node.js `https` module request.
  - Auth: `SILOAM_API_KEY` (headers `X-Api-Key` and `X-Org` via `SILOAM_ORG`)

**Messaging & Alerts:**
- Telegram Bot API - Dispatches real-time critical system error notifications.
  - SDK/Client: Native Node.js `https` module request.
  - Auth: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

**Media & Search:**
- YouTube API / Scraping - Searches YouTube query results, extracts subtitle transcripts, and fetches video streams.
  - SDK/Client: `youtube-sr`, `ytdl-core`, `googleapis` (`youtube.videos.list`), and spawned `yt-dlp` CLI processes.
  - Auth: `YOUTUBE_API_KEY` and local cookie file `my_cookies.txt`

## Data Storage

**Databases:**
- SQLite (Local database)
  - Connection: Saved in local file `backend/db/cache.db`.
  - Client: `better-sqlite3` (WAL mode enabled)

**File Storage:**
- Local filesystem only

**Caching:**
- Local folder storage caching. Synthesized audio blobs are stored locally in the nested directory `backend/public/audio/tts_cache/{hash[0:2]}/{hash[2:4]}/{hash}.mp3` indexed by `sha256(voiceName + ":" + text)`.
- Automated Cleanup: Checked daily via `setInterval` in `backend/index.js`; deletes files older than 30 days if the total system partition disk usage exceeds 70%.

## Authentication & Identity

**Auth Provider:**
- Custom
  - Implementation: Employs signed JWT tokens (`jsonwebtoken`) stored in client's `localStorage` and sent in the `Authorization: Bearer <token>` header of HTTP requests. Endpoints include registration, login, and `/api/auth/me`. Blind status is flagged on user profiles.

## Monitoring & Observability

**Error Tracking:**
- Telegram API alert integration. Critical error logs trigger automated Telegram alerts to a designated chat group with a 10-second deduplication lock.

**Logs:**
- Custom file logging (`backend/logger.js`) writing daily log entries (`YYYY-MM-DD.log`) inside `backend/logs/` using Korean Standard Time (KST) timestamps.

## CI/CD & Deployment

**Hosting:**
- Google Cloud Platform VM (custom machine type: `e2-custom-4-8192`, 4 vCPUs, 8 GB RAM) running Ubuntu Linux. Reverse proxy is managed by Nginx, and Node services run inside PM2.

**CI Pipeline:**
- None

## Environment Configuration

**Required env vars:**
- `GOOGLE_API_KEY`: API key for Gemini and Cloud TTS.
- `YOUTUBE_API_KEY`: API key for YouTube video/search inquiries.
- `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID`: Telegram channel alerts auth.
- `GEMINI_MODEL`: Set model string (e.g. `gemini-3.1-pro-preview`).
- `WHISPER_BIN` & `WHISPER_MODEL` & `WHISPER_THREADS`: Local speech-to-text language detection.
- `SILOAM_API_URL` & `SILOAM_API_KEY` & `SILOAM_ORG`: Siloam integration credentials.
- `JWT_SECRET`: Secret phrase for JWT token signing.

**Secrets location:**
- Local configuration file `backend/.env` (git-ignored).

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- None

---

*Integration audit: 2026-08-18*
