# Coding Conventions

**Analysis Date:** 2026-09-30

## Naming Patterns

**Files:**
- Backend implementation modules use lower camel case, for example `backend/modules/canonicalOutput.js`, `backend/modules/promptPolicy.js`, and `backend/modules/audioLanguageDetector.js`.
- Use `backend/tests/<subject>.test.js` for new Q&A/resource/accounting tests, following `backend/tests/qaRequestReceipts.test.js` and `backend/tests/geminiCost.test.js`. Root `backend/test_*.js` retains policy/integration tests and some operational probes; distinguish deterministic `node:test` files from live executables.
- React components and screens use PascalCase filenames with colocated CSS, for example `frontend/src/screens/PlayerScreenV2.js` and `frontend/src/screens/PlayerScreenV2.css`; shared contexts live under `frontend/src/contexts/`.

**Functions:**
- Use lower camel case for functions and handlers, such as `validateCandidate`, `loadPolicyPrompt`, `createTtsHandler`, and `useAccessibility` in `backend/modules/canonicalOutput.js`, `backend/modules/promptPolicy.js`, `backend/routes.js`, and `frontend/src/contexts/AccessibilityContext.js`.
- Use verb-oriented names for operations (`saveCanonicalScriptChunk`, `findAcceptedTtsEvent`, `updateVideoStatus`) and `is`/`has` predicates (`isConfirmedForeignInterval`, `hasVisibleTextEvidence`) as demonstrated in `backend/database.js` and `backend/modules/canonicalOutput.js`.
- React event callbacks use `handle...` for UI actions and `...Callback`/`...Ref` for hook-related values, as in `frontend/src/screens/PlayerScreenV2.js`.

**Variables:**
- Use lower camel case for local values and state (`audioLanguage`, `validationReasons`, `filteredScript`) in `backend/modules/canonicalOutput.js` and `frontend/src/screens/PlayerScreenV2.js`.
- Use uppercase names for process-wide constants and policy sets (`POLICY_VERSION`, `CANONICAL_TAGS`, `DEFAULT_MAX_TEXT_LENGTH`) in `backend/modules/canonicalOutput.js` and `backend/modules/promptPolicy.js`.
- Use descriptive `...Path`, `...Dir`, `...Track`, and `...Evidence` suffixes for filesystem, collection, and provenance values, following `backend/database.js`, `backend/videoProcessor.js`, and `backend/modules/cliCanonicalOutput.js`.

**Types:**
- There is no TypeScript type system or runtime schema library. Represent contracts as plain JavaScript objects and validate them at boundaries, as `backend/modules/canonicalOutput.js` does for candidates, provenance, statuses, and audio language.
- Canonical event fields use explicit names (`validationStatus`, `validationReasons`, `ttsEligible`, `policyVersion`, `provenance`) across `backend/modules/canonicalOutput.js`, `backend/database.js`, `backend/routes.js`, and `frontend/src/screens/PlayerScreenV2.js`; preserve those names when extending the contract.
- Database columns use a mixed legacy style (`videoId`, `createdAt`, `audio_language`, `validation_status`) in `backend/database.js`; keep SQL names compatible and map them to camelCase at the read boundary in `getVideo`.

## Code Style

**Formatting:**
- No repository-wide Prettier, Biome, or editor configuration is present. Match the surrounding file rather than reformatting an entire legacy module.
- Semicolons are the dominant style, but indentation varies between newer policy modules and older application code. New CommonJS policy modules such as `backend/modules/canonicalOutput.js` use four-space indentation, while `backend/modules/promptPolicy.js` and much of `backend/database.js` use two spaces.
- Both single- and double-quoted strings exist. Newer backend policy code favors single quotes, while legacy calls in `backend/videoProcessor.js` and `backend/modules/describer.js` still contain double quotes.
- Frontend code uses JSX, semicolons, and mostly four-space indentation, with two-space files such as `frontend/src/App.js` and `frontend/src/components/Header.js`; preserve local formatting.

