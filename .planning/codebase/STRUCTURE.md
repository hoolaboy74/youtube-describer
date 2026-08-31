# Codebase Structure

**Analysis Date:** 2026-08-31

## Directory Layout

```text
youtube-describer-test/
├── backend/                         # Node.js/Express service and processing tools
│   ├── index.js                     # Express bootstrap and runtime cleanup
│   ├── routes.js                    # API, auth, SSE, TTS, board, and admin routes
│   ├── database.js                  # SQLite schema, migrations, queries, transactions
│   ├── videoProcessor.js             # Interactive and batch media/AI pipeline
│   ├── modules/                     # Focused policy, detection, and staged-processing helpers
│   ├── prompts/                     # Stage prompt files used by the CLI chain
│   ├── prompt_template_codex_v2.txt # Common canonical policy prompt
│   ├── public/audio/                 # Generated TTS cache served by Express
│   ├── temp/                         # Per-video transient downloads/frames/subtitles
│   ├── db/                           # Runtime SQLite database and WAL sidecars
│   ├── cookies/                      # Runtime YouTube cookie files
│   ├── logs/                         # Runtime application logs
│   ├── bin/                          # POT/cookie helper binaries and scripts
│   └── test_*.js                    # Node built-in and integration test entry points
├── frontend/
│   ├── public/                       # CRA static assets and verification files
│   └── src/                          # React application source
│       ├── App.js                    # Route tree and provider composition
│       ├── index.js                  # React DOM entry point
│       ├── screens/                  # Routed page implementations
│       ├── components/               # Shared layout/navigation/content components
│       ├── contexts/                 # Auth and accessibility providers
│       ├── hooks.js                  # Shared focus hook
│       └── styles/                   # Global CSS
├── docs/                             # Product, operations, integration, and test documentation
├── .planning/                        # GSD state, requirements, roadmap, phases, and codebase maps
├── deploy-prod.sh                    # Production deployment script
├── deploy-test.sh                    # Test deployment script
└── billing.csv                       # Operational billing input
```

## Directory Purposes

**`backend/`:**
- Purpose: Contains the deployable Node.js service, media processing, policy enforcement, persistence, CLI utilities, and backend tests.
- Contains: CommonJS modules, prompt assets, runtime directories, command-line scripts, and integration fixtures.
- Key files: `backend/index.js`, `backend/routes.js`, `backend/database.js`, `backend/videoProcessor.js`, and `backend/logger.js`.

**`backend/modules/`:**
- Purpose: Isolate reusable processing/policy concerns from the large route and processor modules.
- Contains: `canonicalOutput.js`, `promptPolicy.js`, `ttsPolicy.js`, `audioLanguageDetector.js`, `analyzer.js`, `describer.js`, `synchronizer.js`, and `cliCanonicalOutput.js`.
- Key files: Put canonical schema/validation changes in `backend/modules/canonicalOutput.js`; put common prompt resolution in `backend/modules/promptPolicy.js`; put TTS lookup rules in `backend/modules/ttsPolicy.js`.

**`backend/prompts/`:**
- Purpose: Stores stage-specific prompt assets used by the CLI processing chain.
- Contains: `stage1_analyzer.txt`, `stage2_describer.txt`, and `stage3_synchronizer.txt`.
- Key files: Keep the common safety/language baseline in `backend/prompt_template_codex_v2.txt`; stage files should be consumed through `backend/modules/promptPolicy.js` or an explicitly bounded overlay.

**`backend/public/`:**
- Purpose: Holds files exposed by the Express service.
- Contains: The generated `audio/tts_cache/` hierarchy and any public static media.
- Key files: TTS requests in `backend/routes.js` write under `backend/public/audio/tts_cache/`; do not place source media or unvalidated script data here.

**`backend/temp/`, `backend/db/`, `backend/cookies/`, and `backend/logs/`:**
- Purpose: Runtime state for media processing, SQLite, YouTube credentials/cookies, and logs.
- Contains: Per-video transient files, `cache.db`/WAL sidecars, cookie files, and date-named log files.
- Key files: `backend/videoProcessor.js` owns `backend/temp/<videoId>/` cleanup; `backend/database.js` owns the `backend/db/cache.db` default; `backend/logger.js` owns `backend/logs/`.

