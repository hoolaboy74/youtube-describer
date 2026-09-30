# Testing Patterns

**Analysis Date:** 2026-09-30

## Test Framework

**Runner:**
- Backend deterministic tests use the Node built-in `node:test` runner and `node:assert/strict`, with no separate runner or config file. Examples are `backend/test_canonical_output.js`, `backend/test_audio_language_policy.js`, `backend/test_prompt_policy.js`, `backend/test_cli_canonical_output.js`, `backend/test_subtitle_provenance.js`, and `backend/test_canonical_integration.js`.
- Frontend tests use Create React App's Jest runner through `react-scripts test`, configured by `frontend/package.json` and initialized by `frontend/src/setupTests.js`.

**Assertion Library:**
- Backend assertions use `node:assert/strict`, including `assert.equal`, `assert.deepEqual`, `assert.ok`, `assert.match`, `assert.throws`, and `assert.rejects` in `backend/test_canonical_output.js`, `backend/test_prompt_policy.js`, and `backend/test_canonical_integration.js`.
- Frontend assertions use Jest plus `@testing-library/jest-dom`, imported in `frontend/src/setupTests.js`. Service tests use exact call/state assertions; `frontend/src/hooks/useQaConversation.test.js` uses `renderHook`, `act` and `waitFor` from Testing Library.

**Run Commands:**
```bash
node --test backend/test_canonical_output.js backend/test_audio_language_policy.js backend/test_prompt_policy.js backend/test_cli_canonical_output.js  # Policy suite
node --test backend/test_canonical_output.js backend/test_audio_language_policy.js backend/test_prompt_policy.js backend/test_cli_canonical_output.js backend/test_subtitle_provenance.js backend/test_canonical_integration.js  # Full node:test set
node --test backend/tests/*.test.js  # Q&A, cost, cache, media and limiter suites
node --test backend/tests/geminiCost.test.js backend/tests/qaRequestReceipts.test.js backend/tests/qaLatencyBenchmark.test.js  # Accounting/telemetry contracts
cd frontend && CI=true npm test -- --watchAll=false  # Single-run Jest/CRA tests
cd frontend && npm run lint  # CRA ESLint with zero warnings allowed
cd frontend && npm run build  # Production compilation
```
- `backend/package.json` has a placeholder `npm test` script that exits with `Error: no test specified`; invoke Node's test runner directly until that script is replaced.
- `frontend/package.json` also provides `npm start` and `npm run eject`, but they are development/build commands rather than test commands.

## Test File Organization

**Location:**
- Backend policy tests sit at `backend/test_*.js`; Q&A/media/accounting tests are under `backend/tests/`. Live scripts under `test_scripts/` are distinct from deterministic fixtures.
- Frontend tests are colocated with services/hooks: `frontend/src/services/qaClient.test.js`, `frontend/src/services/qaAudioController.test.js`, `frontend/src/services/qaLatencyTrace.test.js`, and `frontend/src/hooks/useQaConversation.test.js`.

**Naming:**
- Match `backend/tests/<subject>.test.js` for Q&A/resource/cost tests and `backend/test_<subject>.js` for root policy tests such as `backend/test_canonical_integration.js`.
- The frontend follows CRA's `*.test.js` convention across `frontend/src/`.

**Structure:**
```
backend/test_<subject>.js        # node:test unit or integration fixture
backend/tests/<subject>.test.js # Q&A/resource/cost Node fixtures
backend/test_full_workflow.js    # live/manual media and provider workflow
backend/test_matrix_runner.js    # live comparison benchmark
frontend/src/App.test.js         # CRA/Jest component test
frontend/src/services/*.test.js  # SSE/audio/playback instrumentation
frontend/src/hooks/*.test.js     # React conversation lifecycle
frontend/src/setupTests.js       # shared jest-dom setup
```
- Keep deterministic behavior in root policy tests and `backend/tests/*.test.js`; run network/provider experiments such as `test_scripts/qa_provider_probe.js`, `test_scripts/qa_latency_benchmark.js` and `test_scripts/qa_download_benchmark.js` deliberately. `backend/tests/frameExtraction.test.js` includes generated-media integration and therefore requires media binaries.

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
- Q&A durable state tests use real SQLite `:memory:` databases with `t.after(() => db.close())` in `backend/tests/qaRequestReceipts.test.js`. Assert rollback and exactly one persisted ledger row after retries, rather than only checking a mocked call count.
- HTTP integration tests start Express on `127.0.0.1` with port `0`, await `once(server, 'listening')`, and register server cleanup in `backend/tests/qaRoutes.test.js`.

