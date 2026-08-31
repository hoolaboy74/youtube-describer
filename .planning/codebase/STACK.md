# Technology Stack

**Analysis Date:** 2026-08-31

## Languages

**Primary:**
- JavaScript (CommonJS) - Node.js/Express API, SQLite access, media processing orchestration, AI calls, authentication, and operational scripts in `backend/`.
- JavaScript (JSX) - React browser application, routing, player controls, authentication state, and accessibility UI in `frontend/src/`.

**Secondary:**
- TypeScript - A single Deno-compatible YouTube PO-token helper in `backend/get_pot.ts`; there is no repository TypeScript compiler configuration.
- Python - Used as an external `yt_dlp` module entry point by `backend/process_video_cli.js` and as a Whisper setup/cookie utility in `backend/setup_whisper_server.sh` and `backend/bin/server-refresh-cookies.py`; no Python dependency manifest is present.
- POSIX shell - Whisper environment setup and Git/deployment helpers in `backend/setup_whisper_server.sh`, `deploy-prod.sh`, and `deploy-test.sh`.

## Runtime

**Environment:**
- Node.js - The backend is CommonJS (`"type": "commonjs"`) and starts with `node index.js` from `backend/package.json`; no `.nvmrc` or Node version file is present. The mapping environment reports Node.js v24.7.0.
- Browser runtime - The frontend is a Create React App bundle targeting current Chrome, Firefox, and Safari versions configured in `frontend/package.json`.
- Python 3 - CLI/test workflows invoke `python3 -m yt_dlp`; no pinned version is declared. The mapping environment reports Python 3.9.6, while its resolved `yt-dlp` checkout currently requires Python 3.10 or newer.
- Deno - `backend/videoProcessor.js` spawns `deno run` for `backend/get_pot.ts`; no Deno version is pinned. The mapping environment reports Deno 2.9.5.

**Package Manager:**
- npm - Dependencies are managed independently for `backend/` and `frontend/` through `backend/package.json` and `frontend/package.json`.
- Lockfiles: present as `backend/package-lock.json` and `frontend/package-lock.json`, both lockfile version 3; no root `package.json` or root lockfile is present.

## Frameworks

**Core:**
- Express 5.1.0 - HTTP API, middleware, SSE generation endpoint, JSON parsing, and static TTS audio serving in `backend/index.js` and `backend/routes.js`.
- React 19.x - Browser UI, player, authentication, community pages, admin UI, and accessibility contexts in `frontend/src/`; the lockfile resolves React and React DOM to 19.2.0 while `frontend/package.json` declares `^19.1.1`.
- Create React App / `react-scripts` 5.0.1 - Frontend development server, Jest test runner, Babel/Webpack build, and production bundle in `frontend/package.json`.
- React Router DOM 7.9.4 - Client-side routes declared in `frontend/src/App.js`.

**Testing:**
- Jest through Create React App - Browser test runner exposed by `frontend/package.json` and used by `frontend/src/App.test.js`.
- React Testing Library 16.3.0, DOM Testing Library 10.4.1, Jest DOM 6.9.1, and User Event 13.5.0 - Frontend component and interaction test dependencies in `frontend/package.json` and `frontend/src/setupTests.js`.
- Node built-in test runner/assertions - Backend deterministic tests use `node:test` and `node:assert/strict`, for example `backend/test_canonical_output.js` and `backend/test_canonical_integration.js`.

**Build/Dev:**
- CRA development server - `npm start` serves the frontend on port 3000 and proxies `/api` to `http://localhost:4000` through `frontend/package.json`.
- CRA production build - `npm run build` writes the static frontend bundle to `frontend/build/`, as documented in `frontend/README.md`.
- Node process start - `npm start` runs `node index.js` from `backend/package.json`; `backend/index.js` defaults the API port to 4000.
- `patch-package` 8.0.1 - Runs after backend install and applies `backend/patches/youtube-sr+4.3.12.patch`.

## Key Dependencies

**Critical:**
- `@google/generative-ai` 0.24.1 - Gemini multimodal/text generation in `backend/videoProcessor.js`, `backend/modules/analyzer.js`, `backend/modules/describer.js`, `backend/modules/synchronizer.js`, and `backend/utils.js`.
- `@google-cloud/text-to-speech` 6.3.0 - Korean MP3 synthesis in `backend/routes.js` and sample-voice generation in `backend/generate_samples.js`.
- `googleapis` 60.0.1 - YouTube Data API v3 metadata lookup in `backend/videoProcessor.js`.
- `better-sqlite3` 12.4.1 - Synchronous SQLite persistence, WAL mode, additive schema initialization, canonical scripts, users, costs, and community data in `backend/database.js`.
- `youtube-sr` 4.3.12 - YouTube search results in `backend/routes.js`; it is patched by `backend/patches/youtube-sr+4.3.12.patch`.
- `axios` 1.12.2 - Frontend REST calls for scripts, processing-adjacent data, TTS, auth, user pages, comments, and admin pages throughout `frontend/src/`.
- `react-youtube` 10.1.0 - Embedded YouTube player and player state/control bridge in `frontend/src/screens/PlayerScreenV2.js`.

