<!-- refreshed: 2026-08-18 -->
# Architecture

**Analysis Date:** 2026-08-18

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│             Presentation / Routing / Client UI              │
├──────────────────┬──────────────────┬───────────────────────┤
│    React SPA     │ Express Routes   │   Express Server      │
│ `frontend/src/`  │`backend/routes.js`│  `backend/index.js`   │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│                 Video & AI Business Logic                   │
│ `backend/videoProcessor.js` & `backend/modules/`            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│           Caches, Database & External APIs                  │
│ `backend/db/cache.db` & `backend/public/audio/tts_cache/`  │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Express Entrypoint | Boots the Express server, runs old audio cache cleanup routines periodically, and registers static/JSON parsing middleware. | `backend/index.js` |
| Express API Routes | Exposes end-user REST APIs (e.g., search, script retrieval, comment CRUD, on-demand TTS synthesis) and manages Server-Sent Events (SSE) processing lines. | `backend/routes.js` |
| Video Processor | Coordinates the main processing flow: downloads video, extracts visual frames, handles duplicate request locking, generates descriptions with Gemini, and saves results. | `backend/videoProcessor.js` |
| Audio Language Detector | Extracts three audio slices (20%, 50%, 80% marks) using FFmpeg, analyzes speech with local Whisper-cli, and categorizes the audio language. | `backend/modules/audioLanguageDetector.js` |
| Database Interface | Initializes SQLite connection in WAL mode, performs auto-migrations, and exposes helpers for database transactions (videos, comments, API costs). | `backend/database.js` |
| Shared Utilities | Provides helpers for YouTube ID parsing, VTT parsing, password cryptography, and external Siloam/OCR API integrations. | `backend/utils.js` |
| Logger | Logs events to date-separated files in Korea Standard Time (KST) and sends instant error notifications via Telegram Bot. | `backend/logger.js` |
| React App Root | Mounts application routing, applies custom theme, and wraps contexts for global Accessibility and Auth status. | `frontend/src/App.js` |
| Player V2 Screen | Plays the YouTube frame using `react-youtube`, consumes the backend SSE stream, manages play/pause overrides, caches TTS, and ducks sound. | `frontend/src/screens/PlayerScreenV2.js` |

## Pattern Overview

**Overall:** Layered Architecture (Client-Server Architecture) with Asynchronous Processing and Hybrid Caching.

**Key Characteristics:**
- **On-Demand Progressive Streaming:** Rather than generating everything upfront, script data is streamed progressively via Server-Sent Events (SSE) from the backend, and TTS audio is generated on-demand when the playback reaches the specific timestamp.
- **Content-Addressable Audio Cache:** Audio clips generated via Google Cloud TTS are cached using hashes of the model name and text, preventing duplicate generation costs.
- **Resource Constraints and Parallelism:** Latency-critical tasks (hybrid keyframe extraction and language detection) are run in parallel, using spawn limits to prevent CPU starvation.

## Layers

**Presentation Layer (Client SPA):**
- Purpose: Renders the user-facing web pages and handles accessible audio/video synchronized playbacks.
- Location: `frontend/src/`
- Contains: React components, screens, contexts, hooks, styles.
- Depends on: Express API Routing Layer (interacts via `axios` and `EventSource`).
- Used by: End users.

**Presentation Layer (API Routing):**
- Purpose: Declares REST and streaming endpoints, performs session authentications, and records analytics requests.
- Location: `backend/routes.js`
- Contains: Express routing paths, authentication checks, global tracking middleware.
- Depends on: Video & AI Business Logic Layer, Data Access Layer.
- Used by: Presentation Layer (Client SPA).

**Video & AI Business Logic Layer:**
- Purpose: Downloads YouTube video files, pulls out visual frames, infers language, runs LLM models, and calculates costs.
- Location: `backend/videoProcessor.js`, `backend/modules/`
- Contains: CLI invocations, Google AI API calls, parser utilities.
- Depends on: Data Access Layer, Shared Utilities, external API clients (Gemini AI Studio).
- Used by: Presentation Layer (API Routing).

