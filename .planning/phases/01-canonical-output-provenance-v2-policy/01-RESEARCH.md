# Phase 1: Canonical Output, Provenance & v2 Policy - Research

**Date:** 2026-08-24
**Status:** Ready for planning

## Research question

What repository-specific contracts and implementation seams are needed so every generated description event is evidence-grounded, language-safe, provenance-aware, validated before playback, and still compatible with the legacy timed script/player format?

## Existing implementation findings

1. `backend/videoProcessor.js` has two near-duplicate output paths. Both parse lines with `/^\s*\[(\d+)[^\]]*\]\s*\[(v\d|txt|trans)\]/`, map `txt`/`trans` to `text`/`translation`, hash the raw line as `id`, and save output. The interactive path emits `script_chunk` and calls `saveVideoChunk` before the final OCR-vs-translation filter; the batch path filters only after the full model response. This is the primary policy-drift and premature-publication seam.
2. The parser currently converts `0` to `1`, clamps timestamps to `Math.floor(totalDuration)`, and accepts any non-empty text after syntax matching. Phase 1 must replace silent correction with explicit canonical validation and rejection/quarantine reasons.
3. `backend/database.js` stores only `scripts(id, videoId, timestamp, text, verbosity)`. `videos.audio_language` stores only the four-state classification. Additive migration and a legacy DTO are safer than replacing the existing fields in one step.
4. `parseVttToDialogueTrack` already supplies timed `start`, `end`, `sourceLanguage`, `sourceText`, and `source: 'youtube_caption'`. This is a reusable speech-context provenance input, but it does not prove that text appeared on screen.
5. `backend/modules/audioLanguageDetector.js` already returns `korean`, `foreign`, `mixed`, or `unknown`, with `unknown` on detector failure. The validator should consume this value and must not infer a finer language decision from subtitle filename or `sourceLanguage` alone.
6. `backend/videoProcessor.js` resolves `PROMPT_FILE` against `backend/` but defaults to `prompt_template.txt`, while the project environment and policy require `prompt_template_codex_v2.txt`. `backend/modules/describer.js` separately reads `backend/prompts/stage2_describer.txt`; this is an alternate policy bypass that must be covered by the common baseline or removed from the supported generation surface.
7. `frontend/src/screens/PlayerScreenV2.js` selects `text`/`translation` and `v1`–`v3` from legacy `verbosity`, then sends every selected line to `/api/tts`. It needs a compatibility projection that excludes rejected/quarantined/ineligible events and does not re-derive policy from the old verbosity string.

## Recommended implementation seams

### Canonical event and provenance

Create a backend module with pure, deterministic functions for canonical parsing, normalization, validation, serialization, and compatibility projection. The canonical record should contain at minimum:

- stable event ID derived from canonical fields rather than raw whitespace;
- canonical timestamp in decimal seconds plus video duration validation;
- text and canonical tag (`v1`, `v2`, `v3`, `txt`, `trans`);
- evidence references distinguishing frame evidence, visible-text evidence, and foreign-dialogue evidence;
- audio classification and source-language/interval metadata;
- policy/template version;
- validation status and machine-readable reasons;
- explicit `ttsEligible` boolean.

Keep legacy `verbosity: v1|v2|v3|text|translation` in the API/storage projection. Do not make the player depend on provenance JSON before the adapter is available.

### Validation ordering

Use one ordered pipeline in both interactive and batch paths:

1. Parse strict legacy lines into candidate records.
2. Attach generation context and evidence references.
3. Run structural checks: tag, finite timestamp, range, text, sentence-length, and schema.
4. Run language/provenance checks for the four audio states.
5. Run cross-event checks: repeated events, visible text vs translation similarity, and dialogue occupancy.
6. Assign `accepted`, `quarantined`, or `rejected` with reasons.
7. Persist and emit only accepted canonical events; retain quarantine diagnostics separately.
8. Project accepted events to the legacy API/player shape.

Syntactically valid but semantically unsafe events must not be streamed as playable output. A translation may overlap its confirmed source speech interval as evidence, while a visual description that cannot fit the occupied dialogue interval should be marked ineligible rather than forced into the overlap. Exact guard-band and TTS-duration values remain later measurement decisions.

### Language and duplication gates

- `korean`: suppress transcript-equivalent `[trans]` and `[txt]`; preserve only independently evidenced screen text.
- `foreign`: allow needed `[trans]` from confirmed foreign speech; preserve source interval and translation provenance.
- `mixed`: allow `[trans]` only for confirmed non-Korean intervals; uncertain intervals are suppressed.
- `unknown`: no translation; use only direct visual evidence and clearly readable important text.
- `[txt]` requires visible frame evidence and must never be inferred from transcript text.
- Duplicate suppression should use normalized text, tag/provenance type, and a bounded time window. It must be deterministic and conservative, preferring omission over duplicate or guessed content.