**Infrastructure:**
- `fluent-ffmpeg` 2.1.3 - FFmpeg wrapper used by legacy/CLI workflows such as `backend/run_batch_single_hybrid.js` and `backend/run_batch_single_subtitle.js`; the current API processor invokes the `ffmpeg` executable directly.
- `node-vad` 1.1.4 and `wav` 1.0.2 - Voice activity detection and WAV parsing in legacy batch/benchmark scripts such as `backend/run_batch_single_hybrid.js`.
- `check-disk-space` 3.4.0 - Startup and daily TTS-cache disk usage checks in `backend/index.js`.
- `cors` 2.8.5 - Broad CORS middleware in `backend/index.js`.
- `dotenv` 17.2.3 - Loads `backend/.env` in the server and selected CLI/test scripts, including `backend/index.js` and `backend/process_video_cli.js`.
- `jsonwebtoken` 9.0.3 - Stateless user JWT creation/verification in `backend/routes.js`.
- `patch-package` 8.0.1 - Postinstall patch application in `backend/package.json`.
- `http-proxy-middleware` 3.0.5 - Declared in `frontend/package.json` for the CRA proxy dependency tree; no direct source import is present.
- `puppeteer` 24.26.1 and `ytdl-core` 4.11.5 - Declared backend dependencies with no direct source import detected in the current repository.

## Configuration

**Environment:**
- Backend configuration is loaded from the existing `backend/.env` and `backend/.env.bak` files; their contents are intentionally not read or documented because they are secret-bearing environment files.
- Google/model settings use `GOOGLE_API_KEY`, `YOUTUBE_API_KEY`, `GEMINI_MODEL`, and `PROMPT_FILE` in `backend/videoProcessor.js`, `backend/modules/promptPolicy.js`, `backend/modules/analyzer.js`, and `backend/modules/describer.js`.
- Media settings use `WHISPER_BIN`, `WHISPER_MODEL`, `WHISPER_THREADS`, `WHISPER_TIMEOUT_MS`, and `YTDLP_PROXY` in `backend/modules/audioLanguageDetector.js` and `backend/videoProcessor.js`.
- Runtime/storage settings use `PORT`, `NODE_ENV`, `NODE_EXTRA_CA_CERTS`, and `YOUTUBE_DESCRIBER_DB_PATH` in `backend/index.js`, `backend/routes.js`, and `backend/database.js`.
- Authentication/verification/alert settings use `JWT_SECRET`, `SILOAM_MOCK`, `SILOAM_API_URL`, `SILOAM_API_KEY`, `SILOAM_ORG`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` in `backend/routes.js`, `backend/utils.js`, and `backend/logger.js`.
- Frontend API configuration uses `REACT_APP_API_URL` and `NODE_ENV` in `frontend/src/contexts/AuthContext.js`, `frontend/src/screens/PlayerScreenV2.js`, and `frontend/src/Admin.js`.
- Credential files, cookie files, local databases, logs, temporary media, and audio caches are ignored by `.gitignore`; `backend/cookies/`, `backend/db/`, `backend/logs/`, `backend/temp/`, and `backend/public/audio/` are runtime data locations.

**Build:**
- `backend/package.json` defines `start`, `test` (placeholder failure command), `clear-cache`, and `postinstall` scripts.
- `frontend/package.json` defines `start`, `build`, `test`, `eject`, and `lint` scripts; linting runs ESLint through CRA with zero warnings allowed.
- `backend/prompt_template_codex_v2.txt` is the common policy prompt loaded and validated by `backend/modules/promptPolicy.js`; `backend/prompts/` contains the staged CLI prompt assets.
- No Dockerfile, compose file, CI workflow, Makefile, or checked-in Nginx/PM2 configuration is present.

## Platform Requirements

**Development:**
- Node.js and npm for both package roots, with `npm install` run separately in `backend/` and `frontend/` as implied by the two manifests.
- System `ffmpeg` and `ffprobe` for frame/audio extraction; the current API path spawns them from `backend/videoProcessor.js` and `backend/modules/audioLanguageDetector.js`.
- System `yt-dlp` with the repository plugin directory `backend/yt_dlp_plugins`; CLI scripts may instead invoke a Python `yt_dlp` module.
- A built whisper.cpp `whisper-cli` binary and model, normally under `/home/chacha/whisper.cpp`, as configured by `backend/modules/audioLanguageDetector.js` and prepared by `backend/setup_whisper_server.sh`.
- Deno for the YouTube PO-token helper `backend/get_pot.ts` and Google credentials/API access for generation, TTS, YouTube metadata, and optional identity verification.

**Production:**
- Repository deployment documentation targets a Google Cloud Platform Ubuntu ARM server with Nginx serving `frontend/build/`, reverse proxying `/api` to Node, and PM2 supervising the backend; this is specified in `docs/technical_specs.md` and `docs/deploy_plan.txt`, not in checked-in infrastructure configuration.
- The backend listens on `PORT` (default 4000); deployment documentation contains an older 8080 reverse-proxy example, so the deployed Nginx/PM2 port must match the runtime environment.
- HTTPS termination and certificate renewal are documented through Nginx/Certbot in `docs/technical_specs.md`; no certificate or private-key files are committed.

---

*Stack analysis: 2026-08-31*
