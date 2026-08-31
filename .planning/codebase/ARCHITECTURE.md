# Architecture

**Analysis Date:** 2026-08-31

## Pattern Overview

**Overall:** React single-page application backed by a Node.js/Express modular monolith with a process-local media/AI pipeline and a single `better-sqlite3` database.

**Key Characteristics:**
- `frontend/src/index.js` boots a React 19 SPA; `frontend/src/App.js` owns browser routing and wraps pages in authentication and accessibility providers.
- `backend/index.js` boots one Express server on port 4000, mounts `backend/routes.js` under `/api`, initializes SQLite, serves TTS cache files, and runs periodic cleanup in the same process.
- `backend/videoProcessor.js` owns the end-to-end interactive and batch generation pipeline, including YouTube metadata, `yt-dlp`, FFmpeg, Whisper language detection, Gemini generation, canonical validation, SQLite publication, and SSE callbacks.
- Interactive processing is held by the HTTP/SSE request, while `/batch-process` acknowledges with HTTP 202 and starts an in-process fire-and-forget promise; `processingLocks` in `backend/videoProcessor.js` is process-local rather than durable.
- The canonical event contract in `backend/modules/canonicalOutput.js` is the policy boundary, while `backend/database.js` projects accepted events back to the legacy script shape used by the API and players.

## Layers

**Browser presentation and routing:**
- Purpose: Render public pages, authenticated account flows, community/admin pages, the YouTube player, accessibility announcements, and local playback preferences.
- Location: `frontend/src/index.js`, `frontend/src/App.js`, `frontend/src/components/`, `frontend/src/contexts/`, and `frontend/src/screens/`.
- Contains: React components, React Router routes, Axios calls, `EventSource` handling, YouTube iframe integration, Web Audio/TTS scheduling, and screen-reader live regions.
- Depends on: `/api` endpoints in `backend/routes.js`, `react-youtube`, `axios`, browser `localStorage`, and the YouTube player API.
- Used by: Browser users; `frontend/src/screens/PlayerScreenV2.js` is the active route for `/video/:videoId`, while `frontend/src/screens/PlayerScreen.js` and `frontend/src/PlayerScreen.js` retain legacy player implementations.

**HTTP/API and access-control layer:**
- Purpose: Validate request shape, record API activity, authenticate users, expose video/script/community/account/admin operations, and adapt processor callbacks to SSE.
- Location: `backend/index.js` and `backend/routes.js`.
- Contains: CORS/body middleware, `/api` route registration, `trackApiRequest`, JWT-based `requireAuth`/`requireBlindAuth`, admin password middleware, REST handlers, `/process` SSE, `/batch-process`, and `/tts`.
- Depends on: `backend/database.js`, `backend/videoProcessor.js`, `backend/utils.js`, `backend/modules/ttsPolicy.js`, Google Cloud TTS, YouTube search, and JWT configuration.
- Used by: All frontend screens and operational/CLI callers that use the HTTP API.

**Video processing orchestration:**
- Purpose: Download source media and captions, extract frame/audio evidence, call Gemini, canonicalize generated output, persist accepted events, and report status.
- Location: `backend/videoProcessor.js`.
- Contains: `processVideo`, `processVideoBatch`, `extractKeyframesHybrid`, VTT parsing/subtitle selection, prompt assembly, Gemini calls, API-cost accounting, retry cleanup, process-local locks, and temporary-directory cleanup.
- Depends on: `backend/database.js`, `backend/modules/audioLanguageDetector.js`, `backend/modules/promptPolicy.js`, `backend/modules/canonicalOutput.js`, `backend/utils.js`, `yt-dlp`, FFmpeg, Deno/POT tooling, Whisper, YouTube Data API, and Gemini.
- Used by: `backend/routes.js` for interactive and batch requests; `backend/test_*` integration tests call exported helpers directly.

**Policy, canonicalization, and playback eligibility:**
- Purpose: Convert model or CLI output into evidence-bearing events, enforce language/provenance and duplicate rules, preserve legacy tags, and define the server-side TTS eligibility boundary.
- Location: `backend/modules/canonicalOutput.js`, `backend/modules/promptPolicy.js`, `backend/modules/ttsPolicy.js`, and `backend/prompt_template_codex_v2.txt`.
- Contains: Allowlisted tags, canonical IDs, normalized text, visual/screen-text/foreign-dialogue provenance, accepted/quarantined/rejected status, common prompt loading/assertion, and accepted-event lookup by `videoId` plus `eventId`.
- Depends on: Structured frame evidence, dialogue intervals, audio classification, the v2 prompt file, and the database projection returned by `backend/database.js`.
- Used by: `backend/videoProcessor.js`, `backend/process_video_cli.js`, `backend/routes.js`, and `frontend/src/screens/PlayerScreenV2.js` plus the legacy player variants.

