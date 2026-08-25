---
phase: 01-canonical-output-provenance-v2-policy
plan: 01
subsystem: api
tags: [node, commonjs, canonical-output, provenance, language-policy, tts, node-test]

# Dependency graph
requires:
  - phase: none
    provides: initial project policy and legacy timed-script compatibility contract
provides:
  - pure canonical parser and validator for evidence-backed description events
  - deterministic duplicate, dialogue-overlap, language, and TTS eligibility gates
  - node:test fixture coverage for canonical output and four-state audio policy
affects: [durable-jobs, genre-routing, chunk-processing, validated-tts, playback]

# Tech tracking
tech-stack:
  added: []
  patterns: [strict CommonJS boundary, deterministic SHA-256 canonical IDs, accepted/quarantined/rejected validation buckets]

key-files:
  created:
    - backend/modules/canonicalOutput.js
    - backend/test_canonical_output.js
    - backend/test_audio_language_policy.js
  modified: []

key-decisions:
  - "Canonical IDs normalize whitespace and punctuation-sensitive spacing while retaining tag, timestamp, provenance kind, and dialogue interval identity."
  - "Hard-invalid candidates are rejected; ambiguous evidence, duplicate content, uncertain mixed intervals, and dialogue overlap are quarantined and never TTS eligible."
  - "Foreign audio may use a confirmed dialogue interval whose track text is Korean translation, while mixed audio requires confirmed non-Korean interval language and unknown audio never translates."

patterns-established:
  - "All playable events expose validationStatus, validationReasons, provenance, policyVersion, and explicit ttsEligible fields."
  - "Legacy txt/trans values are projected only at the compatibility boundary as text/translation verbosity values."

requirements-completed: [POLICY-01, POLICY-02, POLICY-03, POLICY-04]

# Metrics
duration: 12m
completed: 2026-08-25
---

# Phase 1 Plan 1: Canonical Output, Provenance & v2 Policy Summary

**Evidence-backed canonical output validation with deterministic language, duplicate, dialogue-overlap, and legacy TTS eligibility policy.**

## Performance

- **Duration:** 12 minutes
- **Started:** 2026-08-25T01:31:05Z
- **Completed:** 2026-08-25T01:42:34Z
- **Tasks:** 2/2
- **Files modified:** 3

## Accomplishments

- Added a pure CommonJS canonical output module with strict `[integer][tag] text` parsing, allowlisted tags, in-range timestamps, bounded sentence length, provenance requirements, policy versioning, deterministic IDs, and legacy serialization.
- Enforced Korean, foreign, mixed, and unknown audio decisions, including confirmed foreign-dialogue translation, independently evidenced screen text, Korean dialogue/OCR duplicate suppression, and conservative quarantine behavior.
- Added dependency-free Node built-in test coverage for all canonical tags, all four audio classes, malformed and unsafe candidates, duplicate and overlap behavior, exact reason/status/TTS assertions, and legacy `text`/`translation` projection.

## Task Commits

Each task was committed atomically:

1. **Task 1: Build canonical event parser, provenance schema, and validators** - `d49c5a8` (feat)
2. **Task 2: Add deterministic canonical and language-policy fixture coverage** - `f0b554a` (test)

**Plan metadata:** final docs commit records this summary and planning state.

## Files Created/Modified

- `backend/modules/canonicalOutput.js` - Canonical event schema, strict parser, provenance/language validators, cross-event duplicate and dialogue occupancy checks, and legacy projection.
- `backend/test_canonical_output.js` - Deterministic canonical parser, validation, ID, overlap, duplicate, TTS, and compatibility fixtures.
- `backend/test_audio_language_policy.js` - Korean/foreign/mixed/unknown language matrix and screen-text/dialogue duplication fixtures.

## Decisions Made

- Canonical IDs are based on normalized canonical fields rather than raw model lines so whitespace-only model variation cannot create duplicate events.
- Visual descriptions occupying dialogue intervals are quarantined, while a translation linked to its own confirmed foreign interval remains eligible.
- Evidence uncertainty fails closed: unsupported or missing evidence is rejected, while semantic ambiguity is quarantined and never playable/TTS eligible.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Enforced dialogue-track source-text duplicate suppression**
- **Found during:** Task 2 (deterministic canonical and language-policy fixture coverage)
- **Issue:** A Korean `[txt]` candidate could be accepted when it matched Korean dialogue-track text unless the caller manually supplied a duplicate flag.
- **Fix:** Bounded dialogue `sourceText` is retained for deterministic comparison; matching screen text is quarantined, while an own foreign translation interval is exempt.
- **Files modified:** `backend/modules/canonicalOutput.js`
- **Verification:** Korean caption/OCR duplicate fixture passes with `DIALOGUE_DUPLICATE` and `ttsEligible: false`; full focused suite passes.
- **Committed in:** `f0b554a` (part of Task 2 commit)

**2. [Rule 1 - Bug] Corrected foreign, mixed, and unknown interval classification**
- **Found during:** Task 2 (deterministic canonical and language-policy fixture coverage)
- **Issue:** Confirmed foreign-audio translations using Korean translation-track text were quarantined, explicitly unknown mixed intervals were accepted, and unknown translation outcomes were classified inconsistently.
- **Fix:** Foreign audio now requires confirmation but permits Korean translation-track metadata; mixed audio requires a confirmed non-Korean interval; unknown translation is hard-rejected.
- **Files modified:** `backend/modules/canonicalOutput.js`
- **Verification:** Four-state language matrix and mixed-interval fixtures pass with exact statuses/reasons.
- **Committed in:** `f0b554a` (part of Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug)
**Impact on plan:** Both fixes directly enforce POLICY-02/POLICY-03 correctness and remain within the planned canonical validator surface; no architectural scope changed.

## Issues Encountered

- The first commit attempt was blocked by sandbox permissions because this worktree stores its Git index in the parent repository. The required commit succeeded after requesting elevated Git permission; no unrelated files were staged.
- No authentication gates, external services, dependency installation, or network/media calls were required.

## Authentication Gates

None.

## Known Stubs

None. Stub scan found no placeholder implementation, empty UI data path, TODO/FIXME marker, or unconnected component in the files created or modified by this plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The shared canonical contract and deterministic policy fixtures are ready for downstream durable-job and generation-path integration. Persistence/SSE/player call-site migration remains for the subsequent Phase 1 plan; this plan intentionally keeps the existing architecture untouched outside the new pure module and fixtures.

## Verification

- `node --check backend/modules/canonicalOutput.js` — passed.
- `node --test backend/test_canonical_output.js backend/test_audio_language_policy.js` — passed twice, 15/15 tests each run.
- `git diff --check` — passed.
- Every accepted fixture has an allowlisted tag, finite in-range timestamp, provenance, accepted status, and explicit TTS eligibility; every rejected/quarantined fixture has reason codes and `ttsEligible: false`.

## Self-Check: PASSED

- `backend/modules/canonicalOutput.js` exists.
- `backend/test_canonical_output.js` exists.
- `backend/test_audio_language_policy.js` exists.
- Task commits `d49c5a8` and `f0b554a` exist in Git history.

---
*Phase: 01-canonical-output-provenance-v2-policy*
*Completed: 2026-08-25*
