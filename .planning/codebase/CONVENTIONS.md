# Coding Conventions

**Analysis Date:** 2026-08-18

## Naming Patterns

**Files:**
- Backend: Uses a mix of kebab-case, snake_case, and camelCase for modules and scripts (e.g., `clear-cache.js`, `delete-video.js`, `generate_samples.js`, `videoProcessor.js`). Verification and test scripts are typically prefixed with `test_` or `run_` (e.g., `test_tts.js`, `run_comparison_test.js`).
- Frontend: Screen, component, and context files use PascalCase (e.g., `HomeScreen.js`, `BottomNav.js`, `AccessibilityContext.js`). General utility scripts and configuration files use camelCase (e.g., `hooks.js`, `reportWebVitals.js`, `setupTests.js`).

**Functions:**
- Lower camelCase is standard across both frontend and backend files (e.g., `init`, `cleanupOldFiles`, `trackApiRequest`, `parseVttToDialogueTrack`).

**Variables:**
- Lower camelCase is standard for in-memory variables and constants (e.g., `publicDir`, `audioCacheDir`, `usagePercent`, `firstLevelDirs`).
- Database schema attributes use a mix of camelCase (e.g., `videoId`, `createdAt`, `userId`) and snake_case (e.g., `fail_reason`, `is_featured`, `is_notice`, `blind_auth_method`).

**Types:**
- The project is written in JavaScript, so there are no static type definitions. A Deno script `get_pot.ts` is named with a `.ts` extension but contains vanilla JS syntax with Deno's runtime APIs.

## Code Style

**Formatting:**
- Indentation: 4 spaces is the project standard for both React and Express code.
- Quotes: Uses single quotes for module imports/requires and standard string literals, and double quotes for UI logs, error messages, and JSX attributes. No Prettier configuration file exists in the repository.

**Linting:**
- Tool: ESLint is configured in the frontend application.
- Key settings: Extends `react-app` and `react-app/jest` inside `frontend/package.json`. A frontend lint script is provided: `"lint": "eslint src --max-warnings 0"`. No ESLint config exists for the backend.

## Import Organization

**Order:**
1. Built-in Node.js modules or Core React packages (e.g., `path`, `fs`, `crypto` in backend; `react` hooks in frontend).
2. Third-party dependencies (e.g., `express`, `better-sqlite3`, `@google/generative-ai` in backend; `axios`, `react-router-dom` in frontend).
3. Local modules, contexts, hooks, and helpers (e.g., `require('./database')`, `import { useAuth } from '../contexts/AuthContext'`).
4. Static assets and stylesheet files (e.g., `import './PlayerScreen.css'`).

**Path Aliases:**
- None. Absolute paths and aliases are not configured. The codebase relies entirely on standard relative path resolution (e.g., `require('./logger')`, `import Layout from './components/Layout'`).

## Error Handling

**Patterns:**
- Backend: Uses `try...catch` blocks inside all async middleware, database operations, and route controllers. Caught errors are logged to the file system via a custom logger and returned as JSON with descriptive messages and relevant HTTP status codes (e.g., 400 for bad parameters, 404 for missing resources, and 500 for runtime failures).
```javascript
try {
    const videoData = db.getVideo(videoId);
    if (videoData) {
        res.json(videoData);
    } else {
        res.status(404).json({ error: 'Script not found for the given video ID' });
    }
} catch (error) {
    logger.error(`Failed to fetch script for videoId ${videoId}:`, error);
    res.status(500).json({ error: 'Failed to fetch script' });
}
```
- Frontend: Network requests made via Axios are wrapped in `try...catch` or handled using `.catch()`. Caught errors are saved in state (e.g., `setError(err.message)`) to be displayed as accessible inline alerts or fallback messages, and printed to the console using `console.error`.

## Logging

**Framework:** Custom logging wrapper `backend/logger.js` that appends logs to daily files and dispatches Telegram notifications.

**Patterns:**
- Daily Logs: Saved to `backend/logs/YYYY-MM-DD.log` using KST timestamps (e.g., `[2026-08-18 16:56:56] [INFO] ...`).
- Console Logging: Prints output to the console when `NODE_ENV` is not `'production'`.
- Error Alerts: Caught errors categorized as `error` level automatically trigger a Telegram bot alert. Alerts are deduplicated within a 10-second window to prevent flooding.

## Comments

**When to Comment:**
- Comments are written primarily in Korean and explain specific business logic, hardware/VM configurations (e.g., Whisper threads, CPU scheduling limits), and workarounds for external API limits (e.g., yt-dlp cookie rollover logic, BotGuard bypasses, POT token providers).

**JSDoc/TSDoc:**
- Simple multi-line comments are used at the top of standalone scripts to document the script's overall features, CLI usage, parameters, and outputs.

## Function Design

**Size:**
- Utility and helper functions are small and focused (e.g., time formatting, database helpers). Core processing pipelines (e.g., `processVideo`, `processVideoBatch`) are monolithic and large (ranging from 100 to 500+ lines of code) in order to keep the multi-step video download, extraction, audio detection, and AI streaming process sequential and readable.

**Parameters:**
- Core processing functions accept a single structured configuration object (e.g., `{ tempVideoPath, tempVideoFilename, baseTempDir, totalDuration, requestHash }`) to avoid long parameter lists and ease extendability.

**Return Values:**
- Standard functions return either the requested resource, a boolean indicating success, or a Promise resolving to the target data.

## Module Design

**Exports:**
- Backend: Uses CommonJS exports (`module.exports = { ... }`).
- Frontend: Uses ES Modules (`export default ...` or `export { ... }`).

**Barrel Files:**
- Not used. All modules, components, and contexts are imported directly from their respective source files using relative file paths.

---

*Convention analysis: 2026-08-18*
