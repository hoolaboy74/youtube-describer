# Architecture

**Analysis Date:** 2026-09-30

## Pattern Overview

**Overall:** React SPA, Express API, synchronous SQLite persistence, filesystem media caches and external model/speech providers.

**Key Characteristics:**
- `frontend/src/App.js` routes video playback to `frontend/src/screens/PlayerScreenV2.js`.
- `backend/routes.js` composes public, authenticated, administrator, description, TTS and Q&A APIs.
- `backend/database.js` owns the shared WAL database connection and additive schema migrations.
- `backend/videoProcessor.js` handles descriptions; `backend/modules/qaGeneration.js` handles interactive streaming questions.

## Layers

**Presentation:**
- Purpose: Accessible playback, accounts, community, administration and Q&A.
- Location: `frontend/src/screens/`, `frontend/src/components/`, `frontend/src/contexts/`.
- Contains: React UI, keyboard controls, auth/accessibility providers.
- Depends on: `frontend/src/hooks/useQaConversation.js`, `frontend/src/services/qaClient.js`, `frontend/src/services/qaAudioController.js`.
- Used by: `frontend/src/App.js`.

**HTTP boundary:**
- Purpose: Request tracking, JWT identity, endpoint validation and JSON/SSE/audio delivery.
- Location: `backend/index.js`, `backend/routes.js`, `backend/modules/qaRoutes.js`.
- Contains: Express middleware and routers.
- Depends on: `backend/database.js`, `backend/videoProcessor.js`, Google clients and Q&A modules.
- Used by: Browser client and reverse proxy.

**Description processing:**
- Purpose: Download media, extract verified frames/language context and persist accepted narration.
- Location: `backend/videoProcessor.js`, `backend/modules/frameExtraction.js`, `backend/modules/audioLanguageDetector.js`, `backend/modules/canonicalOutput.js`.
- Contains: Single/batch processing, deduplication, canonical validation and quarantine.
- Depends on: yt-dlp/FFmpeg, Gemini and `backend/database.js`.
- Used by: Processing endpoints in `backend/routes.js`.

**Interactive Q&A:**
- Purpose: Prepare bounded context, stream answer sentences/audio and account for usage.
- Location: `backend/modules/qaGeneration.js`, `backend/modules/qaSpeech.js`, `backend/modules/qaMedia.js`, `backend/modules/qaContext.js`.
- Contains: Request/event/audio state, durable billing receipts, cache jobs, sentence policy and cancellation.
- Depends on: `backend/modules/qaRequestStore.js`, `backend/modules/qaRequestReceipts.js`, `backend/modules/qaCacheManager.js`, `backend/modules/qaCacheStore.js`.
- Used by: `backend/modules/qaRoutes.js` and `frontend/src/hooks/useQaConversation.js`.

**Persistence:**
- Purpose: Durable service records and reusable media assets.
- Location: `backend/database.js`, `backend/modules/qaCacheStore.js`, `backend/modules/qaRequestReceipts.js`, `backend/modules/qaTtsStore.js`.
- Contains: Video/script/quarantine, accounts/community/finance, API request/cost, Q&A ledgers/receipts/cache tables.
- Depends on: better-sqlite3 and filesystem.
- Used by: Routes, processors, cache workers and reporting.

