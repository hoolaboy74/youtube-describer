# Codebase Structure

**Analysis Date:** 2026-09-30

## Directory Layout

```text
youtube-describer-test/
├── backend/                  # Express and SQLite service
│   ├── modules/              # Policy, Q&A, caches, costs and resource bounds
│   ├── tests/                # Deterministic Node tests and fixtures
│   ├── db/                   # Runtime SQLite database
│   ├── logs/                 # Daily KST application logs
│   ├── cache/                # Runtime Q&A media assets
│   ├── public/audio/         # Speech caches
│   └── temp/                 # Processing intermediates
├── frontend/src/             # React application
│   ├── screens/              # Active routed screens
│   ├── components/           # Shared navigation/layout
│   ├── contexts/             # Auth/accessibility providers
│   ├── hooks/                # Q&A conversation state
│   └── services/             # Transport, audio and client timing
├── .agents/skills/           # Production statistics/user tracing workflows
├── .planning/                # Milestone and codebase reference
├── test_scripts/             # Model/media/latency experiments
├── prod_report/              # Statistics and sponsor artifacts
└── deploy-*.sh               # Deployment workflows
```

## Directory Purposes

**Backend service:**
- Purpose: APIs, narration, Q&A, accounts/community/admin and persistence.
- Contains: CommonJS source, text prompts, external tool adapters and runtime directories.
- Key files: `backend/index.js`, `backend/routes.js`, `backend/database.js`, `backend/videoProcessor.js`, `backend/logger.js`, `backend/utils.js`.

**Backend modules:**
- Purpose: Focused policy, billing, resource and Q&A units.
- Contains: `backend/modules/canonicalOutput.js`, `backend/modules/promptPolicy.js`, `backend/modules/ttsPolicy.js`, `backend/modules/geminiCost.js`, `backend/modules/mediaResourceLimiter.js`, `backend/modules/mediaDiskBudget.js`.
- Key files: `backend/modules/qaRoutes.js`, `backend/modules/qaGeneration.js`, `backend/modules/qaSpeech.js`, `backend/modules/qaRequestStore.js`, `backend/modules/qaRequestReceipts.js`, `backend/modules/qaMedia.js`, `backend/modules/qaCacheManager.js`, `backend/modules/qaCacheStore.js`, `backend/modules/qaContext.js`, `backend/modules/qaSearch.js`, `backend/modules/qaTtsStore.js`.

**Frontend application:**
- Purpose: Accessible screens, playback and question answering.
- Contains: `frontend/src/screens/`, `frontend/src/components/`, `frontend/src/contexts/`, `frontend/src/hooks/`, `frontend/src/services/`.
- Key files: `frontend/src/App.js`, `frontend/src/screens/PlayerScreenV2.js`, `frontend/src/screens/Admin.js`, `frontend/src/hooks/useQaConversation.js`, `frontend/src/services/qaClient.js`, `frontend/src/services/qaAudioController.js`.
- Routing rule: Follow `frontend/src/App.js`; similarly named top-level screens are not the active video route target.

