# External Integrations

**Analysis Date:** 2026-09-30

## APIs & External Services

**Generative AI:**
- Gemini descriptions, Q&A, search grounding and OCR: `backend/videoProcessor.js`, `backend/routes.js`, `backend/modules/qaSearch.js`, `backend/utils.js`.
  - SDK: `@google/generative-ai` in `backend/package.json`.
  - Auth: `GOOGLE_API_KEY`; model overrides `GEMINI_MODEL`, `QA_MODEL_NAME` in `backend/videoProcessor.js`, `backend/routes.js`.

**Audio:**
- Google Cloud TTS synthesizes description and Q&A speech: `backend/routes.js`, `backend/modules/qaSpeech.js`.
  - SDK: `@google-cloud/text-to-speech` in `backend/package.json`; Google client credential discovery.
  - `NODE_EXTRA_CA_CERTS` triggers REST fallback: `backend/routes.js`.
  - Incremental MP3 sentence audio/optional OGG streaming: `backend/modules/qaRoutes.js`, `backend/modules/qaSpeech.js`.

**YouTube:**
- YouTube Data API v3 via googleapis: `backend/videoProcessor.js`; auth `YOUTUBE_API_KEY` falls back to `GOOGLE_API_KEY`.
- youtube-sr search: `backend/routes.js`.
- yt-dlp and FFmpeg download media, subtitles and frame windows: `backend/videoProcessor.js`, `backend/modules/qaMedia.js`.
- Optional `YTDLP_PROXY` and startup impersonation detection: `backend/modules/qaMedia.js`, `backend/index.js`.

**Membership verification:**
- Siloam API: `backend/utils.js`, `backend/routes.js`; config `SILOAM_API_URL`, `SILOAM_API_KEY`, `SILOAM_ORG`, `SILOAM_MOCK`.
- Gemini welfare-card OCR and manual admin approval: `backend/utils.js`, `backend/routes.js`.

## Data Storage

**Databases:**
- SQLite/better-sqlite3, WAL enabled: `backend/database.js`.
  - Connection: `YOUTUBE_DESCRIBER_DB_PATH`, default `backend/db/cache.db`.
  - Core schema: videos, scripts, script_quarantine, users, user_verifications, comments, donations, posts, post_comments, user_watch_histories, user_favorites, settings: `backend/database.js`.
  - `api_requests`: userId, guestId, IP, path and creation timestamp in `backend/database.js`.
  - `api_costs`: detailed call ledger with request_type, user, input/output/thinking/cached/tool tokens, grounding queries, component costs and pricing_version in `backend/database.js`.
  - `qa_user_daily_costs`: user/video/day rollup in `backend/database.js`.
  - `gemini_monthly_grounding_usage`: billing-month search allowance accounting in `backend/database.js`.
  - `qa_cache_jobs`, `qa_frame_assets`, `qa_subtitle_assets`: `backend/modules/qaCacheStore.js`.
  - `qa_request_receipts`: lazy durable request/accounting metadata in `backend/modules/qaRequestReceipts.js`, requested by `backend/routes.js`.
- Receipt timestamps are epoch milliseconds; core SQL defaults use CURRENT_TIMESTAMP: `backend/modules/qaRequestReceipts.js`, `backend/database.js`. Normalize both formats explicitly for reporting.
- Cache lastAccessAt is mutable state, not historical traffic: `backend/modules/qaCacheStore.js`.

**File Storage:**
- Public TTS cache: `backend/public/audio/tts_cache`, served by `backend/index.js`.
- QA frame/subtitle/manifests: `QA_CACHE_ROOT` or `backend/cache/qa` via `backend/database.js`, `backend/modules/qaCacheManager.js`.
- Working media: `backend/videoProcessor.js`, `backend/modules/qaMedia.js`.
- Application daily logs: `backend/logger.js` writes `backend/logs/YYYY-MM-DD.log`.

**Caching:**
- QA cache leases/fencing/retry state persists in SQLite: `backend/modules/qaCacheStore.js`.
- Conversation, SSE events, audio buffers and capability tickets are in memory: `backend/modules/qaRequestStore.js`.
- Legacy answer/TTS capabilities are in memory: `backend/modules/qaTtsStore.js`.
- Receipts retain metadata rather than conversation/sentence events: `backend/modules/qaRequestReceipts.js`. Do not claim historical latency/conversation completeness from receipts.

## Authentication & Identity

**Auth Provider:**
- Custom JWT plus SQLite users: `backend/routes.js`, `backend/database.js`.
- Configure `JWT_SECRET`; source includes a fallback value: `backend/routes.js`.
- Blind verification state/method and verification history: `backend/database.js`.
- API tracker attempts JWT extraction and accepts guest ID header/query: `backend/routes.js`.
- QA audio uses short-lived capability tickets for browser media requests: `backend/modules/qaRoutes.js`, `backend/modules/qaTtsStore.js`.