**Linting:**
- Frontend linting is configured inline in `frontend/package.json` with Create React App presets `react-app` and `react-app/jest`, and runs `eslint src --max-warnings 0`.
- Backend has no lint script or backend ESLint configuration in `backend/package.json`; use `node --check` for syntax checks and the existing Node test files for behavior.
- New hooks should satisfy `react-hooks/exhaustive-deps`, as configured through `frontend/package.json`; historical lint outcomes do not establish the current gate result without running it.

## Import Organization

**Order:**
1. Node built-ins or framework imports first, as in `backend/modules/promptPolicy.js` and `backend/videoProcessor.js`.
2. Third-party packages next (`express`, Google clients, `axios`, router libraries) in `backend/routes.js`, `backend/index.js`, and `frontend/src/screens/PlayerScreenV2.js`.
3. Relative application modules and colocated CSS last, as in `frontend/src/App.js`, `frontend/src/components/Header.js`, and `backend/routes.js`.

**Path Aliases:**
- No path aliases are configured. Use relative imports such as `./modules/canonicalOutput`, `../contexts/AuthContext`, and `../components/Header` in `backend/videoProcessor.js` and `frontend/src/screens/PlayerScreenV2.js`.
- CSS is imported from the component or screen that owns it, for example `./PlayerScreenV2.css` in `frontend/src/screens/PlayerScreenV2.js`.

## Error Handling

**Patterns:**
- Pure canonical validation fails closed: `backend/modules/canonicalOutput.js` returns explicit `accepted`, `quarantined`, and `rejected` buckets with reason codes and forces `ttsEligible: false` for non-accepted events.
- Policy loading uses `PolicyPromptError` with stable error codes in `backend/modules/promptPolicy.js`; callers should preserve those codes when adding policy checks.
- Express handlers wrap database and provider calls in `try/catch`, log the technical error, and return a safe status/message in `backend/routes.js`.
- Database write functions log and rethrow so the owning request path can decide whether to emit an SSE error, as in `backend/database.js` and `backend/videoProcessor.js`.
- Optional operational failures are deliberately downgraded to safe fallbacks: language detection returns `unknown` in `backend/modules/audioLanguageDetector.js`, and genre analysis returns a conservative default in `backend/modules/analyzer.js`.
- React async operations catch errors, update local UI state, and use accessibility announcements where appropriate in `frontend/src/contexts/AuthContext.js`, `frontend/src/screens/HomeScreen.js`, and `frontend/src/screens/PlayerScreenV2.js`.
- Q&A routes preserve structured `code`/`status` errors, owner isolation, cancellation and replay contracts in `backend/modules/qaRoutes.js` and `backend/modules/qaRequestStore.js`. Use injected dependencies when extending these factories.
- `backend/modules/qaGeneration.js` classifies provider errors into safe `PROVIDER_*` codes. `backend/modules/qaMedia.js` records classified diagnostics rather than raw provider stderr.

## Logging

**Framework:**
- Backend production logging is the small custom logger in `backend/logger.js`; it writes KST-dated files under `backend/logs/`, mirrors to console outside production, and sends `error` messages to Telegram when configured.
- Legacy backend modules and frontend components also call `console.log`, `console.warn`, and `console.error` directly, notably `backend/modules/describer.js`, `backend/modules/synchronizer.js`, `frontend/src/screens/PlayerScreenV2.js`, and `frontend/src/screens/HomeScreen.js`.

**Patterns:**
- Include an operation or request identifier in backend pipeline messages, using the `[requestHash]` style in `backend/videoProcessor.js` and `backend/modules/audioLanguageDetector.js`.
- Log stage transitions, fallback decisions, durations, and provider failures in the processor; use `logger.info` for normal stages, `logger.warn` for recoverable degradation, and `logger.error` for failed operations, as shown in `backend/videoProcessor.js`.
- Pass `Error` objects to `logger.error` when possible; `backend/logger.js` expands their stack while normalizing other arguments to strings.
- Do not put raw prompts or unbounded evidence into new logs. The canonical persistence boundary already bounds quarantine text/evidence in `backend/database.js`.
- Q&A telemetry uses tagged JSON messages: `[QA-GENERATION]` in `backend/modules/qaGeneration.js` and `[QA-MEDIA]` in `backend/modules/qaMedia.js`. Preserve `event`, request/video identifiers and safe duration/count/status fields when adding events; backend date-prefix timestamps are KST in `backend/logger.js`.
- Client playback instrumentation is opt-in and uses monotonic `performance.now()` plus an allowlist in `frontend/src/services/qaLatencyTrace.js`. Treat browser records as client-local measurements; do not infer production playback completion from text generation or server audio issuance.
- Record Gemini usage through `recordGeminiUsage` in `backend/database.js`; keep historical `api_costs.cost` alongside token/search breakdowns and `qa_user_daily_costs`. `backend/modules/qaRequestReceipts.js` uses the same SQLite transaction for durable receipt and ledger writes.

