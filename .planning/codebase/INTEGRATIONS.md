# External Integrations

**Analysis Date:** 2026-08-31

## APIs & External Services

**YouTube metadata and search:**
- YouTube Data API v3 - Looks up title, duration, embeddability, live-stream status, and snippet/content details before processing in `backend/videoProcessor.js`.
  - SDK/Client: `googleapis` 60.0.1 (`google.youtube({ version: 'v3' })`).
  - Auth: `YOUTUBE_API_KEY`, falling back to `GOOGLE_API_KEY`, in `backend/videoProcessor.js`.
- YouTube search - Searches up to 50 video results alongside local SQLite title search in `backend/routes.js`.
  - SDK/Client: `youtube-sr` 4.3.12, patched through `backend/patches/youtube-sr+4.3.12.patch`.
  - Auth: No application key is passed by the search call in `backend/routes.js`.
- YouTube player and thumbnails - The browser embeds the source video with `react-youtube` and constructs `i.ytimg.com` thumbnails in `frontend/src/screens/PlayerScreenV2.js` and `backend/routes.js`.
  - Auth: YouTube iframe/player policy is controlled by YouTube; no server credential is used by the player component.

**YouTube media acquisition:**
- `yt-dlp` - Downloads low-resolution video, audio, and `ko`/`en` subtitle tracks for the interactive and batch processors in `backend/videoProcessor.js`.
  - Client: External `yt-dlp` executable spawned with `child_process`; CLI variants also invoke `python3 -m yt_dlp` in `backend/process_video_cli.js` and `backend/run_batch_single*.js`.
  - Auth/session: Cookie files are selected from the runtime `backend/cookies/` directory; default/browser cookie fallback behavior is implemented in `backend/videoProcessor.js`. Cookie contents are not part of this audit.
  - Network options: `YTDLP_PROXY`, optional Safari impersonation, IPv4 forcing, and the checked-in plugin directory `backend/yt_dlp_plugins`.
  - Token helper: `backend/videoProcessor.js` spawns Deno to run `backend/get_pot.ts`, which fetches YouTube bootstrap data and supplies PO-token data to the local workflow.

## AI and Speech Processing

**Gemini generation:**
- Google Gemini - Generates multimodal Korean audio-description drafts from frames, timestamps, title, audio classification, and source dialogue in `backend/videoProcessor.js`.
  - SDK/Client: `@google/generative-ai` 0.24.1.
  - Auth: `GOOGLE_API_KEY` in `backend/videoProcessor.js`.
  - Model: `GEMINI_MODEL`, defaulting in the main processor to `gemini-3.1-pro-preview`; batch/test paths may select their own model defaults.
  - Modes: Interactive processing uses `generateContentStream`; batch processing uses `generateContent`; usage metadata is converted to an estimated cost and persisted in `backend/database.js`.
- Shared prompt policy - Main description, CLI description, and synchronization paths load and assert `backend/prompt_template_codex_v2.txt` through `backend/modules/promptPolicy.js`; stage-specific prompts remain in `backend/prompts/stage1_analyzer.txt`, `backend/prompts/stage2_describer.txt`, and `backend/prompts/stage3_synchronizer.txt`.
- Genre/staged CLI analysis - `backend/process_video_cli.js` calls `backend/modules/analyzer.js`, `backend/modules/describer.js`, and `backend/modules/synchronizer.js` for 15-minute chunks; this is a separate CLI pipeline from the main whole-video API path.
- Card OCR verification - `backend/utils.js` sends an uploaded identity-card image and registration fields to Gemini using a hard-coded `gemini-2.5-flash` JSON-schema request; it also uses `GOOGLE_API_KEY` and deliberately returns only boolean matches/confidence rather than the sensitive card number tail.

**Whisper and FFmpeg:**
- Local whisper.cpp - Detects Korean, foreign, mixed, or unknown audio by running three concurrent short samples through the local `whisper-cli` binary in `backend/modules/audioLanguageDetector.js`.
  - Binary/model: `WHISPER_BIN` and `WHISPER_MODEL`, with local-machine defaults under `/home/chacha/whisper.cpp`.
  - Tuning: `WHISPER_THREADS` and `WHISPER_TIMEOUT_MS`.
  - Data boundary: No Whisper network API is called; sample WAV files are removed in the detector `finally` block.
