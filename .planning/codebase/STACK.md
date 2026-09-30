# Technology Stack

**Analysis Date:** 2026-09-30

## Languages

**Primary:**
- JavaScript/CommonJS backend: `backend/package.json`, `backend/index.js`, `backend/database.js`.
- JavaScript/JSX React browser client: `frontend/package.json`, `frontend/src/`.

**Secondary:**
- SQL embedded in JavaScript: `backend/database.js`, `backend/modules/qaCacheStore.js`, `backend/modules/qaRequestReceipts.js`.
- Bash deployment: `deploy-prod.sh`, `deploy-test.sh`, `deploy-qa.sh`.
- Korean plain-text prompts: `backend/prompt_template_codex_v2.txt`, `backend/prompts/`.

## Runtime

**Environment:**
- Node.js; exact deployed runtime version is not declared in `backend/package.json`.
- Browser JavaScript: `frontend/package.json`.
- Native subprocesses for media: `backend/videoProcessor.js`, `backend/modules/qaMedia.js`.

**Package Manager:**
- npm with separate dependency trees: `backend/package.json`, `frontend/package.json`.
- Lockfiles present: `backend/package-lock.json`, `frontend/package-lock.json`.
- Dependency versions below are manifest ranges, not verified deployed versions.

## Frameworks

**Core:**
- Express `^5.1.0`: API and static audio serving in `backend/index.js`, `backend/routes.js`.
- React/React DOM `^19.1.1`: `frontend/package.json`, `frontend/src/`.
- React Router DOM `^7.9.4`: client navigation dependency in `frontend/package.json`.
- better-sqlite3 `^12.4.1`: synchronous SQLite in `backend/database.js`.

**Testing:**
- Node built-in tests: `backend/tests/`.
- Direct policy checks: `backend/test_audio_language_policy.js`, `backend/test_cli_canonical_output.js`.
- React Scripts/Jest; Testing Library React `^16.3.0`, jest-dom `^6.8.0`: `frontend/package.json`.

**Build/Dev:**
- React Scripts `5.0.1`: browser build/development/tests in `frontend/package.json`.
- patch-package `^8.0.1`: backend postinstall in `backend/package.json`.
- ESLint react-app/react-app-jest configuration: `frontend/package.json`.

## Key Dependencies

**Critical:**
- `@google/generative-ai` `^0.24.1`: description/Q&A/OCR in `backend/videoProcessor.js`, `backend/routes.js`, `backend/utils.js`.
- `@google-cloud/text-to-speech` `^6.3.0`: speech synthesis in `backend/routes.js`, `backend/modules/qaSpeech.js`.
- `googleapis` `^60.0.1`: YouTube Data API in `backend/videoProcessor.js`.
- `jsonwebtoken` `^9.0.3`: JWT auth in `backend/routes.js`.
- `sharp` `^0.35.2`: frame operations in `backend/modules/frameExtraction.js`.

**Infrastructure:**
- yt-dlp executable: download/subtitle operations in `backend/videoProcessor.js`, `backend/modules/qaMedia.js`.
- FFmpeg executable and fluent-ffmpeg `^2.1.3`: `backend/videoProcessor.js`, `backend/modules/qaMedia.js`.
- check-disk-space `^3.4.0`: disk-aware TTS cleanup in `backend/index.js`.
- youtube-sr `^4.3.12`: search in `backend/routes.js`.
- cors `^2.8.5`, dotenv `^17.2.3`: setup in `backend/index.js`.

## Configuration

**Environment:**
- Backend environment file is loaded by `backend/index.js`; inspect source variable names without reading secret contents.
- `YOUTUBE_DESCRIBER_DB_PATH` and `QA_CACHE_ROOT` override persistence/cache locations: `backend/database.js`.
- `GEMINI_MODEL` default is `gemini-3.8-flash`: `backend/videoProcessor.js`.
- `QA_MODEL_NAME` default is `gemini-3.5-flash-lite`: `backend/routes.js`.
- QA flags: `QA_INCREMENTAL_SPEECH_ENABLED`, `QA_OGG_STREAMING_ENABLED`, `QA_CACHE_WARMING_ENABLED`: `backend/modules/qaRoutes.js`, `backend/modules/qaConfig.js`.
- Provider pricing/version and grounding allowance are coded in `backend/modules/geminiCost.js`.

**Build:**
- Independent frontend/backend npm scripts: `frontend/package.json`, `backend/package.json`.
- Frontend development port 3000 and proxy 4000: `frontend/package.json`.
- Backend `PORT` default 4000: `backend/index.js`.

## Platform Requirements

**Development:**
- Node/npm and native SQLite dependency support: `backend/package.json`.
- yt-dlp/FFmpeg on PATH: `backend/index.js`, `backend/modules/qaMedia.js`.
- Google API/TTS access for live calls: `backend/routes.js`, `backend/videoProcessor.js`.
- Isolate persistence tests using `YOUTUBE_DESCRIBER_DB_PATH`: `backend/database.js`.
- Resource limits default to download 3, fullDownload 1, FFmpeg 3, backfill 2, Whisper 3: `backend/modules/mediaResourceLimiter.js`.

**Production:**
- SSH host mom/application root `/app/youtube-describer` and Nginx logs `/var/log/nginx`: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`.
- Main deployment: `deploy-prod.sh`; separate test deployment pushes test and triggers `/home/chacha/deploy-test-app.sh`: `deploy-test.sh`.
- This map describes `/Users/chacha/src/youtube-describer-test` branch test. The collector audited is `/Users/chacha/src/youtube-describer/.agents/skills/analyze_system_stats/scripts/stats_collector.js`. Test source does not prove deployment state.

---

*Stack analysis: 2026-09-30*