## Comments

**When to Comment:**
- Comment policy rationale and compatibility constraints near the implementation, as in the timestamp tolerance and mixed-audio comments in `backend/modules/canonicalOutput.js` and `backend/videoProcessor.js`.
- Comments may be Korean or English and often explain operational steps in `backend/database.js`, `backend/videoProcessor.js`, and `frontend/src/screens/PlayerScreenV2.js`.
- Avoid comments that merely restate a line; keep comments for non-obvious safety, fallback, accessibility, or compatibility behavior.

**JSDoc/TSDoc:**
- JSDoc is occasional rather than required; `backend/modules/audioLanguageDetector.js` documents the detector and `backend/videoProcessor.js` documents keyframe extraction.
- Most exported functions rely on names and tests rather than formal type annotations. Add concise JSDoc when a new plain-object contract is not self-evident.

## Function Design

**Size:**
- Prefer small pure helpers for normalization, lookup, classification, and validation, following `backend/modules/canonicalOutput.js` and `backend/modules/cliCanonicalOutput.js`.
- Existing orchestration functions are large and stateful: `processVideo`/`processVideoBatch` in `backend/videoProcessor.js`, route registration in `backend/routes.js`, and large React screens such as `frontend/src/screens/Admin.js`. Avoid expanding these further when a module-level helper is practical.
- Q&A factories accept `now`, stores, media adapters, model/speech clients, limiters and `log` callbacks in `backend/modules/qaRequestStore.js`, `backend/modules/qaGeneration.js` and `backend/modules/qaMedia.js`. Preserve this dependency-injection surface for deterministic tests.

**Parameters:**
- Use a single options object for functions with several related values (`validateCandidate(candidate, context)`, `createTtsHandler({ database, client, cacheRoot })`) in `backend/modules/canonicalOutput.js` and `backend/routes.js`.
- Preserve default values at the boundary (`context = {}`, `events = []`, `audioLanguage = null`) as used in `backend/modules/canonicalOutput.js` and `backend/database.js`.

**Return Values:**
- Return explicit structured results for validation and orchestration, such as `{ events, accepted, quarantined, rejected, reasons }` from `backend/modules/canonicalOutput.js`.
- Use `null` for absent lookup results (`getVideo`, `findAcceptedTtsEvent`) and booleans for update success (`updateSetting`, comment mutations) as established in `backend/database.js` and `backend/modules/ttsPolicy.js`.
- Keep compatibility projection at the boundary: canonical events become legacy `text`/`translation` verbosity values through `toLegacyScriptEvent` in `backend/modules/canonicalOutput.js`.

## Module Design

**Exports:**
- Backend uses CommonJS. Newer modules begin with `'use strict'` and export a named object, for example `backend/modules/canonicalOutput.js` and `backend/modules/promptPolicy.js`; older modules may omit strict mode.
- Frontend uses ES modules with default exports for screens/components and named exports for hooks/providers, as in `frontend/src/App.js`, `frontend/src/components/Header.js`, `frontend/src/hooks.js`, and `frontend/src/contexts/AuthContext.js`.

**Barrel Files:**
- No barrel/index modules are used for frontend components or backend modules. Import the concrete file directly, preserving the relative paths in `frontend/src/App.js` and `backend/videoProcessor.js`.

---

*Convention analysis: 2026-09-30*
