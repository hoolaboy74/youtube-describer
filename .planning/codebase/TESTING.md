# Testing Patterns

**Analysis Date:** 2026-08-31

## Test Framework

**Runner:**
- Backend deterministic tests use the Node built-in `node:test` runner and `node:assert/strict`, with no separate runner or config file. Examples are `backend/test_canonical_output.js`, `backend/test_audio_language_policy.js`, `backend/test_prompt_policy.js`, `backend/test_cli_canonical_output.js`, `backend/test_subtitle_provenance.js`, and `backend/test_canonical_integration.js`.
- Frontend tests use Create React App's Jest runner through `react-scripts test`, configured by `frontend/package.json` and initialized by `frontend/src/setupTests.js`.

**Assertion Library:**
- Backend assertions use `node:assert/strict`, including `assert.equal`, `assert.deepEqual`, `assert.ok`, `assert.match`, `assert.throws`, and `assert.rejects` in `backend/test_canonical_output.js`, `backend/test_prompt_policy.js`, and `backend/test_canonical_integration.js`.
- Frontend assertions use Jest plus `@testing-library/jest-dom`, imported in `frontend/src/setupTests.js`; the only test, `frontend/src/App.test.js`, uses `toBeInTheDocument`.

**Run Commands:**
```bash
node --test backend/test_canonical_output.js backend/test_audio_language_policy.js backend/test_prompt_policy.js backend/test_cli_canonical_output.js  # Deterministic policy suite; observed 23 passing tests
node --test backend/test_canonical_output.js backend/test_audio_language_policy.js backend/test_prompt_policy.js backend/test_cli_canonical_output.js backend/test_subtitle_provenance.js backend/test_canonical_integration.js  # Full node:test set
cd frontend && CI=true npm test -- --watchAll=false  # Single-run Jest/CRA tests
cd frontend && npm run lint  # CRA ESLint with zero warnings allowed
cd frontend && npm run build  # Production compilation
```
- `backend/package.json` has a placeholder `npm test` script that exits with `Error: no test specified`; invoke Node's test runner directly until that script is replaced.
- `frontend/package.json` also provides `npm start` and `npm run eject`, but they are development/build commands rather than test commands.

## Test File Organization

**Location:**
- Backend tests are colocated at the `backend/` root rather than under `tests/` or `__tests__/`. Pure policy tests sit beside the implementation modules, while live probes and workflow scripts are also in `backend/`.
- Frontend tests are colocated with the app entry area under `frontend/src/`; `frontend/src/App.test.js` is the only Jest test file detected.

**Naming:**
- Use `test_<subject>.js` for backend Node tests, such as `backend/test_prompt_policy.js`, `backend/test_subtitle_provenance.js`, and `backend/test_canonical_integration.js`.
- The frontend follows CRA's `*.test.js` convention, currently represented by `frontend/src/App.test.js`.

**Structure:**
```
backend/test_<subject>.js        # node:test unit or integration fixture
backend/test_full_workflow.js    # live/manual media and provider workflow
backend/test_matrix_runner.js    # live comparison benchmark
frontend/src/App.test.js         # CRA/Jest component test
frontend/src/setupTests.js       # shared jest-dom setup
```
- Keep deterministic behavior tests in `backend/test_*.js` and keep network/media experiments clearly separate as executable scripts such as `backend/test_full_workflow.js`, `backend/test_local_video.js`, `backend/test_matrix_runner.js`, `backend/test_search.js`, and `backend/test_tts.js`.

## Test Structure

**Suite Organization:**
```javascript
// backend/test_canonical_output.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const canonical = require('./modules/canonicalOutput');

test('rejects malformed, empty, overlong, and out-of-range candidates without clamping', () => {
    const fixtures = [
        ['[0][v2] 시작 시각도 허용하지 않습니다.', 'TIMESTAMP_OUT_OF_RANGE']
    ];
    for (const [line, reason] of fixtures) {
        const event = parse(line);
        assert.ok(event.validationReasons.includes(reason));
    }
});
```
- Organize tests by policy or behavior, not by private helper. `backend/test_canonical_output.js` covers parsing, provenance, duplicate handling, buckets, and legacy projection; `backend/test_audio_language_policy.js` uses a matrix for Korean, foreign, mixed, and unknown audio.
- Use table-driven fixture arrays for equivalent cases, then assert exact status/reason/TTS fields as in `backend/test_canonical_output.js` and `backend/test_audio_language_policy.js`.