**`frontend/src/screens/`:**
- Purpose: Routed page-level UI and page-specific API/state logic.
- Contains: `HomeScreen.js`, `PlayerScreenV2.js`, auth/verification pages, board/post pages, account pages, and admin pages, each generally paired with a same-name CSS file.
- Key files: Add new routed pages under `frontend/src/screens/` and register them in `frontend/src/App.js`; use `PlayerScreenV2.js` as the current player reference.

**`frontend/src/components/`:**
- Purpose: Shared visual/layout pieces used across screens.
- Contains: `Layout.js`, `Header.js`, `BottomNav.js`, and `GuideContent.js` with paired CSS files.
- Key files: Put site-wide navigation or repeated content here rather than duplicating it in screens; `frontend/src/components/Layout.js` controls the common header/bottom navigation shell.

**`frontend/src/contexts/`:**
- Purpose: Cross-screen React state providers.
- Contains: `AuthContext.js` for JWT/session state and `AccessibilityContext.js` for live-region announcements.
- Key files: Add genuinely cross-page state here; keep player-only playback state in `frontend/src/screens/PlayerScreenV2.js`.

**`.planning/`:**
- Purpose: Project planning and generated codebase intelligence consumed by GSD planning/execution commands.
- Contains: `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, phase plans/summaries, research, debug notes, and `.planning/codebase/` documents.
- Key files: Architecture decisions are described in `.planning/PROJECT.md`, current execution context in `.planning/STATE.md`, and phase-specific constraints in `.planning/phases/01-canonical-output-provenance-v2-policy/01-CONTEXT.md`.

## Key File Locations

**Entry Points:**
- `backend/index.js`: Node/Express process entry point.
- `backend/process_video_cli.js`: Manual staged processing entry point.
- `frontend/src/index.js`: React DOM entry point.
- `frontend/src/App.js`: Browser route and provider composition.

**Configuration:**
- `backend/package.json`: CommonJS runtime dependencies and `npm start` command.
- `frontend/package.json`: CRA scripts, React dependencies, and development proxy to `http://localhost:4000`.
- `backend/prompt_template_codex_v2.txt`: Common generation policy baseline.
- `backend/database.js`: Default SQLite path, WAL mode, schema creation, additive compatibility migrations, and default settings.
- `.planning/PROJECT.md`: Product architecture constraints and milestone direction.

**Core Logic:**
- `backend/routes.js`: HTTP boundary and request-to-processor wiring.
- `backend/videoProcessor.js`: Media/AI orchestration and interactive/batch convergence.
- `backend/modules/canonicalOutput.js`: Canonical parser/validator and legacy projection.
- `backend/modules/audioLanguageDetector.js`: Four-state audio classification from Whisper samples.
- `backend/database.js`: Video/script persistence and domain data access.
- `frontend/src/screens/PlayerScreenV2.js`: Cached/SSE playback, filtering, scheduling, and identity-bound TTS requests.

**Testing:**
- `backend/test_canonical_output.js`: Canonical parser, validation, duplicate, provenance, and legacy projection fixtures.
- `backend/test_canonical_integration.js`: SQLite migration/persistence, publication parity, quarantine, and TTS boundary fixtures.
- `backend/test_prompt_policy.js`: Common v2 prompt loading/assertion fixtures.
- `backend/test_subtitle_provenance.js` and `backend/test_audio_language_policy.js`: Dialogue/source-language and four-state language-policy fixtures.
- `frontend/src/App.test.js`: CRA/React Testing Library application smoke test; frontend tests are otherwise sparse relative to the screen surface.

## Naming Conventions