**Persistence and domain data access:**
- Purpose: Own SQLite connection, schema initialization/migrations, transactional writes, legacy-compatible reads, and all user/video/community/admin data access.
- Location: `backend/database.js` with the runtime database at `backend/db/cache.db` when no `YOUTUBE_DESCRIBER_DB_PATH` override is configured.
- Contains: `videos`, `scripts`, `script_quarantine`, `comments`, `donations`, `api_costs`, `settings`, `posts`, `post_comments`, `users`, `user_verifications`, watch history, favorites, and API request tables.
- Depends on: `better-sqlite3`, filesystem setup, and `backend/logger.js`.
- Used by: `backend/routes.js`, `backend/videoProcessor.js`, CLI processing, and tests that inject a temporary database path.

**CLI processing chain:**
- Purpose: Provide a script-driven multi-stage processing path with analysis, description, synchronization, and canonical persistence.
- Location: `backend/process_video_cli.js`, `backend/modules/analyzer.js`, `backend/modules/describer.js`, `backend/modules/synchronizer.js`, and `backend/modules/cliCanonicalOutput.js`.
- Contains: Chunk-oriented CLI media extraction, one-time visual analysis, stage-specific Gemini calls, JSON synchronization, CLI-to-canonical adaptation, and direct database writes.
- Depends on: The same SQLite and canonical modules as the server, plus CLI-managed FFmpeg/`yt-dlp` work directories and Gemini.
- Used by: Manual/operational command-line execution; it is not mounted as an Express route.

## Data Flow

**Cached video playback:**

1. `frontend/src/screens/HomeScreen.js` loads `/api/cached-videos`, search/recommendation endpoints, and navigates to `/video/:videoId`.
2. `frontend/src/screens/PlayerScreenV2.js` requests `/api/script/:videoId`; `backend/routes.js` calls `backend/database.js` `getVideo` and returns video metadata plus sorted script rows.
3. The player filters only `validationStatus === 'accepted'` and `ttsEligible === true`, applies verbosity/subtitle preferences, and synchronizes selected events to the YouTube player clock.
4. On an eligible event, `frontend/src/screens/PlayerScreenV2.js` posts `{ videoId, eventId }` to `/api/tts`; `backend/modules/ttsPolicy.js` resolves the exact accepted event, `backend/routes.js` synthesizes Korean MP3 through Google Cloud TTS, and the result is cached under `backend/public/audio/tts_cache/`.

**Interactive generation over SSE:**

1. `frontend/src/screens/PlayerScreenV2.js` opens `GET /api/process?youtubeUrl=...&token=...` after a missing, pending, or failed script; `frontend/src/screens/PlayerScreen.js` retains a legacy unauthenticated-compatible client path.
2. `backend/routes.js` authenticates the request, checks `processingPaused`, extracts the YouTube ID, checks aggregate balance, creates an SSE response with 15-second heartbeats, and calls `processVideo` with an SSE callback.
3. `backend/videoProcessor.js` rejects invalid/duplicate process-local requests, creates a preliminary SQLite video row, checks the cached completed record, fetches metadata through the YouTube Data API, enforces live/embed/duration/account limits, and marks the video as `processing`.
4. The processor downloads a low-resolution video and `ko,en` captions with `yt-dlp`, retries bot/auth failures with another cookie, and stores temporary artifacts in `backend/temp/<videoId>/`.
5. `extractKeyframesHybrid` runs FFmpeg I-frame extraction and bounded backfill; `audioLanguageDetector.detectLanguage` concurrently extracts three ten-second WAV samples and runs three Whisper language detections. The processor selects an original-language VTT and converts it to structured dialogue intervals.
6. Frame images and integer timestamps are assembled into one Gemini multimodal request with the validated v2 prompt from `backend/modules/promptPolicy.js`. Interactive generation consumes `generateContentStream` and buffers the complete model text before validation.
7. `canonicalizeModelOutput` in `backend/videoProcessor.js` parses tags and attaches nearest-frame, screen-text, or dialogue provenance; `validateEvents` in `backend/modules/canonicalOutput.js` separates accepted, quarantined, and rejected events.
8. `publishCanonicalOutput` writes accepted events transactionally through `backend/database.js`, stores bounded diagnostics in `script_quarantine`, emits accepted legacy-compatible `script_chunk` events, updates video status, and emits `end` or an error event.
9. The SSE client de-duplicates received events by canonical ID, sorts by timestamp, enables the player on the first accepted chunk, and closes on `end`; progress and script state are not replayed from a durable server event log.