- FFmpeg/FFprobe - Extracts keyframes, transcodes audio samples to 16 kHz mono WAV, probes duration, and chunks legacy CLI video files in `backend/videoProcessor.js`, `backend/modules/audioLanguageDetector.js`, and `backend/process_video_cli.js`.
  - Client: Current API path spawns system binaries directly; legacy scripts use `fluent-ffmpeg`.
  - Resource boundary: Temporary per-video workspaces are placed under `backend/temp/<videoId>` and removed after processing.

**Google Cloud Text-to-Speech:**
- Google Cloud TTS - Synthesizes accepted Korean canonical events as MP3 in the `POST /api/tts` handler in `backend/routes.js`.
  - SDK/Client: `@google-cloud/text-to-speech` 6.3.0 and `TextToSpeechClient`.
  - Auth: The code relies on the Google client’s ambient credential configuration; it does not read or print credential values. Deployment documentation mentions an ignored service-account file, whose contents are not inspected.
  - Transport: `NODE_EXTRA_CA_CERTS` switches the client to the REST fallback for environments with custom CA certificates.
  - Voice: The request uses the Korean `ko-KR` language and the `ko-KR-Chirp3-HD-Sulafat` voice with MP3 output.
  - Eligibility: `backend/modules/ttsPolicy.js` requires a persisted accepted event with `ttsEligible === true`; rejected/quarantined or non-canonical events cannot be synthesized.

## Data Storage

**Databases:**
- SQLite - Stores video metadata/status, canonical scripts, quarantine diagnostics, API costs, settings, users, verification history, comments, board posts, watch history, favorites, and API request tracking in `backend/database.js`.
  - Connection: `YOUTUBE_DESCRIBER_DB_PATH`, otherwise `backend/db/cache.db`, in `backend/database.js`.
  - Client: `better-sqlite3` 12.4.1.
  - Concurrency: WAL mode is enabled in `backend/database.js`; canonical script writes use transactions and `INSERT OR IGNORE` for idempotent event IDs.
  - Schema behavior: `backend/database.js` creates tables at startup and applies additive column checks for legacy schema compatibility rather than using a separate migration tool.

**File Storage:**
- Local filesystem only - Temporary downloaded media/frames/subtitles live under `backend/temp/`, TTS MP3 files under `backend/public/audio/tts_cache/`, and generated voice samples under `frontend/public/voice_samples/` via `backend/generate_samples.js`.
- TTS cache - `backend/routes.js` derives a SHA-256 key from video/event/voice/format/text, shards files under two hash-prefix directories, and `backend/index.js` serves the cache at `/audio/tts_cache`.
- Cache lifecycle - `backend/index.js` checks disk usage at startup and daily, deleting TTS files older than 30 days only when the partition is at least 70% full.

**Caching:**
- SQLite canonical/video cache - `backend/videoProcessor.js` returns a completed cached video without reprocessing when `backend/database.js` contains a completed script.
- In-process processing lock - A `Set` keyed by video ID in `backend/videoProcessor.js` prevents duplicate work only within the current Node process.
- Browser TTS cache - `frontend/src/screens/PlayerScreenV2.js` keeps object URLs in a per-player `Map`; the server-side cache remains the durable audio cache.

## Authentication & Identity

**User authentication:**
- Custom stateless JWT - Registration/login/session endpoints in `backend/routes.js` issue and verify bearer tokens signed with `JWT_SECRET`, with a 30-day expiry. The browser stores the token in local storage and installs it as Axios’s default Authorization header in `frontend/src/contexts/AuthContext.js`.
- Password storage - `backend/utils.js` hashes passwords with Node `crypto.pbkdf2Sync` using a random salt; `backend/database.js` persists the resulting hash in the `users` table.
- Processing access - `requireBlindAuth` in `backend/routes.js` accepts authenticated users and leaves the duration/verification policy to `backend/videoProcessor.js`; SSE clients pass the token in the query string because native `EventSource` cannot set headers.
- No OAuth/OIDC provider or session store is present in the repository; logout is client-side token removal plus a stateless acknowledgement in `backend/routes.js`.

**Blind-status verification:**
- Siloam member API - `backend/utils.js` sends a JSON POST with name/birth date and API headers for external membership verification.
  - Endpoint: `SILOAM_API_URL`.
  - Auth/tenant: `SILOAM_API_KEY` and `SILOAM_ORG`.
  - Test mode: `SILOAM_MOCK` enables a local mock branch.
- Gemini card OCR - `backend/utils.js` accepts a base64 card image through registration/re-verification routes in `backend/routes.js` and returns structured eligibility/confidence.
- Manual review - Low-confidence card results are stored as pending status and reviewed through the admin endpoints in `backend/routes.js` and verification tables in `backend/database.js`.