**Patterns:**
- Use small fixture factories to make provenance explicit: `visual`, `screenText`, `foreignDialogue`, and `trans` in `backend/test_canonical_output.js` and `backend/test_audio_language_policy.js`.
- Assert both positive and negative safety behavior. Accepted events must carry `validationStatus: 'accepted'` and `ttsEligible: true`; rejected/quarantined events must not be TTS eligible in `backend/test_canonical_output.js` and `backend/test_canonical_integration.js`.
- Assert compatibility projections at their boundary rather than duplicating the canonical object in every test, using `toLegacyScriptEvent` in `backend/test_canonical_output.js`.
- Test async failures with `assert.rejects` and a predicate on the custom error code, as in `backend/test_prompt_policy.js`.

## Mocking

**Framework:**
- Backend deterministic tests do not use a mocking library. They inject plain objects/functions or use temporary child processes, as in `backend/test_canonical_integration.js`.
- Frontend has Jest available through CRA, but no component mocks or network mocks are present in `frontend/src/App.test.js`.

**Patterns:**
```javascript
// backend/test_canonical_integration.js
const fakeClient = {
    async synthesizeSpeech(request) {
        providerCalls += 1;
        if (![accepted.text, foreignTranslation.text].includes(request.input.text)) {
            throw new Error('unexpected raw text');
        }
        return [{ audioContent: Buffer.from('fake-mp3') }];
    }
};

const handler = routes.createTtsHandler({
    database: db,
    client: fakeClient,
    cacheRoot
});
```
- Inject provider/database/cache dependencies when a boundary is exposed, following `createTtsHandler` in `backend/routes.js` and its use in `backend/test_canonical_integration.js`.
- Use a disposable SQLite database in a child Node process by setting `YOUTUBE_DESCRIBER_DB_PATH`, as `backend/test_canonical_integration.js` does; inspect the database with a read-only connection after writes.

**What to Mock:**
- Mock Gemini/TTS responses, filesystem cache roots, and provider-boundary clients for deterministic tests, following the fake TTS client in `backend/test_canonical_integration.js`.
- Replace download, FFmpeg, Whisper, YouTube, and EventSource interactions before adding tests around `backend/videoProcessor.js` or `frontend/src/screens/PlayerScreenV2.js`; the existing live scripts call real services and binaries.

**What NOT to Mock:**
- Keep pure canonical normalization, validation, language policy, and prompt assertions real; these are the deterministic contracts in `backend/modules/canonicalOutput.js` and `backend/modules/promptPolicy.js`.
- Keep migration SQL and accepted/quarantine persistence real in temporary databases, as required by `backend/test_canonical_integration.js`.

## Fixtures and Factories

**Test Data:**
```javascript
// backend/test_audio_language_policy.js
const dialogue = (sourceLanguage, overrides = {}) => ({
    kind: 'foreign_dialogue',
    dialogueInterval: {
        start: 12,
        end: 16,
        sourceLanguage,
        confirmed: true,
        ...overrides
    }
});

const screen = (text = '독립 화면 글자') => ({
    kind: 'screen_text',
    frameEvidence: [{ frameId: 'screen-1', timestamp: 12, visibleText: text }]
});
```
- Prefer fixed timestamps, fixed IDs, bounded Korean/English text, and explicit provenance over random or production data, following `backend/test_canonical_output.js`, `backend/test_audio_language_policy.js`, and `backend/test_cli_canonical_output.js`.
- Prompt tests use a temporary directory and remove it in `finally`, as in `backend/test_prompt_policy.js`; VTT tests use the same `mkdtempSync`/`rmSync` pattern in `backend/test_subtitle_provenance.js`.
- Integration tests use `backend/test_canonical_integration.js`'s `__RESULT__` stdout marker to transfer structured child-process results and clean disposable directories in `finally` blocks.

**Location:**
- There is no shared fixtures directory or factory module. Factories are local to each test file, especially `backend/test_canonical_output.js`, `backend/test_audio_language_policy.js`, and `backend/test_subtitle_provenance.js`.
- Frontend has no fixture or factory directory; `frontend/src/App.test.js` renders the application directly.

## Coverage

**Requirements:**
- No coverage threshold, coverage configuration, or coverage script is present in `backend/package.json`, `frontend/package.json`, or repository configuration files.
- Jest/Istanbul dependencies arrive transitively with CRA, but no `--coverage`, `collectCoverage`, `coverageThreshold`, `nyc`, or `c8` setting is configured.