**Batch generation:**

1. A caller posts a YouTube URL to `/api/batch-process`; `backend/routes.js` validates the URL, returns 202 immediately, and invokes `processVideoBatch` without retaining an HTTP response.
2. `processVideoBatch` repeats the metadata/download/FFmpeg/Whisper/subtitle/Gemini sequence in `backend/videoProcessor.js`, but uses non-streaming `generateContent` and has no SSE callback.
3. Batch output passes through `canonicalizeModelOutput` and `publishCanonicalOutput`, then the temporary directory is removed and SQLite status is set to `completed` or `failed`.

**Canonical output and provenance:**

1. Model lines must match the strict `[integer][v1|v2|v3|txt|trans] text` form in `backend/modules/canonicalOutput.js`.
2. Visual tags require frame evidence; `[txt]` requires independently visible screen-text evidence; `[trans]` requires a confirmed foreign dialogue interval and a permitted `korean`/`foreign`/`mixed`/`unknown` decision.
3. Normalized text, tag, timestamp, provenance kind, and dialogue identity form a deterministic event ID; duplicate, ambiguous, unsafe, or invalid candidates remain non-playable.
4. `backend/database.js` stores accepted canonical fields in additive `scripts` columns and returns both legacy `verbosity` (`v1`/`v2`/`v3`/`text`/`translation`) and canonical metadata from `getVideo`.
5. `backend/modules/ttsPolicy.js` requires the exact stored event to be accepted and TTS eligible; all player variants also enforce those fields before requesting audio.

**State Management:**
- Persistent video lifecycle is represented by `videos.status`, `fail_reason`, `requested_by`, and `audio_language` in `backend/database.js`; script-level validation/provenance is represented by `scripts` and `script_quarantine`.
- Processing ownership, duplicate detection, timing labels, and retry lifecycle are process-local in `backend/videoProcessor.js` through `processingLocks` and `timers`; there are no job/chunk/attempt tables or startup reconciliation routines.
- Browser playback state, SSE connection state, verbosity, subtitle reading, playback mode/rate, and TTS cache URLs live in React state/refs and `localStorage` in `frontend/src/screens/PlayerScreenV2.js`.

## Key Abstractions

**Video processor:**
- Purpose: Single orchestration boundary for both server generation modes.
- Examples: `backend/videoProcessor.js:467` (`processVideo`) and `backend/videoProcessor.js:931` (`processVideoBatch`).
- Pattern: Long async procedures coordinate external processes directly and call database helpers at lifecycle boundaries; keep new processing stages behind explicit helpers or modules while preserving the shared canonical publication call.

**Canonical event:**
- Purpose: Internal typed representation that carries identity, timestamp, text, tag, provenance, policy version, validation status/reasons, audio language, and TTS eligibility.
- Examples: `backend/modules/canonicalOutput.js` and `backend/database.js:428`.
- Pattern: Treat canonical fields as the source of truth; use `toLegacyScriptEvent` only at the API/SSE compatibility boundary.

**Persistence adapter:**
- Purpose: Convert canonical events into accepted-only SQLite rows and convert rows back into a legacy-compatible API DTO with canonical metadata.
- Examples: `backend/database.js:436`, `backend/database.js:463`, and `backend/database.js:385`.
- Pattern: Add schema changes additively through the existing `try/catch` column checks and keep writes inside `better-sqlite3` transactions.

**SSE callback protocol:**
- Purpose: Let `backend/videoProcessor.js` report progress and accepted script events without depending on Express response internals.
- Examples: `backend/routes.js:328` (`sendSse`) and calls from `backend/videoProcessor.js`.
- Pattern: Send named events with JSON payloads; preserve `status_update`, `start`, `script_chunk`, `end`, `duplicate_request`, and `backend_error` names for the current clients.