**Admin authentication:**
- Database-backed password token - `backend/routes.js` exposes `/api/login`, compares a supplied bearer token to the `admin_password` setting, and applies the same `adminAuth` middleware to `/api/admin/*`; it is separate from the user JWT flow.

## Monitoring & Observability

**Error Tracking:**
- Telegram alerts - Error-level messages in `backend/logger.js` are sent to `api.telegram.org` when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured; identical messages are deduplicated for ten seconds and truncated before delivery.
- No hosted error-tracking SDK is present in `backend/package.json`.

**Logs:**
- File/console logger - `backend/logger.js` writes KST-dated files under `backend/logs/` and echoes logs outside production; processing stages, provider failures, API costs, and user/API tracking are logged by `backend/videoProcessor.js`, `backend/routes.js`, and `backend/database.js`.
- API request audit - `backend/routes.js` records user/guest identifier, IP, and route path into SQLite `api_requests` through `backend/database.js`.
- Deployment/traffic logs - Repository operations documentation refers to Nginx access logs and PM2-managed backend logs, but Nginx configuration is external to this repository.

## CI/CD & Deployment

**Hosting:**
- Documented target - Google Cloud Platform Ubuntu ARM server, with Nginx serving the built frontend and reverse proxying API traffic, as described in `docs/technical_specs.md` and `docs/deploy_plan.txt`.
- Process supervision - PM2 is documented for the Node backend, but no PM2 ecosystem file is committed; `deploy-test.sh` triggers a remote deployment script over SSH.
- Local deployment scripts - `deploy-prod.sh` pushes the main branch and `deploy-test.sh` pushes the `test` branch; both also commit all local changes, so they are operational scripts rather than CI definitions.

**CI Pipeline:**
- None detected - There is no checked-in GitHub Actions, GitLab CI, or other CI workflow. Verification is exposed through `frontend/package.json` scripts and standalone Node tests in `backend/`.

## Environment Configuration

**Required env vars:**
- AI/YouTube: `GOOGLE_API_KEY`, optionally `YOUTUBE_API_KEY`, `GEMINI_MODEL`, and `PROMPT_FILE` in `backend/videoProcessor.js` and `backend/modules/promptPolicy.js`.
- Media/network: `WHISPER_BIN`, `WHISPER_MODEL`, `WHISPER_THREADS`, `WHISPER_TIMEOUT_MS`, and optional `YTDLP_PROXY` in `backend/modules/audioLanguageDetector.js` and `backend/videoProcessor.js`.
- Storage/server: optional `YOUTUBE_DESCRIBER_DB_PATH`, `PORT`, `NODE_ENV`, and `NODE_EXTRA_CA_CERTS` in `backend/database.js`, `backend/index.js`, and `backend/routes.js`.
- Identity/alerts: `JWT_SECRET`, `SILOAM_MOCK`, `SILOAM_API_URL`, `SILOAM_API_KEY`, `SILOAM_ORG`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` in `backend/routes.js`, `backend/utils.js`, and `backend/logger.js`.
- Frontend: optional `REACT_APP_API_URL` and build-provided `NODE_ENV` in `frontend/src/contexts/AuthContext.js` and `frontend/src/screens/PlayerScreenV2.js`.

**Secrets location:**
- `backend/.env` and `backend/.env.bak` exist and are treated as confidential; only the variable names above are documented.
- Runtime YouTube cookies reside under `backend/cookies/` and are ignored by `.gitignore`; cookie contents and service-account material are not included in this document.

## Webhooks & Callbacks

**Incoming:**
- No third-party webhook endpoint is detected. The browser initiates processing through `GET /api/process` and receives a long-lived SSE response in `backend/routes.js`.
- Browser-to-backend callbacks include `POST /api/tts`, auth routes, user verification, favorites/history, comments, board, and admin endpoints in `backend/routes.js`; these are ordinary REST calls rather than external webhooks.

**Outgoing:**
- YouTube Data API, YouTube web/media endpoints, Gemini, Google Cloud TTS, Siloam, and Telegram calls originate from `backend/videoProcessor.js`, `backend/get_pot.ts`, `backend/utils.js`, `backend/routes.js`, and `backend/logger.js`.
- No signed webhook delivery, payment callback, or external event subscription is implemented in the current repository.

---

*Integration audit: 2026-08-31*