**Data Access Layer:**
- Purpose: Connects to the SQLite store, sets up indexes, runs schema changes, and reads/writes documents.
- Location: `backend/database.js`
- Contains: SQLite connector definitions, query methods, transactions, schemas.
- Depends on: Node.js file system API.
- Used by: Presentation Layer (API Routing), Video & AI Business Logic Layer.

## Data Flow

### Primary Request Path

1. **Client Request Trigger:** The browser opens an SSE stream to `/api/process?youtubeUrl=[URL]&token=[JWT]` (`frontend/src/screens/PlayerScreenV2.js:240`).
2. **Authentication and Limits Verification:** The router checks session status (`backend/routes.js:285`) and queries total balance (`backend/routes.js:363`). If clear, it hands control to `processVideo` (`backend/videoProcessor.js:337`).
3. **Locking and Initialization:** The system locks `videoId` in `processingLocks` (`backend/videoProcessor.js:340`) and registers a preliminary DB record (`backend/videoProcessor.js:360`).
4. **Metadata Extraction:** Resolves title, duration, and embed status via the YouTube Data API (`backend/videoProcessor.js:400`).
5. **Download Pipeline:** Downloads video-only files (max 360p) and autogenerated subtitle VTT tracks via `yt-dlp` using rolling cookies (`backend/videoProcessor.js:517`).
6. **Parallel Extraction and Language Classification:**
   - **Keyframes Extraction:** Hybrid extractor performs fast nokey I-frame scans, then backfills missing timestamps (`backend/videoProcessor.js:630`).
   - **Language Classification:** Extracts audio samples at 20%, 50%, and 80% marks and invokes `whisper-cli` to determine language (`backend/modules/audioLanguageDetector.js:55`).
7. **Gemini Streaming Execution:** Replaces template tags in `backend/prompt_template.txt` and calls the `generateContentStream` API using `gemini-3.1-pro-preview` under low-resolution mode (`backend/videoProcessor.js:720`).
8. **Progressive Script Saving and Pushing:** Incoming script chunks matching regex parser patterns are stored in SQLite (`backend/videoProcessor.js:752`) and streamed to the client via SSE `script_chunk` payloads (`backend/videoProcessor.js:748`).
9. **Final Assembly & Optimization:** Filters out overlapping OCR texts via Levenshtein calculations (`backend/videoProcessor.js:786`), updates video states (`backend/videoProcessor.js:805`), logs billing tokens (`backend/videoProcessor.js:814`), and purges workspace files (`backend/videoProcessor.js:871`).

**State Management:**
- **Server Locks:** Double-processing requests are blocked using a memory `Set` (`processingLocks` in `backend/videoProcessor.js:88`).
- **Database Caches:** Completed video models, scripts, and comments are fetched directly from SQLite.
- **Client Playback Caches:** TTS audio blobs are saved in a local memory Map ref (`audioCache` in `frontend/src/screens/PlayerScreenV2.js:586`) to speed up playback and avoid redundant API requests.

## Key Abstractions

**Dialogue Track:**
- Purpose: Formats subtitle data (`.vtt`) into clean timestamp-tagged text matrices used by Gemini prompts to understand the conversation timeline.
- Examples: `parseVttToDialogueTrack` in `backend/videoProcessor.js`.
- Pattern: Parser method pattern.

**Audio Language Classification:**
- Purpose: Classifies audio track language into `korean`, `foreign`, `mixed`, or `unknown` using a 3-point sample inference scheme to determine translation/speaking policies.
- Examples: `backend/modules/audioLanguageDetector.js`.
- Pattern: Helper module facade.

**Hybrid Keyframe Extractor:**
- Purpose: Speed-optimizes video scanning by extracting I-frames first and then targeting search queries on the remaining gaps.
- Examples: `extractKeyframesHybrid` in `backend/videoProcessor.js`.
- Pattern: Two-phase pipeline optimizer.