## Mocking

**Framework:**
- Backend deterministic tests do not use a mocking library. They inject plain objects/functions or use temporary child processes, as in `backend/test_canonical_integration.js`.
- Frontend uses Jest mocks for network/audio services in `frontend/src/hooks/useQaConversation.test.js`; `frontend/src/services/qaLatencyTrace.test.js` injects a controllable monotonic clock, fake session storage and timer spies.

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
- In `backend/tests/geminiCost.test.js`, set `YOUTUBE_DESCRIBER_DB_PATH` to a temporary file before importing `backend/database.js`. Import order matters because the database connection is created at module load.
- Use deferred promises to control interleavings in `backend/tests/qaMedia.test.js` and `backend/tests/qaIncremental.test.js`; inject fake adapters/stream emitters instead of relying on network timing.

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
- Frontend service fixtures live in the test files; `frontend/src/services/qaLatencyTrace.test.js` supplies a fixed clock and instrumentation environment, and `frontend/src/hooks/useQaConversation.test.js` resets service mocks per test.

## Coverage

**Requirements:**
- No coverage threshold, coverage configuration, or coverage script is present in `backend/package.json`, `frontend/package.json`, or repository configuration files.
- Jest/Istanbul dependencies arrive transitively with CRA, but no `--coverage`, `collectCoverage`, `coverageThreshold`, `nyc`, or `c8` setting is configured.

**View Coverage:**
```bash
cd frontend && npm test -- --coverage --watchAll=false  # CRA/Jest coverage, if dependencies resolve
```
- No backend coverage script is defined in `backend/package.json`; use explicit runner invocation and avoid treating a documentation map as evidence that checks passed.

## Test Types

**Unit Tests:**
- `backend/test_canonical_output.js`, `backend/test_audio_language_policy.js`, `backend/test_cli_canonical_output.js`, and `backend/test_prompt_policy.js` exercise pure parsing, normalization, policy, provenance, and prompt composition without network calls.
- `backend/test_subtitle_provenance.js` tests VTT parsing/selection and canonical binding with temporary files, while still importing the processor module.
- `backend/tests/geminiCost.test.js` covers cached/tool/thinking tokens, rate-version transitions, Search grounding query counts and shared monthly Search allowance; its ledger test checks `api_costs` and `qa_user_daily_costs` together.
- `backend/tests/qaLatencyBenchmark.test.js` checks grouping dimensions, failure denominators, absent playback latency, duplicate attempts, PTS mapping and complete JSON record parsing. `backend/tests/qaDownloadBenchmark.test.js` checks timebase mapping and diagnostic redaction.
- `backend/tests/qaContext.test.js`, `backend/tests/qaSearch.test.js`, `backend/tests/qaConfig.test.js` and `backend/tests/qaTtsStore.test.js` exercise Q&A context/search/config/capability boundaries.

**Integration Tests:**
- `backend/test_canonical_integration.js` covers additive SQLite migration, accepted-only persistence, quarantine storage, interactive/batch parity, legacy compatibility, and TTS provider/cache boundary behavior.
- The integration harness uses real `better-sqlite3` and route/database code against temporary paths, then asserts database rows and API-like response objects.
- `backend/tests/qaRequestReceipts.test.js` verifies restart refusal, retained unconfirmed usage, conversation-text exclusion, transactional rollback and duplicate-charge suppression.
- `backend/tests/qaRoutes.test.js` verifies authenticated config/acceptance, idempotency, event replay, audio-ticket ownership, cache-only opening eligibility and streaming TTS permit release.
- `backend/tests/qaMedia.test.js`, `backend/tests/qaCacheManager.test.js`, `backend/tests/qaPipelineFoundation.test.js` and `backend/tests/mediaResourceLimiter.test.js` cover shared media work, durable sources, cancellation/lease behavior, cache reuse and resource bounds. Read each scenario before inferring whole-service recovery coverage.
- `backend/tests/qaIncremental.test.js` verifies incremental sentence/audio generation, timeouts, cancellation, opening-summary limits and transport validation. Its explicit wording/evidence/language validation test documents a narrower validator than the screen-description canonical policy suite.
- `frontend/src/hooks/useQaConversation.test.js` exercises conversation cancellation, playback speed, validation announcements, opening summaries and search-source handling through mocked services.

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