**Project skills:**
- Purpose: Operational analysis against server `mom`.
- Contains: `.agents/skills/analyze_system_stats/`, `.agents/skills/trace_user_activity/`.
- Key files: `.agents/skills/analyze_system_stats/SKILL.md`, `.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `.agents/skills/trace_user_activity/SKILL.md`, `.agents/skills/trace_user_activity/scripts/trace_user.js`.
- Workflow rule: Preserve plain-text screen-reader readability. Check collector implementation date filtering rather than assuming the skill description matches its current default/start limit.

## Key File Locations

**Entry Points:**
- `backend/index.js`: Server and database startup, static audio and cleanup.
- `backend/routes.js`: API composition, JWT and arrival tracker, legacy Q&A.
- `backend/modules/qaRoutes.js`: Incremental requests/events/audio/cancel routes.
- `frontend/src/index.js`, `frontend/src/App.js`: SPA initialization and routing.
- `.agents/skills/analyze_system_stats/scripts/stats_collector.js`: Production statistics CLI.

**Configuration:**
- `backend/package.json`, `frontend/package.json`: Dependency and run/build/test manifests.
- `backend/modules/qaConfig.js`: Q&A defaults and feature configuration.
- `backend/prompt_template_codex_v2.txt`: Shared language/evidence safety baseline.
- `backend/prompt_template_writer_v13.txt`: Generation prompt artifact.
- `deploy-prod.sh`, `deploy-test.sh`, `deploy-qa.sh`: Deployment routines; inspect target paths before execution.
- `backend/.env`: Runtime environment configuration if present; do not read secret contents.

**Core Logic:**
- `backend/database.js`: Base schemas, `api_requests`, detailed `api_costs`, `qa_user_daily_costs` and grounding usage.
- `backend/modules/qaRequestReceipts.js`: `qa_request_receipts` and atomic usage accounting.
- `backend/modules/qaCacheStore.js`: `qa_cache_jobs`, `qa_frame_assets`, `qa_subtitle_assets` and fenced registration.
- `backend/videoProcessor.js`: Description single/batch processing and media extraction.
- `backend/modules/canonicalOutput.js`: Parser, timestamp/duplicate/provenance policy.
- `backend/modules/qaGeneration.js`: Streaming orchestration and backend stage timing.
- `backend/modules/qaSpeech.js`: Sentence synthesis and continuous audio.
- `backend/logger.js`: KST daily logs and optional alerting.
- `frontend/src/services/qaLatencyTrace.js`: Browser-memory timing, not centrally persisted telemetry.

**Testing:**
- `backend/tests/qaRequestReceipts.test.js`: Receipt/idempotent accounting behavior.
- `backend/tests/qaCacheManager.test.js`, `backend/tests/qaMedia.test.js`: Cache/media contracts.
- `backend/tests/qaIncremental.test.js`, `backend/tests/qaStreaming.test.js`, `backend/tests/qaRoutes.test.js`: Streaming transport/lifecycle.
- `backend/tests/geminiCost.test.js`: Pricing and billing components.
- `backend/test_canonical_output.js`, `backend/test_audio_language_policy.js`, `backend/test_prompt_policy.js`: Description safety.
- `frontend/src/services/qaClient.test.js`, `frontend/src/services/qaAudioController.test.js`, `frontend/src/hooks/useQaConversation.test.js`: Client lifecycle.
- `test_scripts/qa_latency_benchmark.js`, `test_scripts/qa_download_benchmark.js`: Benchmarks; keep fixture measurements distinct from production observations.

## Naming Conventions

**Files:**
- Backend focused modules use camelCase: `backend/modules/qaCacheManager.js`.
- React screens/components use PascalCase: `frontend/src/screens/PlayerScreenV2.js`.
- Tests use `.test.js`: `backend/tests/qaRequestReceipts.test.js`.
- CLI experiments use underscores: `test_scripts/qa_latency_benchmark.js`.
- Reference docs use uppercase Markdown: `.planning/codebase/ARCHITECTURE.md`.

**Directories:**
- `backend/modules/` contains service modules without a separate ORM/repository tree.
- `frontend/src/screens/` contains routed UI; `frontend/src/services/` contains transport/audio.
- `.agents/skills/<skill>/scripts/` contains operational script implementations.

## Where to Add New Code

**New Feature:**
- Backend implementation: `backend/modules/`, composed through `backend/routes.js` or `backend/modules/qaRoutes.js`.
- Base migrations: `backend/database.js`; specialized migrations follow `backend/modules/qaCacheStore.js` and `backend/modules/qaRequestReceipts.js` using the shared connection.
- Frontend screens: `frontend/src/screens/`, registered in `frontend/src/App.js`.
- Tests: `backend/tests/`, or adjacent frontend service/hook tests.

**New Component/Module:**
- UI: `frontend/src/components/`.
- React orchestration: `frontend/src/hooks/`.
- Q&A transport/audio: `frontend/src/services/`.
- Backend resource/media/policy units: `backend/modules/`.

**Utilities:**
- Legacy helpers: `backend/utils.js`; prefer focused `backend/modules/` units for new behavior.
- Reporting extraction: `.agents/skills/analyze_system_stats/scripts/`; distinguish durable events, snapshots and estimates.
- Report artifacts: `prod_report/`; milestone source changes belong in `/Users/chacha/src/youtube-describer-test` on `test`.

## Special Directories

**Planning:**
- Purpose: `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/phases/`, `.planning/quick/` and `.planning/codebase/` specify work and verification.
- Generated: Mixed authored/planning artifacts.
- Committed: Planning documents are versioned; preserve unrelated edits.

**Runtime persistence:**
- Purpose: `backend/db/`, `backend/logs/` and production `/app/youtube-describer/backend/db/cache.db` contain operational records.
- Generated: Yes.
- Committed: Treat as runtime artifacts; do not add live user records/logs to source commits.

**Media/speech caches:**
- Purpose: `backend/cache/qa/`, `backend/temp/`, `backend/public/audio/tts_cache/`, `backend/public/audio/qa_tts_cache/` and configurable Q&A TTS storage hold frames/subtitles/audio.
- Generated: Yes.
- Committed: Runtime artifacts; cache roots may be configured.
- Reporting rule: File counts/mtime describe surviving files at collection time, not exact historical events or hits.

**Report output:**
- Purpose: `prod_report/` contains statistics text and sponsor HTML/decks.
- Generated: Yes.
- Committed: Depends on artifact; sponsor output must not expose raw identities/IPs.

**Main reference worktree:**
- Purpose: `/Users/chacha/src/youtube-describer` provides main/production source and example reports.
- Generated: No.
- Committed: Separate Git worktree; inspect read-only while mapping `test`. Validate deployed schemas independently.

---

*Structure analysis: 2026-09-30*
