# Codebase Structure

**Analysis Date:** 2026-08-18

## Directory Layout

```text
youtube-describer/
├── .planning/       # Architecture maps, conventions, and codebase specifications
├── backend/         # Express server, SQLite database, business logic, and scripts
│   ├── bin/         # Pre-compiled platforms binary engines (e.g., bgutil POT solver)
│   ├── cookies/     # YouTube session cookie files for yt-dlp authentication
│   ├── db/          # SQLite database storage directory
│   ├── logs/        # Server log files organized by KST dates
│   ├── modules/     # Custom pipeline modules (language detector, analyzer, describer, synchronizer)
│   ├── patches/     # npm package patches applied during postinstall
│   ├── prompts/     # Templates and reference texts for LLM prompts
│   ├── public/      # Public-facing static resources (e.g., cached TTS audio)
│   ├── temp/        # Temporary folders created during video-frame processing
│   └── yt_dlp_plugins/ # Custom plugin hook directories for yt-dlp
└── frontend/        # React single page application files
    ├── public/      # Frontend public templates, logos, and manifest configs
    └── src/         # React source folder
        ├── components/ # Shared react elements (layout headers, bottom nav)
        ├── contexts/  # React contexts (accessibility state, authentication state)
        ├── screens/   # Main app screens (PlayerScreen, HomeScreen, BoardScreen)
        └── styles/    # CSS stylesheet folders
```

## Directory Purposes

**`backend/`:**
- Purpose: Houses the Node.js Express server codebase, database integration schemas, deployment scripts, and automation tasks.
- Contains: Express server configuration, CLI execution wrappers, database models.
- Key files: `backend/index.js`, `backend/routes.js`, `backend/database.js`, `backend/videoProcessor.js`.

**`backend/modules/`:**
- Purpose: Contains modular subsystems invoked during video downloading, frame parsing, language classifying, and transcription alignment.
- Contains: Independent JavaScript modules.
- Key files: `backend/modules/audioLanguageDetector.js`, `backend/modules/describer.js`, `backend/modules/analyzer.js`, `backend/modules/synchronizer.js`.

**`backend/cookies/`:**
- Purpose: Stores YouTube session cookie files (in Netscape format) to authenticates requests, bypass bot filters, and bypass age restriction screens.
- Contains: Secret token text files ending in `_cookies.txt`.
- Key files: `backend/cookies/c7861967_cookies.txt`, `backend/cookies/hoolaboy_cookies.txt`.

**`frontend/src/screens/`:**
- Purpose: Contains pages/screens rendered by the React Client App.
- Contains: JavaScript component files and their matching CSS stylesheet files.
- Key files: `frontend/src/screens/HomeScreen.js`, `frontend/src/screens/PlayerScreenV2.js`, `frontend/src/screens/Admin.js`.

**`frontend/src/contexts/`:**
- Purpose: Manages globally shared states (accessibility screen reader options, authentication logs) that are consumed by various app components.
- Contains: React context creators.
- Key files: `frontend/src/contexts/AuthContext.js`, `frontend/src/contexts/AccessibilityContext.js`.

## Key File Locations

**Entry Points:**
- `backend/index.js`: Exposes the web listener port, launches crons, and serves static files.
- `backend/process_video_cli.js`: Off-line processor command script for manual/batch administrative requests.
- `frontend/src/index.js`: Mounts React DOM tree to template layout index page.

**Configuration:**
- `backend/.env`: Encapsulates environment configurations (Google AI credentials, API URLs, local server ports).
- `backend/package.json`: Defines backend package requirements and execution script commands.
- `frontend/package.json`: Holds UI framework dependencies, proxy targets, and build scripts.

**Core Logic:**
- `backend/videoProcessor.js`: Orchestrates downloads, extracts keyframes, sends prompts to Gemini, and updates database records.
- `backend/routes.js`: Maps REST APIs, manages EventSource streams, runs JWT authentication, and tracks API request volumes.
- `backend/database.js`: Runs DDL statements, handles sqlite connections, manages migrations, and handles transactions.
- `frontend/src/screens/PlayerScreenV2.js`: Synchronizes YouTube embeds with streamed description cues, plays cached TTS audio, and ducks video volume.

**Testing:**
- `backend/test_full_workflow.js`: Simulates a complete download-to-script workflow.
- `backend/test_tts.js`: Synthesizes speech manually and verifies that the output caching is valid.
- `backend/test_whisper_concurrency.js`: Benchmarks concurrent language classifier pipelines under load.
- `frontend/src/App.test.js`: Simple unit test verifying React tree render success.

## Naming Conventions

**Files:**
- Backend logic files: CamelCase or kebab-case (e.g., `videoProcessor.js`, `clear-cache.js`).
- Backend pipeline modules: camelCase (e.g., `audioLanguageDetector.js`).
- Frontend screen/component view files: PascalCase (e.g., `PlayerScreenV2.js`, `Layout.js`).
- Frontend stylesheet sheets: PascalCase matching the component name (e.g., `PlayerScreenV2.css`).
- Cookies: lowercase prefix followed by `_cookies.txt` (e.g., `momcenter1_cookies.txt`).

**Directories:**
- Storage directories (backend): Plural lowercase words (e.g., `cookies`, `logs`, `prompts`, `patches`).
- Core folders: Short singular words (e.g., `db`, `bin`, `temp`).
- React source directories: Lowercase semantic category naming (e.g., `components`, `contexts`, `screens`, `styles`).

## Where to Add New Code

**New Feature:**
- Primary code: Backend endpoints go to `backend/routes.js`, business operations go to `backend/videoProcessor.js`, and React pages go to `frontend/src/screens/`.
- Tests: Integration test scripts go to the `backend/` root directory (e.g., `backend/test_[feature].js`).

**New Component/Module:**
- Implementation: Custom Node components go to `backend/modules/`, while frontend UI items go to `frontend/src/components/`.

**Utilities:**
- Shared helpers: Helper functions go to `backend/utils.js` or `frontend/src/hooks.js`.

## Special Directories

**`backend/db/`:**
- Purpose: Stores the SQLite database file (`cache.db`).
- Generated: Yes. Created automatically on first server boot.
- Committed: No. Ignored in `.gitignore` to prevent leaking production statistics.

**`backend/temp/`:**
- Purpose: Serves as a workspace for raw video downloads and keyframe picture grids.
- Generated: Yes. Dynamically generated when a processing job is active.
- Committed: No. Automatically deleted on success/failure and ignored in Git.

**`backend/public/audio/tts_cache/`:**
- Purpose: Caches Google TTS voice audio files using unique hashed filenames.
- Generated: Yes. Generated dynamically during client playback queries.
- Committed: No. Ignored in Git.

**`backend/logs/`:**
- Purpose: Contains log files named with the date (KST time).
- Generated: Yes. Created dynamically by the server logger.
- Committed: No. Ignored in Git.

---

*Structure analysis: 2026-08-18*
