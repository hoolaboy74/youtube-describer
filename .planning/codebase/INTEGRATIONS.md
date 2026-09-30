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

- Collector audited: `/Users/chacha/src/youtube-describer/.agents/skills/analyze_system_stats/scripts/stats_collector.js`; map source: `/Users/chacha/src/youtube-describer-test` branch test. Production schema and deployed source hashes have been verified against main; test-only additions still require separate deployment checks.
- Collector reads legacy api_costs totals/model image/text tokens, without request_type or component token/cost breakdown: `/Users/chacha/src/youtube-describer/.agents/skills/analyze_system_stats/scripts/stats_collector.js`.
- Collector reads api_requests for IP/time member correlation, but does not summarize endpoint activity, member/guest request volume, or Q&A usage from that table: `/Users/chacha/src/youtube-describer/.agents/skills/analyze_system_stats/scripts/stats_collector.js`.
- Collector omits qa_user_daily_costs, gemini_monthly_grounding_usage, QA cache tables and request receipts: `/Users/chacha/src/youtube-describer/.agents/skills/analyze_system_stats/scripts/stats_collector.js`.
- Direct video-to-cost joins multiply ranking video counts/durations when a video has multiple calls; cost creation time does not establish description completion latency: `/Users/chacha/src/youtube-describer/.agents/skills/analyze_system_stats/scripts/stats_collector.js`.
- Current disk/cache state cannot reconstruct deleted monthly assets: `/Users/chacha/src/youtube-describer/.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `backend/index.js`.
- Skill/comments claim registration lower-bound enforcement, but inspected collector uses requested start or 1970: `/Users/chacha/src/youtube-describer/.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `.agents/skills/analyze_system_stats/SKILL.md`.
- SQLite CURRENT_TIMESTAMP is UTC; logger emits KST; collector uses plain SQL date bounds. Align monthly boundaries: `backend/database.js`, `backend/logger.js`, `/Users/chacha/src/youtube-describer/.agents/skills/analyze_system_stats/scripts/stats_collector.js`.

---

*Integration audit: 2026-09-30*
