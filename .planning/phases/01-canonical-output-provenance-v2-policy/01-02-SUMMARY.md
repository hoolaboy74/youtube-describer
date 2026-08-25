---
phase: 01-canonical-output-provenance-v2-policy
plan: 02
subsystem: api
tags: [node, commonjs, sqlite, canonical-output, prompt-policy, tts, react, node-test]

# Dependency graph
requires:
  - phase: 01-canonical-output-provenance-v2-policy
    provides: canonical parser, provenance schema, language policy, validation statuses, and legacy serializer
provides:
  - additive canonical script persistence with bounded internal quarantine diagnostics
  - one validated codex-v2 prompt loader for interactive, batch, and segment generation
  - accepted-only SSE/database publication and canonical TTS identity enforcement
  - player filtering and TTS request compatibility for all existing player variants
affects: [durable-jobs, genre-routing, chunk-processing, validated-tts, playback]

# Tech tracking
tech-stack:
  added: []
  patterns: [accepted-only canonical publication, fail-closed prompt assertions, identity-keyed TTS cache, disposable SQLite integration fixtures]

key-files:
  created:
    - backend/modules/promptPolicy.js
    - backend/modules/ttsPolicy.js
    - backend/test_prompt_policy.js
    - backend/test_canonical_integration.js
  modified:
    - backend/database.js
    - backend/modules/canonicalOutput.js
    - backend/modules/describer.js
    - backend/routes.js
    - backend/videoProcessor.js
    - frontend/src/PlayerScreen.js
    - frontend/src/screens/PlayerScreen.js
    - frontend/src/screens/PlayerScreenV2.js

key-decisions:
  - "Canonical script rows are additive and accepted-only; rejected and quarantined candidates remain in bounded internal diagnostics rather than playable storage."
  - "All Gemini generation paths load and assert the codex-v2 baseline before provider calls, with stage-specific context composed as data."
  - "TTS accepts only an accepted event fetched by videoId and eventId, and cache keys include event identity and synthesis parameters."

patterns-established:
  - "Interactive streams and batch responses buffer complete model text, call the same canonicalizer, then publish sorted accepted legacy projections."
  - "Player components defensively require validationStatus=accepted and ttsEligible=true before selecting or synthesizing an event."

requirements-completed: [POLICY-01, POLICY-02, POLICY-03, POLICY-04]

# Metrics
duration: 23m
completed: 2026-08-25
---

# Phase 1 Plan 2: Canonical Output, Provenance & v2 Policy Summary

**Canonical persistence, v2 prompt enforcement, accepted-only generation publication, and identity-bound TTS playback across the legacy-compatible stack.**

## Performance

- **Duration:** 23 minutes
- **Started:** 2026-08-25T01:44:00Z
- **Completed:** 2026-08-25T02:07:06Z
- **Tasks:** 4/4
- **Files modified:** 11

## Accomplishments

- Added additive `scripts` metadata and `script_quarantine` storage, with disposable fresh/legacy SQLite migration tests, idempotent accepted inserts, bounded diagnostics, and canonical-to-legacy API projection.
- Centralized prompt loading on `prompt_template_codex_v2.txt`, resolved all required placeholders, asserted policy markers/tags, and removed the alternate stage prompt bypass.
- Buffered interactive and batch model output until complete validation, then persisted and emitted only accepted events while quarantining unsafe, duplicate, overlapping, malformed, and ineligible candidates.
- Enforced accepted canonical event lookup at `/api/tts`, prevented raw arbitrary text synthesis, preserved identity-keyed cache hits, and updated all player variants to filter and request by canonical identity.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add additive canonical persistence, quarantine storage, and legacy projection** - `27266a4` (feat)
2. **Task 2: Centralize v2 prompt loading and protect alternate prompt paths** - `2a06302` (feat)
3. **Task 3: Route interactive and batch generation through accepted-only canonical publication** - `12139c2` (feat)
4. **Task 4: Enforce canonical eligibility in API and Player V2 TTS selection** - `00e79c8` (feat)

**Plan metadata:** `315cb4e` (docs: complete canonical policy integration plan).

## Files Created/Modified

- `backend/database.js` - Additive canonical columns, quarantine table, accepted-only persistence, and expanded legacy projection.
- `backend/modules/canonicalOutput.js` - Exposes validated event collections and canonical tag projection for integration publication.
- `backend/modules/promptPolicy.js` - Shared v2 prompt resolution, replacement, assertion, and policy context.
- `backend/modules/ttsPolicy.js` - Accepted/TTS-eligible event lookup boundary.
- `backend/modules/describer.js` - Composes stage context over the validated v2 baseline.
- `backend/videoProcessor.js` - Shared complete-output canonicalization and accepted-only interactive/batch publication.
- `backend/routes.js` - Identity-bound `/api/tts` handler with injectable test dependencies and identity-aware cache keys.
- `backend/test_prompt_policy.js` - Default, alternate, missing, placeholder, and unsupported-tag policy fixtures.
- `backend/test_canonical_integration.js` - Migration, persistence, parity, quarantine, and TTS provider-boundary fixtures.
- `frontend/src/PlayerScreen.js`, `frontend/src/screens/PlayerScreen.js`, `frontend/src/screens/PlayerScreenV2.js` - Eligibility filtering and canonical identity TTS requests.