## Monitoring & Observability

**Error Tracking:**
- Telegram error alerts with repeated-message suppression: `backend/logger.js`.
- Config names `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`; secret values must not appear in maps.

**Logs:**
- KST INFO/WARN/ERROR file records plus development console: `backend/logger.js`.
- API middleware writes activity before response completion: `backend/routes.js`, `backend/database.js`.
- `api_requests` has no method/status/latency/user-agent; it measures tracked requests rather than successful responses: `backend/database.js`.
- Detailed costs and QA daily totals commit atomically with incremental QA receipt accounting: `backend/database.js`, `backend/modules/qaRequestReceipts.js`.

## CI/CD & Deployment

**Hosting:**
- SSH host mom, production root `/app/youtube-describer`: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`.
- Separate main/test/QA entry points: `deploy-prod.sh`, `deploy-test.sh`, `deploy-qa.sh`.

**CI Pipeline:**
- Git push and remote shell deployment: `deploy-prod.sh`, `deploy-test.sh`.
- Hosted CI details: Not detected in inspected deployment entry points.

## Environment Configuration

**Required env vars:**
- Provider access `GOOGLE_API_KEY`, optional `YOUTUBE_API_KEY`: `backend/videoProcessor.js`.
- JWT identity `JWT_SECRET`: `backend/routes.js`.
- Verification `SILOAM_API_URL`, `SILOAM_API_KEY`, optional `SILOAM_ORG`: `backend/utils.js`.
- Persistence `YOUTUBE_DESCRIBER_DB_PATH`, `QA_CACHE_ROOT`: `backend/database.js`.
- Flags `QA_INCREMENTAL_SPEECH_ENABLED`, `QA_CACHE_WARMING_ENABLED`, `QA_OGG_STREAMING_ENABLED`: `backend/modules/qaRoutes.js`, `backend/modules/qaConfig.js`.
- Models/proxy `GEMINI_MODEL`, `QA_MODEL_NAME`, `YTDLP_PROXY`: `backend/videoProcessor.js`, `backend/routes.js`, `backend/modules/qaMedia.js`.

**Secrets location:**
- Backend environment file loaded by `backend/index.js`; contents were not inspected.
- Source variable names suffice; do not expose SSH/provider credential values.

## Webhooks & Callbacks

**Incoming:**
- Browser Q&A SSE/audio/cancel requests: `backend/modules/qaRoutes.js`.
- Provider webhook receivers: Not detected in inspected integration files.

**Outgoing:**
- Telegram alerts: `backend/logger.js`.
- Google/YouTube/Siloam calls: `backend/routes.js`, `backend/videoProcessor.js`, `backend/utils.js`.

## Operational Statistics Coverage

- Current reporting source is the test branch's `.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `stats_core.js`, `stats_activity.js` and `stats_text.js`; the shared monthly skill delegates to this source. Service deployment is not needed for a read-only reporting tool.
- SQLite is opened read-only with a schema manifest covering all 20 current tables; new/unavailable tables and failed queries produce warnings.
- API route/day/user aggregates, QA receipts and usage states, detailed/daily QA ledger reconciliation, description/QA cost separation, token/search/pricing availability and grounding counters are reported without double summing ledgers.
- Activity aggregates include API/core DAU, calendar and rolling-7-day WAU, calendar MAU, repeat-day distributions, comparable-week/month retention and observed new-member onboarding. Internal JSON/TXT contains the requested top ten members' names/emails, per-function counts and registered videos; sponsor HTML/PPTX excludes these identities. Missing historical windows prevent retention rates from being presented as complete.
- Current QA job/lease/frame/subtitle file inventory, script validation/provenance/TTS snapshots, quarantine, verification attempts/decisions and donation income are included.
- KST half-open periods normalize SQLite SQL/ISO UTC dates and receipt epoch milliseconds. Description costs are pre-aggregated before video rankings; recorded cost delay is a proxy, not actual build latency.
- Nginx access/error gzip files and backend QA tagged events are streamed. Production-only PM2 files are inspected, but untimed lines cannot be assigned to a month. Source inventories and missing observed days are exposed.
- Disk/mtime values are current snapshots. Actual play/click/TTS HIT rates and deleted past transitions cannot be reconstructed; unavailable measurements stay null.
- Raw JSON/TXT and sponsor HTML/PPTX share one collection; a manifest binds input SHA-256 and collector SHA-256. Source paths and usage are in `.agents/skills/analyze_system_stats/SKILL.md`.

---

*Integration audit: 2026-09-30*