### Prompt/configuration contract

Treat `backend/prompt_template_codex_v2.txt` as an immutable common policy block. Interactive, batch, and alternate describer paths may add input/task instructions but must not override its evidence, language, no-duplication, sentence, tag, timestamp, or repeat rules. Record the policy/template version with each canonical output. Tests must assert that default loading resolves to v2 and that every supported prompt path includes the common policy marker/version.

## Deterministic verification strategy

Add backend unit tests with no Gemini, YouTube, FFmpeg, Whisper, or TTS network calls. Fixtures should cover:

- all five tags and legacy `text`/`translation` projections;
- timestamp zero, negative, fractional, out-of-range, non-finite, and duration-end boundaries;
- Korean original plus identical Korean caption/OCR;
- foreign original with English source, Korean translated caption, and no caption;
- mixed audio with confirmed Korean, confirmed foreign, and unknown intervals;
- unknown audio with foreign-looking subtitle metadata;
- independently visible screen text that resembles but does not duplicate dialogue;
- blurred/long/partial screen text that must be rejected or summarized only when evidence policy allows;
- duplicate wording with different whitespace/punctuation and duplicate wording at/over the time boundary;
- visual description overlapping dialogue and translation aligned to confirmed foreign speech;
- prompt default drift and both interactive/batch parser paths using the same validator;
- player/API projection excluding quarantine and `ttsEligible=false` events.

Use property-style table tests for parser/serializer round trips and deterministic IDs. Preserve existing integration scripts as optional/manual tests; the new policy suite must be fast and local.

## Validation Architecture

### Fast checks

- Parser and policy unit tests: `node --test backend/test_canonical_output.js` (new test file).
- Legacy projection/player-selection tests: `node --test backend/test_canonical_output.js` plus a focused pure helper test if player filtering is extracted.
- Prompt-path scan: a deterministic test asserts the v2 template is the default and the supported prompt builders include the common policy version.

### Full checks

- `node --test backend/test_canonical_output.js backend/test_audio_language_policy.js backend/test_prompt_policy.js` if split into focused files.
- Existing backend test scripts remain opt-in because several invoke real external media/provider services; no network is required for the Phase 1 gate.

### Sampling and acceptance

- Run the fast command after each task commit and the full command after each plan wave.
- POLICY-01 is proven by prompt invariant and tag/timestamp/sentence/repetition fixture assertions.
- POLICY-02 and POLICY-03 are proven by the four-state language matrix and Korean duplicate/OCR fixtures.
- POLICY-04 is proven by rejection/quarantine, timestamp, overlap, duplicate, provenance, and TTS eligibility assertions.
- Any candidate that is not accepted by the canonical validator must be absent from the playable script and from TTS selection.

## Risks and mitigations

- **Premature SSE/DB publication:** move publication behind the validator and use a shared module for both paths.
- **Legacy player breakage:** preserve old fields and serialization in a single adapter; add compatibility tests before changing player selection.
- **False OCR evidence:** require frame/evidence references for `[txt]`, never transcript-only provenance.
- **Unknown-language translation:** fail closed for `unknown` and uncertain mixed intervals.
- **Prompt bypass:** inventory all prompt loaders, including `stage2_describer.txt`, and test the common v2 policy marker/version.
- **Semantic similarity false positives:** use deterministic normalization plus conservative thresholds and retain rejection reasons; exact thresholds can be tuned with Phase 6 evaluation fixtures.
- **Timing policy overreach:** validate source/dialogue occupancy now, but leave synthesized duration and pause scheduling refinements to Phase 5.

## Sources

### Repository sources

- `backend/prompt_template_codex_v2.txt`
- `backend/videoProcessor.js`
- `backend/database.js`
- `backend/modules/audioLanguageDetector.js`
- `frontend/src/screens/PlayerScreenV2.js`
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/research/PITFALLS.md`

### External references already captured in project research

- W3C WCAG 2.2 and W3C audio-description guidance — descriptions should use available pauses and avoid masking important original audio.
- Google Gemini structured output documentation — schema-constrained output does not replace application semantic validation.
- Google Cloud Text-to-Speech SSML documentation — escaping, locale/voice parameters, and returned-audio timing matter for later TTS eligibility.
- Google Cloud Vision OCR documentation — detected text is not proof of legibility or semantic importance.
- OWASP LLM Prompt Injection Prevention guidance — titles, captions, OCR, and visible text are untrusted input and cannot override output policy.

## Planning implications

Plan the work around one shared canonical policy module and deterministic test fixtures first, then integrate both generation paths, persistence/API projection, and player/TTS selection. Keep job/chunk/genre orchestration out of this phase while exposing the provenance and validation fields those later phases will consume.