## Statistics Collector v2 Verification

- `node --test .agents/skills/analyze_system_stats/scripts/stats_collector.test.js`: four deterministic tests cover strict dates and registration cutoff, UTC SQL/ISO/epoch KST boundaries, nonmultiplying cost joins, QA reconciliation, request/usage states, gzip corruption, missing log days/tables, scope labels, privacy, read-only DB bytes and repeated collection.
- `python3 -m unittest discover -s .agents/skills/analyze_system_stats/scripts -p 'test_build_monthly_report.py'`: three tests verify single-pass substitutions, description-only ratios, missing-input rejection, HTML semantics, PPTX ZIP/XML packaging and source-hash provenance.
- The 8 August slides were checked in headless Chrome for loaded cover/alt, no clipped slide content, no July sample values and keyboard Enter opening native details.
- The collector-related gaps below describe the earlier audit baseline. V2 resolves basic aggregation/source/date correctness; actual browser playback/TTS HIT instrumentation and retained-source limitations remain.

## Coverage Gaps

- No deterministic collector test is detected for `.agents/skills/analyze_system_stats/scripts/stats_collector.js`. It performs SSH and output writes at module load, preventing simple import-only unit tests; separate parsing/aggregation from remote execution before adding fixtures.
- Collector accounting fixtures must reconcile `api_costs` with `qa_user_daily_costs` and `qa_request_receipts` from `backend/database.js` and `backend/modules/qaRequestReceipts.js`, including recorded/unconfirmed usage, restart interruption, no double counting and request-type/model/search/token breakdowns. Existing `backend/tests/geminiCost.test.js` validates writes, not monthly report aggregation.
- Collector fixtures must parse the KST line prefix from `backend/logger.js` and tagged JSON in `backend/modules/qaMedia.js`/`backend/modules/qaGeneration.js`. INFO/WARN/ERROR totals alone do not verify cache hit/miss, fallback, provider classification, timeout or per-stage timing metrics.
- Date-boundary tests are absent for the collector: test SQLite UTC timestamps, KST backend logs, Nginx offsets, epoch-millisecond receipt/cache timestamps, exact month boundaries and missing/rotated log coverage. `.agents/skills/analyze_system_stats/SKILL.md` specifies a first-signup lower bound, while its script assigns `startDate` directly and defaults to 1970; fixture-test the intended rule before relying on report labels.
- Browser first-playback telemetry is verified by `frontend/src/services/qaLatencyTrace.test.js`, but client-local instrumentation in `frontend/src/services/qaLatencyTrace.js` does not establish production monthly playback statistics. `backend/tests/qaLatencyBenchmark.test.js` protects failure denominators for exported benchmark records; a collector needs explicit source availability rather than substituting server generation completion.
- The collector needs an inventory/schema compatibility fixture for Q&A cache/job/assets (`backend/modules/qaCacheStore.js`), receipts (`backend/modules/qaRequestReceipts.js`), daily costs and script quarantine (`backend/database.js`). Check unavailable tables and logs as unavailable rather than silently reporting zero.
- `frontend/src/hooks/useQaConversation.test.js` verifies announcements and lifecycle, but does not replace browser keyboard/screen-reader/manual assistive-technology checks for `frontend/src/screens/PlayerScreenV2.js` and `frontend/src/contexts/AccessibilityContext.js`. No browser E2E runner is configured in `frontend/package.json`.
- Route/auth/settings/verification coverage in `backend/routes.js` remains broader than focused Q&A/canonical integration fixtures. Q&A cache recovery/resource tests do not prove durable 15-minute description-job continuity in `backend/videoProcessor.js`.
- Test and lint results are not asserted by this map: the commands above are supported by inspected test/manifests; run the relevant checks for a concrete change. `backend/package.json` still has a failing placeholder test script.

---

*Testing analysis: 2026-09-30*
