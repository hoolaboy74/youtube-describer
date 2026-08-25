---
phase: 01-canonical-output-provenance-v2-policy
verified: 2026-08-25T02:24:38Z
status: human_needed
score: 4/4 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 0/4
  gaps_closed:
    - "Every generated event preserves the v2 policy across all prompt paths and remains legacy-serializable."
    - "Korean, foreign, mixed, and unknown audio cases produce distinct language/provenance outcomes and only confirmed foreign speech becomes needed [trans]."
    - "Korean original dialogue/subtitle duplicates are excluded from [txt]/[trans] and TTS while independent screen text remains distinct."
    - "Malformed or unsafe events are rejected or quarantined before playable persistence."
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Exercise accepted-event playback with a keyboard and screen reader using visual, foreign-translation, quarantined OCR, and rejected-duplicate fixtures."
    expected: "Only accepted and TTS-eligible events are listed and spoken; controls, status, focus order, seek, pause, and resume remain operable without raw tags or Korean dialogue duplication."
    why_human: "The repository checks policy gates, identity-bound TTS, and the production build, but cannot verify real browser audio timing, focus behavior, or screen-reader announcements."
---

# Phase 1: Canonical Output, Provenance & v2 Policy Verification Report

**Phase Goal:** Users receive only evidence-grounded, policy-compliant description events whose language source, timestamp, tag, and TTS eligibility are known before playback.
**Verified:** 2026-08-25T02:24:38Z
**Status:** HUMAN_NEEDED (automated verification passed)
**Re-verification:** Yes — after gap-closure commit `47be50e`

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Every generated event preserves the v2 policy across all supported prompt paths and remains legacy-serializable. | VERIFIED | HTTP interactive and batch generation load `promptPolicy` before Gemini and pass complete output through `canonicalizeModelOutput`/`publishCanonicalOutput` (`backend/videoProcessor.js:395-455, 831-855, 1197-1233`). `describeSegment` also loads/asserts v2. The offline CLI synchronizer now calls `loadPolicyPrompt` and `assertV2PolicyPrompt` (`backend/modules/synchronizer.js:1-31`) and has no direct `stage3_synchronizer.txt` load. Canonical accepted events retain legacy verbosity/tag projection. |
| 2 | Korean, foreign, mixed, and unknown audio cases produce distinct language/provenance outcomes and only confirmed foreign speech becomes needed `[trans]`. | VERIFIED | `canonicalizeCliOutput` supplies audio classification, nearest frame evidence, and exact dialogue intervals (`backend/modules/cliCanonicalOutput.js:9-97`); `validateEvents` enforces language and confirmed foreign-dialogue gates. `test_audio_language_policy.js` plus the CLI foreign/mixed/unknown fixtures pass. |
| 3 | Korean original dialogue/subtitle duplicates are excluded from `[txt]`/`[trans]` and TTS while independent screen text remains distinct. | VERIFIED | Canonical validation applies transcript-equivalence, dialogue-duplicate, and dialogue-overlap checks; independent `screen_text` requires visible evidence. All three player variants filter to `validationStatus === 'accepted' && ttsEligible === true`, and send `{videoId, eventId}` rather than raw text. TTS lookup rejects all non-accepted/ineligible events (`backend/modules/ttsPolicy.js:3-9`, `backend/routes.js:214-254`). |
| 4 | Malformed or unsafe events are rejected or quarantined before playable persistence. | VERIFIED | The CLI maps synchronizer JSON through `canonicalizeCliOutput`, persists only `canonical.accepted`, and sends quarantined/rejected diagnostics to `saveQuarantinedScriptEvents` (`backend/process_video_cli.js:379-415`). `saveVideoChunk` delegates to canonical persistence; inputs lacking either `validationStatus` or object provenance become rejected and are skipped (`backend/database.js:436-487, 693-694`). The integration regression test confirms no playable row is created. |

**Score:** 4/4 truths verified

## Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `backend/modules/canonicalOutput.js` | Canonical parser, provenance, language gates, duplicate/overlap validation, TTS eligibility, legacy projection | VERIFIED | Substantive pure implementation; deterministic canonical and language suites pass. |
| `backend/modules/promptPolicy.js` | Shared v2 prompt loader/assertion with fail-closed prompt checks | VERIFIED | Default is `prompt_template_codex_v2.txt`; unresolved placeholders, missing policy markers, and legacy tags fail closed (`:31-109`). |
| `backend/modules/cliCanonicalOutput.js` | CLI adapter adding frame/dialogue provenance and invoking canonical validation | VERIFIED | 105-line implementation maps visual, screen-text, and foreign-dialogue candidates and returns accepted/quarantined/rejected buckets. |
| `backend/modules/synchronizer.js` | CLI synchronizer built on the shared v2 policy | VERIFIED | Uses `loadPolicyPrompt` and `assertV2PolicyPrompt`; no `stage3_synchronizer.txt` reference. |
| `backend/process_video_cli.js` | Offline generation path with canonical accepted-only publication/quarantine | VERIFIED | Supplies frame/dialogue context, calls `canonicalizeCliOutput`, saves accepted events only, quarantines diagnostics, and marks zero-accepted output failed. |
| `backend/database.js` | Additive canonical persistence, bounded quarantine, fail-closed legacy write boundary, legacy projection | VERIFIED | Accepted canonical rows persist provenance/status/policy/TTS fields; missing canonical write metadata is rejected/skipped. Existing legacy schema migration remains additive for compatibility. |
| `backend/videoProcessor.js` | Shared complete-output canonical publication for interactive and batch | VERIFIED | Both paths load v2 and publish only accepted canonical events; diagnostics are quarantined and accepted legacy projections are emitted. |
| `backend/routes.js` + `backend/modules/ttsPolicy.js` | Identity-bound accepted-only TTS and script API projection | VERIFIED | `/api/script/:videoId` returns additive canonical fields; `/api/tts` resolves only accepted eligible event identity. |
| `frontend/src/PlayerScreen.js`, `frontend/src/screens/PlayerScreen.js`, `frontend/src/screens/PlayerScreenV2.js` | Eligibility-aware playback and TTS requests | VERIFIED | All three variants gate playback and use `videoId`/`eventId` TTS requests; production build succeeds. |

## Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| Interactive generation | v2 policy | `loadPolicyPrompt` before Gemini | WIRED | `backend/videoProcessor.js:831-842`. |
| Batch generation | v2 policy | `loadPolicyPrompt` before Gemini | WIRED | `backend/videoProcessor.js:1197-1208`. |
| `describeSegment` | v2 policy | `loadPolicyPrompt` + `assertV2PolicyPrompt` | WIRED | `backend/modules/describer.js:1-23`. |
| CLI synchronizer | v2 policy | shared loader and assertion | WIRED | `backend/modules/synchronizer.js:1-31`; `rg` finds no direct `stage3_synchronizer.txt` use. |
| CLI model output | canonical validator | `canonicalizeCliOutput` → `validateEvents` | WIRED | `backend/process_video_cli.js:385-391`; adapter calls `validateEvents` at `backend/modules/cliCanonicalOutput.js:92`. |
| CLI accepted/diagnostic buckets | SQLite | `saveCanonicalScriptChunk` + `saveQuarantinedScriptEvents` | WIRED | `backend/process_video_cli.js:392-395`. |
| HTTP model output | canonical validator/publication | `canonicalizeModelOutput` → `publishCanonicalOutput` | WIRED | `backend/videoProcessor.js:395-455, 849-855, 1225-1233`. |
| Accepted script event | TTS provider | `/api/tts` identity lookup | WIRED | `findAcceptedTtsEvent` gates status and eligibility before provider/cache access. |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| CLI publication | `finalJson` / canonical events | synchronizer JSON plus extracted frame timestamps and subtitle-derived dialogue intervals | Yes | FLOWING; accepted events only reach scripts and diagnostics reach quarantine. |
| HTTP publication | complete model output | Gemini stream/batch response plus frame/dialogue context | Yes | FLOWING; interactive and batch parity test produces identical accepted output. |
| Script API/player | `video.script` | SQLite canonical script projection | Yes | FLOWING; projection retains tag, provenance, status, TTS eligibility, and policy version. |
| TTS | event text | accepted event ID lookup by video/event identity | Yes | FLOWING; rejected, quarantined, unknown, and ineligible fixtures return 422; accepted fixtures synthesize/cache. |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Focused canonical/policy/integration/CLI suite | `node --test backend/test_canonical_output.js backend/test_audio_language_policy.js backend/test_prompt_policy.js backend/test_canonical_integration.js backend/test_cli_canonical_output.js` | 28 passed, 0 failed | PASS |
| Frontend production build | `CI=true npm run build` from `frontend/` | Compiled successfully | PASS |
| Backend syntax | `node --check` on CLI, synchronizer, CLI adapter, canonical, policy, database, processor, routes, describer, and TTS modules | All checks passed | PASS |
| Legacy write fail-closed regression | Covered by `legacy saveVideoChunk input fails closed instead of creating playable rows` | No script row created from input missing canonical status/provenance | PASS |
| Prompt-path bypass scan | `rg` for `stage3_synchronizer`, `saveVideoChunk`, policy loader/assertion, and canonical publication calls | No production `saveVideoChunk` caller; synchronizer uses shared v2 policy; HTTP and CLI paths use canonical publication | PASS |
| Production DB safety | `find`/`git ls-files` for `*.db` and worktree status | No production SQLite DB present or modified; only pre-existing `.planning/config.json` plus this report are changed | PASS |

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| POLICY-01 | 01-01, 01-02 | Common v2 visual/no-speculation/language/tag/timestamp/repetition policy | SATISFIED | Shared v2 loader/assertion is wired into interactive, batch, describer, and CLI synchronizer paths; canonical tags/validation and prompt tests pass. |
| POLICY-02 | 01-01, 01-02 | Four-state audio language policy and confirmed foreign translation | SATISFIED | Canonical language matrix and CLI foreign/mixed/unknown tests pass with provenance gates. |
| POLICY-03 | 01-01, 01-02 | No Korean original-dialogue duplicate in output/TTS; independent screen text remains distinct | SATISFIED | Duplicate/overlap fixtures pass; player/TTS integration rejects duplicate and ineligible events. |
| POLICY-04 | 01-01, 01-02 | Validate before playback/persistence and quarantine unsafe output | SATISFIED | HTTP and CLI accepted-only publication, quarantine storage, fail-closed legacy write test, and identity-bound TTS test pass. |

No phase requirements are orphaned: REQUIREMENTS.md maps exactly POLICY-01 through POLICY-04 to Phase 1, and both plans declare those IDs.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---:|---|---|---|
| — | — | No blocker or warning anti-patterns found in the phase implementation. | INFO | `return []`/`return null` matches are defensive normalization, missing-input, or filtering branches with real callers and are not stubs. |

## Human Verification Required

### 1. Accepted-event player/TTS accessibility flow

**Test:** In a browser with a screen reader, load a video containing accepted visual, accepted foreign translation, quarantined OCR, and rejected duplicate events. Change verbosity/subtitle-reading settings, play, pause, seek, and trigger TTS.
**Expected:** Only accepted and TTS-eligible events are listed/read; controls and status remain keyboard/screen-reader operable; no raw tags or duplicated Korean dialogue are spoken.
**Why human:** Visual layout, focus order, real screen-reader announcements, and real provider/audio timing are not verified by deterministic Node tests or the frontend build.

## Gaps Summary

No automated gaps remain. Commit `47be50e` closes the prior offline CLI bypass: the synchronizer now uses the v2 policy boundary, CLI output is canonicalized with frame/dialogue provenance, accepted-only persistence and quarantine are wired, and unvalidated `saveVideoChunk` inputs no longer create playable rows. Overall workflow status is `human_needed` only because the required browser/accessibility/audio-flow check cannot be established programmatically.

---

_Verified: 2026-08-25T02:24:38Z_
_Verifier: Codex (gsd-verifier)_