**TTS Cache Key:**
- Purpose: Binds cached TTS files to the active Google TTS voice model to prevent serving outdated audio tracks.
- Examples: `crypto.createHash('sha256').update(voiceName + ":" + text)` in `/api/tts` (`backend/routes.js:221`).
- Pattern: Consistent hashing / Content-addressable cache.

## Entry Points

**Express Web Daemon:**
- Location: `backend/index.js`
- Triggers: Spawned by PM2 or standard shell execution.
- Responsibilities: Prepares database, registers static media folders, hooks listeners, and initiates daily audio sweeps.

**Offline CLI script:**
- Location: `backend/process_video_cli.js`
- Triggers: Manual execution via command line.
- Responsibilities: Runs the three-stage process (`analyzer`, `describer`, `synchronizer`) without Express overhead.

**React Client App:**
- Location: `frontend/src/index.js`
- Triggers: Browser loading page index.
- Responsibilities: Mounts DOM node, applies global styles, binds context handlers.

## Architectural Constraints

- **Threading:** Node.js runs on a single event loop. Heavy visual and audio operations (ffmpeg slicing, whisper-cli transcribing, yt-dlp downloading) are spawned off as external processes (`spawn`, `execFile`) to prevent blocking the event loop. Whisper-cli concurrency is limited to a custom number of threads (configured by `WHISPER_THREADS=1` to prevent VM CPU starvation).
- **Global state:** Shared request locks (`processingLocks`) are stored in-memory. If the process crashes, the locks are cleared, and video generation records default back to their actual DB states.
- **Circular imports:** No circular dependencies are permitted. The dependencies flow linearly: Routes -> Video Processor -> Modules/Database/Utils.

## Anti-Patterns

### Synchronous File I/O in Async Handlers

**What happens:** Inside `videoProcessor.js:711`, `fs.readFileSync` is used to load `prompt_template.txt` synchronously inside the asynchronous processing flow.
**Why it's wrong:** Blocking operations stall Node's single-threaded event loop, degrading the server's throughput and increasing response latency for other concurrent users.
**Do this instead:** Replace it with an asynchronous read using `fs.promises.readFile`:
```javascript
const prompt = await fs.promises.readFile(promptTemplatePath, 'utf-8');
```

## Error Handling

**Strategy:** Graceful degradation and user-facing notifications. Errors are categorized as early-stage validation, client duration limits, API quota limits, and system failures, and mapped to specific JSON payloads streamed through SSE or REST endpoints.

**Patterns:**
- **SSE Error Injection:** Catches failures inside the async handler and writes `backend_error` payloads into the SSE stream (e.g. `funds_depleted`, `unverified_user_duration_exceeded`) to let the React client display informative alerts.
- **yt-dlp Cookie Roll-over:** Detects bot-blocking messages (e.g., `HTTP Error 403`, `Login Required`). If detected on the first download attempt, the script invalidates the active cookie (`.invalid`) and automatically rolls over to a secondary cookie file for attempt 2.

## Cross-Cutting Concerns

**Logging:** Uses `backend/logger.js` to log events. Operations are recorded to daily files using KST timezones. System crashes or critical exceptions trigger immediate alert messages sent to administrators via the Telegram Bot API.

**Validation:**
- **URLs:** All inputs are parsed against `YOUTUBE_URL_REGEX` to prevent command-injection threats.
- **OCR Identity Checks:** Validates user card photos using `gemini-2.5-flash` with response schema checking names, birth dates, and "시각장애" keywords.

**Authentication:** Binds JWT verification middleware (`requireAuth` and `requireBlindAuth`) inside `backend/routes.js`. Admin endpoints authenticate via custom Bearer headers comparing requests to the `admin_password` config in settings database.

---

*Architecture analysis: 2026-08-18*