**Files:**
- Backend runtime modules use lower camel case, for example `videoProcessor.js`, `audioLanguageDetector.js`, and `promptPolicy.js` in `backend/` and `backend/modules/`.
- React routed pages and reusable components use PascalCase, for example `frontend/src/screens/PlayerScreenV2.js` and `frontend/src/components/BottomNav.js`.
- Stylesheets use the component/page name with `.css`, for example `frontend/src/screens/PlayerScreenV2.css`.
- Backend tests use the `test_*.js` pattern, while the frontend follows CRA’s `*.test.js` pattern, such as `frontend/src/App.test.js`.
- SQL table/column names use snake_case where introduced (`script_quarantine`, `validation_status`, `tts_eligible`), while legacy video/script identifiers retain camelCase (`videoId`, `createdAt`) in `backend/database.js`.

**Directories:**
- Backend capability helpers live in `backend/modules/`; prompt assets live in `backend/prompts/`; runnable helper scripts/binaries live in `backend/bin/`.
- Routed UI belongs in `frontend/src/screens/`; shared UI belongs in `frontend/src/components/`; global React state belongs in `frontend/src/contexts/`.
- Runtime/generated directories are grouped under `backend/db/`, `backend/temp/`, `backend/logs/`, `backend/cookies/`, and `backend/public/audio/`.

## Where to Add New Code

**New Feature:**
- Primary backend route: add the HTTP handler in `backend/routes.js`, keeping request validation/auth at the route boundary and data access in `backend/database.js`.
- Processing behavior: add orchestration in `backend/videoProcessor.js` only when it is part of the main pipeline; extract reusable policy or stage logic into `backend/modules/`.
- Browser route: add the screen under `frontend/src/screens/` and register it in `frontend/src/App.js`.
- Tests: add focused Node fixtures under `backend/test_*.js`; add React Testing Library coverage under `frontend/src/*.test.js` or colocated `*.test.js` files.

**New Component/Module:**
- Shared React component: `frontend/src/components/` with a same-name stylesheet when needed, then import it from screens.
- Cross-cutting React state: `frontend/src/contexts/` only when multiple routes consume it; use `frontend/src/hooks.js` for small shared hooks.
- Backend policy/data transformation: `backend/modules/` with a narrow CommonJS export; keep provider/process spawning at the orchestration boundary unless the helper owns that provider integration.
- New script provenance or validation fields: update `backend/modules/canonicalOutput.js`, then the additive schema/projection in `backend/database.js`, then both player/API consumers.

**Utilities:**
- Shared backend URL, password, verification, and VTT helpers belong in `backend/utils.js`.
- Shared logging belongs in `backend/logger.js`.
- Shared persistence queries belong in `backend/database.js`; do not issue ad hoc SQLite statements from React or route handlers when a domain helper exists.

## Special Directories

**`backend/node_modules/` and `frontend/node_modules/`:**
- Purpose: Installed dependency trees.
- Generated: Yes.
- Committed: No; ignored by the repository rules.

**`frontend/build/`:**
- Purpose: CRA production build output.
- Generated: Yes.
- Committed: No; ignored by `frontend/.gitignore`.

**`backend/db/`:**
- Purpose: Runtime SQLite database, WAL, and shared-memory files.
- Generated: Yes.
- Committed: No; ignored by `.gitignore`.

**`backend/temp/`:**
- Purpose: Per-video downloads, extracted JPEG frames, VTT files, and transient WAVs.
- Generated: Yes.
- Committed: No; cleaned by `backend/videoProcessor.js` and ignored by `.gitignore`.

**`backend/public/audio/tts_cache/`:**
- Purpose: Persistent on-disk MP3 cache addressed by a hashed video/event/voice/format key.
- Generated: Yes.
- Committed: No; served by `backend/index.js`, cleaned by its scheduled disk-pressure routine, and ignored by `.gitignore`.

**`backend/logs/` and `prod_report/`:**
- Purpose: Runtime application logs and generated operational reports.
- Generated: Yes.
- Committed: No; `backend/logger.js` writes logs and `.gitignore` excludes both operational output areas.

**`backend/cookies/`:**
- Purpose: Runtime YouTube authentication/cookie material used by `yt-dlp`.
- Generated: External/runtime-managed.
- Committed: No; treat its contents as sensitive and keep all cookie selection/invalidating logic in `backend/videoProcessor.js` or `backend/bin/` helpers.

---

*Structure analysis: 2026-08-31*