**View Coverage:**
```bash
cd frontend && npm test -- --coverage --watchAll=false  # CRA/Jest coverage, if dependencies resolve
```
- No backend coverage command is defined; add instrumentation only with an explicit project decision because the backend runner is currently direct `node --test`.

## Test Types

**Unit Tests:**
- `backend/test_canonical_output.js`, `backend/test_audio_language_policy.js`, `backend/test_cli_canonical_output.js`, and `backend/test_prompt_policy.js` exercise pure parsing, normalization, policy, provenance, and prompt composition without network calls.
- `backend/test_subtitle_provenance.js` tests VTT parsing/selection and canonical binding with temporary files, while still importing the processor module.

**Integration Tests:**
- `backend/test_canonical_integration.js` covers additive SQLite migration, accepted-only persistence, quarantine storage, interactive/batch parity, legacy compatibility, and TTS provider/cache boundary behavior.
- The integration harness uses real `better-sqlite3` and route/database code against temporary paths, then asserts database rows and API-like response objects.

**E2E Tests:**
- No browser E2E framework is configured. Executable media/provider workflows such as `backend/test_full_workflow.js`, `backend/test_local_video.js`, `backend/test_matrix_runner.js`, `backend/test_whisper_concurrency.js`, and `backend/test_tts.js` require live credentials, binaries, network access, or local media.

## Common Patterns

**Async Testing:**
```javascript
// backend/test_prompt_policy.js
test('default prompt resolution uses the v2 baseline and resolves all placeholders', async () => {
    const loaded = await loadPolicyPrompt();
    assert.equal(loaded.policyVersion, POLICY_VERSION);
});
```
- Use an `async` test callback and `await` for promise-returning APIs, as in `backend/test_prompt_policy.js`.
- For child-process integration, use synchronous `spawnSync` plus a structured marker when the test needs deterministic setup/teardown, as in `backend/test_canonical_integration.js`.

**Error Testing:**
```javascript
await assert.rejects(
    loadPolicyPrompt({ promptFile: path.join(directory, 'missing.txt') }),
    error => error instanceof PolicyPromptError && error.code === 'POLICY_PROMPT_NOT_FOUND'
);
```
- Assert stable domain codes and response status codes rather than provider-specific error text, following `backend/test_prompt_policy.js` and `backend/test_canonical_integration.js`.
- For policy failures, assert the exact reason code and `ttsEligible: false`; this is the safety pattern in `backend/test_canonical_output.js` and `backend/test_audio_language_policy.js`.

## Coverage Gaps

- Frontend behavior is almost entirely untested: `frontend/src/App.test.js` is a stale Create React App smoke test that searches for “learn react”, and no tests cover `frontend/src/screens/PlayerScreenV2.js`, `frontend/src/contexts/AuthContext.js`, `frontend/src/contexts/AccessibilityContext.js`, SSE recovery, keyboard behavior, screen-reader announcements, or TTS scheduling.
- The frontend test command fails in this worktree before executing tests because Jest cannot resolve the declared `react-router-dom` dependency from `frontend/src/App.js`, despite its declaration in `frontend/package.json`; restore a complete frontend install before relying on Jest results.
- Backend route/auth/database coverage is narrow. `backend/test_canonical_integration.js` exercises selected canonical/TTS paths, but no systematic tests cover the many handlers in `backend/routes.js`, authentication branches, pagination, settings, user verification, or the broad database API in `backend/database.js`.
- The main processing pipeline has no deterministic tests for retries, duplicate locks, download failures, FFmpeg/Whisper failures, Gemini refusal/stream behavior, API cost accounting, cleanup, or batch/interactive progress. Those paths live primarily in `backend/videoProcessor.js` and are exercised only by live/manual scripts such as `backend/test_full_workflow.js` and `backend/test_matrix_runner.js`.
- Restart/recovery, durable job/chunk state, chunk-boundary continuity, bounded resource concurrency, and SSE reconnect replay have no test fixtures. The active planning requirements in `.planning/REQUIREMENTS.md` identify these as future behavior, but no implementation test surface exists yet.
- `npm run lint` is not a clean quality gate: `frontend/src/PlayerScreen.js:527` produces a missing-hook-dependency warning and `--max-warnings 0` turns it into a failure. Backend has no equivalent lint gate.

---

*Testing analysis: 2026-08-31*