**Operational reporting:**
- Purpose: Read production SQLite, access/application logs and TTS cache snapshots.
- Location: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`.
- Contains: SSH-executed Node queries/parsers and local text formatter.
- Depends on: `/app/youtube-describer/backend/db/cache.db`, `/var/log/nginx/access.log*`, backend `logs/*.log` and description TTS cache.
- Used by: Monthly reporting workflow in `.agents/skills/analyze_system_stats/SKILL.md`.

## Data Flow

**Description generation:**
1. `backend/routes.js` records arrival and checks access, availability and funds.
2. `backend/videoProcessor.js` persists pending status, downloads media and extracts frames and classified audio/subtitles.
3. `backend/modules/promptPolicy.js` and `backend/modules/canonicalOutput.js` enforce evidence/language/tag/timestamp/duplicate policy.
4. `backend/database.js` writes accepted scripts, quarantined events, status and detailed `api_costs`.
5. `frontend/src/screens/PlayerScreenV2.js` plays compatible scripts; `backend/modules/ttsPolicy.js` gates narrated events.

**Incremental Q&A:**
1. `frontend/src/hooks/useQaConversation.js` submits stable request IDs through `frontend/src/services/qaClient.js`.
2. `backend/modules/qaRequestStore.js` deduplicates requests with durable fingerprints in `backend/modules/qaRequestReceipts.js`.
3. `backend/modules/qaMedia.js` acquires cache-only or prepared context through fenced cache jobs.
4. `backend/modules/qaGeneration.js` bounds model capacity, validates complete sentences and dispatches `backend/modules/qaSpeech.js`.
5. `backend/modules/qaRequestReceipts.js` commits receipt usage and both cost ledgers on the same SQLite connection.
6. `backend/modules/qaRoutes.js` exposes SSE, cancellation and ticketed MP3/Ogg audio; `frontend/src/services/qaAudioController.js` manages playback.

**Operational telemetry:**
1. `backend/routes.js` records user/guest/IP/path on arrival into `api_requests`. This table does not record method, status, latency or response completion.
2. `backend/database.js` writes `api_costs`, `qa_user_daily_costs` and `gemini_monthly_grounding_usage`.
3. `backend/modules/qaRequestReceipts.js` persists lifecycle and billing-confirmation state with epoch-millisecond timestamps.
4. `backend/logger.js` writes KST timestamped daily logs; `backend/modules/qaGeneration.js` emits timing/stage records.
5. `frontend/src/services/qaLatencyTrace.js` keeps browser timings in memory; it is not a durable central telemetry feed.
6. `.agents/skills/analyze_system_stats/scripts/stats_collector.js` collects selected sources into `prod_report/system_stats_report_*.txt`.

**State Management:**
- `backend/database.js`: shared synchronous WAL SQLite connection; `YOUTUBE_DESCRIBER_DB_PATH` overrides its path.
- `backend/modules/qaCacheStore.js`: durable jobs with lease owner/fencing/retry times, frame assets and subtitle provenance/state.
- `backend/modules/qaRequestStore.js`: transient questions, sentences, events and audio. Durable receipts protect against silent paid-job restart but do not persist conversations.
- `frontend/src/contexts/AuthContext.js` and `frontend/src/contexts/AccessibilityContext.js`: client auth/preferences.

## Key Abstractions

**Canonical description event:**
- Purpose: Validated evidence-backed narration with compatible timestamps/tags.
- Examples: `backend/modules/canonicalOutput.js`, `backend/modules/ttsPolicy.js`, `backend/database.js`.
- Pattern: Validate before persistence and speech; reject unsupported/duplicate events into quarantine.

**Cache lease:**
- Purpose: Prevent stale workers from publishing assets.
- Examples: `backend/modules/qaCacheStore.js`, `backend/modules/qaCacheManager.js`.
- Pattern: Verify owner, fencing token and deadline transactionally.

**Paid request receipt:**
- Purpose: Durable idempotency and usage reconciliation.
- Examples: `backend/modules/qaRequestReceipts.js`, `backend/modules/qaRequestStore.js`.
- Pattern: Persist lifecycle/fingerprint separately from transient text/audio; atomically commit receipt and accounting.

## Entry Points

**Backend HTTP:**
- Location: `backend/index.js`.
- Triggers: Node server startup.
- Responsibilities: Database initialization, parsers/proxy settings, static description audio, API mount, yt-dlp support check and audio cleanup.

**Frontend SPA:**
- Location: `frontend/src/index.js`, `frontend/src/App.js`.
- Triggers: Browser startup.
- Responsibilities: Providers, routing and theme.

**Statistics CLI:**
- Location: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`.
- Triggers: Optional start/end date arguments.
- Responsibilities: Remote read queries/log scans and local plain-text report output.

## Error Handling

**Strategy:** Route JSON errors, SSE terminal events, persisted status and file logging.

**Patterns:**
- `backend/modules/qaRoutes.js` wraps promises, returns stable error codes and destroys streams when headers prevent JSON errors.
- `backend/modules/qaGeneration.js` logs failed stages and releases timers/provider capacity.
- `backend/videoProcessor.js` persists failed video state and logs request hashes.
- `backend/modules/qaCacheStore.js` stores retryable failures and rejects stale leases.

## Cross-Cutting Concerns

**Logging:** `backend/logger.js` uses KST log text. `backend/database.js` uses UTC SQLite `CURRENT_TIMESTAMP`; specialized Q&A assets/receipts use epoch milliseconds. Reporting must normalize sources explicitly.

**Validation:** Use `backend/prompt_template_codex_v2.txt` as the language/evidence baseline, with `backend/modules/promptPolicy.js`, `backend/modules/canonicalOutput.js`, `backend/modules/ttsPolicy.js` and `backend/modules/qaSentencePolicy.js` as enforcement boundaries.

**Authentication:** `backend/routes.js` provides JWT and administrator access control. API tracking redacts Q&A audio tickets; avoid raw identities, tokens/tickets and questions in sponsor output.

**Reporting coverage:** `.agents/skills/analyze_system_stats/scripts/stats_collector.js` includes `api_requests` and aggregate `api_costs`. Dedicated Q&A daily costs, receipts, cache jobs/assets, grounding ledger and detailed request-type/token/cost breakdowns are absent. Its video-to-cost latency join includes multiple cost rows and unrelated Q&A charges. File counts and mtime describe surviving cache files, not historical exact TTS hit events.

**Worktree boundaries:** `/Users/chacha/src/youtube-describer-test` is the `test` implementation worktree; `/Users/chacha/src/youtube-describer` is main/production reference. Collector scripts match at inspection time. Do not infer deployment/schema coverage from local `test` code: probe the production database and retained logs before reporting historical statistics.

---

*Architecture analysis: 2026-09-30*