**Player TTS scheduler:**
- Purpose: Select eligible events by verbosity/audio policy and play identity-bound generated audio against the YouTube clock.
- Examples: `frontend/src/screens/PlayerScreenV2.js:filteredScript`, `playableScript`, and `playDescription`.
- Pattern: Keep eligibility filtering before scheduling and send `{ videoId, eventId }` to `/api/tts`; do not reintroduce raw-text synthesis.

## Entry Points

**Express server:**
- Location: `backend/index.js`.
- Triggers: `npm start` in `backend/package.json`.
- Responsibilities: Load environment configuration, initialize SQLite, configure middleware/static TTS files, mount API routes, listen on `PORT` or 4000, and start disk cleanup.

**API router:**
- Location: `backend/routes.js`.
- Triggers: Requests under `/api` mounted by `backend/index.js`.
- Responsibilities: Video/script/search/TTS operations, SSE and batch starts, auth/verification, account history/favorites, board/comments, and admin operations.

**Interactive processor:**
- Location: `backend/videoProcessor.js:467`.
- Triggers: `GET /api/process` in `backend/routes.js`.
- Responsibilities: Maintain the SSE-backed request while downloading, extracting, generating, validating, persisting, and cleaning up.

**Batch processor:**
- Location: `backend/videoProcessor.js:931`.
- Triggers: `POST /api/batch-process` in `backend/routes.js` or direct operational invocation.
- Responsibilities: Run the non-streaming generation path in the background and persist final status.

**CLI processor:**
- Location: `backend/process_video_cli.js`.
- Triggers: Node command-line invocation with a YouTube URL and optional part/featured flags.
- Responsibilities: Run the staged analyzer/describer/synchronizer chain, canonicalize each processed part, write accepted events/quarantine diagnostics, and update status.

**React application:**
- Location: `frontend/src/index.js` and `frontend/src/App.js`.
- Triggers: CRA development server or static frontend deployment loading `frontend/public/index.html`.
- Responsibilities: Mount providers and routes for home, player, community, account, verification, and admin screens.

## Error Handling

**Strategy:** Validate at route, processor, canonical, persistence, and player boundaries; log server failures through `backend/logger.js`; expose user-safe SSE/HTTP messages while retaining detailed server logs.

**Patterns:**
- `backend/routes.js` returns 4xx for malformed/auth/eligibility requests and 5xx JSON for caught database/provider failures.
- `backend/videoProcessor.js` updates `videos.status` to `failed` with a reason, maps common errors to named SSE payloads, removes `backend/temp/<videoId>/`, and releases `processingLocks` in `finally`.
- `backend/modules/canonicalOutput.js` rejects malformed hard failures and quarantines semantically ambiguous candidates; only accepted events reach `scripts`, SSE, or TTS.
- `backend/database.js` wraps multi-row script/quarantine/video writes in transactions and logs/rethrows failures.
- `frontend/src/screens/PlayerScreenV2.js` closes SSE on backend/network errors, announces status via `AccessibilityContext`, and avoids TTS when eligibility metadata is absent.

## Cross-Cutting Concerns

**Logging:** `backend/logger.js` appends KST-dated files under `backend/logs/`, mirrors logs to development stdout, and sends deduplicated error alerts to Telegram when configured.

**Validation:** YouTube URL/ID checks are duplicated in `backend/utils.js` and `frontend/src/screens/HomeScreen.js`; canonical tag/timestamp/provenance/language/duplicate validation is centralized in `backend/modules/canonicalOutput.js`.

**Authentication:** `backend/routes.js` uses JWT bearer tokens for user routes, query-string tokens for SSE compatibility, and a separate database-backed admin password middleware; `frontend/src/contexts/AuthContext.js` persists the JWT in browser `localStorage` and sets Axios defaults.

**Accessibility:** `frontend/src/contexts/AccessibilityContext.js` provides polite/assertive live regions; `frontend/src/hooks.js` manages focus on route changes; player screens expose keyboard controls and screen-reader status announcements.

**Resource cleanup:** `backend/videoProcessor.js` removes per-video temporary media in `finally`; `backend/index.js` removes old nested TTS cache files only when disk usage is at least 70%, on startup and every 24 hours.

---

*Architecture analysis: 2026-08-31*