## Decisions Made

- Used additive migrations and retained legacy fields so existing `/api/script/:videoId` consumers keep `id`, numeric `timestamp`, `text`, and `verbosity`.
- Kept quarantine internal and bounded; no raw prompt or full evidence payload is returned through SSE or TTS responses.
- Updated the two legacy player components in addition to Player V2 because the tightened `/api/tts` contract would otherwise break existing player flows.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Repaired missing local SQLite test dependencies**
- **Found during:** Task 1 (persistence acceptance verification)
- **Issue:** Declared backend dependencies were not installed and the Node 24/Apple Silicon `better-sqlite3` native binding was unavailable, blocking disposable SQLite tests.
- **Fix:** Installed declared backend dependencies with scripts disabled and rebuilt only `better-sqlite3`; no production database was opened or changed.
- **Files modified:** No tracked source files.
- **Verification:** `node --test backend/test_canonical_integration.js` passed.
- **Committed in:** `27266a4` (test harness and persistence task commit)

**2. [Rule 1 - Bug] Preserved batch video metadata while switching final publication to canonical persistence**
- **Found during:** Task 3 (accepted-only generation publication)
- **Issue:** The batch path only created a preliminary video row, so removing its legacy final `saveVideo` call would leave accepted output with placeholder metadata.
- **Fix:** Accepted canonical publication now finalizes title, duration, filesize, and audio language through the compatibility wrapper after validation; failed/all-quarantined output remains unplayable.
- **Files modified:** `backend/videoProcessor.js`
- **Verification:** Canonical integration parity test and full 22-test suite passed.
- **Committed in:** `12139c2`

**3. [Rule 2 - Missing Critical] Migrated every existing player variant to the identity-bound TTS contract**
- **Found during:** Task 4 (API/player eligibility verification)
- **Issue:** Two legacy player components still posted arbitrary `text`; the new `/api/tts` boundary would reject them and could not enforce canonical eligibility.
- **Fix:** Added accepted/TTS-eligible guards, `videoId`/`eventId` requests, and identity-plus-parameter cache keys to both legacy components as well as Player V2.
- **Files modified:** `frontend/src/PlayerScreen.js`, `frontend/src/screens/PlayerScreen.js`
- **Verification:** No raw-text TTS payloads remain; frontend production build passed.
- **Committed in:** `00e79c8`

---

**Total deviations:** 3 auto-fixed (1 Rule 1, 1 Rule 2, 1 Rule 3).
**Impact on plan:** All fixes were directly required for correctness, compatibility, or verification; no architectural scope change was introduced.

## Issues Encountered

- Git commits initially hit the parent-worktree index permission boundary; the four scoped commits succeeded with the required elevated Git permission and no unrelated files were staged.
- Frontend dependencies were absent and were installed from the existing lockfile. The production build passed with only existing Browserslist/deprecation warnings.
- The only remaining worktree modification is the pre-existing `.planning/config.json` workflow flag, preserved throughout.

## Authentication Gates

None.

## Known Stubs

None. Stub scan of all created/modified implementation and test files found no new placeholder UI path, TODO/FIXME marker, empty data source, or intentionally unimplemented branch.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 1’s canonical contract now survives prompt loading, generation buffering, SQLite persistence, legacy API serialization, player selection, and TTS synthesis boundaries. Phase 2 can build durable job/chunk ownership on the accepted-event and status primitives without reopening policy decisions.

## Verification

- `node --test backend/test_canonical_output.js backend/test_audio_language_policy.js backend/test_prompt_policy.js backend/test_canonical_integration.js` — passed, 22/22 tests.
- `CI=true npm run build` from `frontend/` — passed.
- `node --check backend/videoProcessor.js`, `backend/routes.js`, `backend/modules/promptPolicy.js`, `backend/modules/ttsPolicy.js` — passed.
- Acceptance scans confirmed both generation paths call `canonicalizeModelOutput`, no generation path calls `saveVideoChunk`, all TTS requests carry `videoId`/`eventId`, and no production `backend/db/cache.db` change exists.

## Self-Check: PASSED

- Summary file exists at `.planning/phases/01-canonical-output-provenance-v2-policy/01-02-SUMMARY.md`.
- Task commits `27266a4`, `2a06302`, `12139c2`, and `00e79c8` exist in Git history.
- All 11 created/modified key files exist on disk.

---
*Phase: 01-canonical-output-provenance-v2-policy*
*Completed: 2026-08-25*
