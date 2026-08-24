# Phase 1: Canonical Output, Provenance & v2 Policy - Context

**Gathered:** 2026-08-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Establish the canonical evidence, language, tagging, timestamp, validation, provenance, and non-duplication contract that every generated description event must satisfy before it is persisted or exposed as playable output. Preserve the existing `[v1]`, `[v2]`, `[v3]`, `[txt]`, and `[trans]` compatibility contract at the system boundary. Genre routing, durable jobs, chunk orchestration, and playback scheduling remain later phases.

</domain>

<decisions>
## Implementation Decisions

### Canonical provenance data contract

- **D-01:** The internal canonical event is a typed record, not only the legacy `id/timestamp/text/verbosity` tuple. It must retain a stable deterministic event ID, timestamp, text, canonical tag, evidence/provenance references, audio-language context, policy/template version, validation status/reasons, and explicit TTS eligibility.
- **D-02:** Provenance must distinguish visual evidence, independently visible screen text, and confirmed foreign-dialogue translation. A dialogue track is context/evidence for speech timing and language; it is not proof that text was visible on screen.
- **D-03:** Existing consumers continue to receive the legacy-compatible fields through an adapter/DTO. The player and persistence migration must not require unrelated later phases to understand every new provenance field immediately.

### Language and duplication policy

- **D-04:** `korean` original audio never produces a transcript-equivalent `[txt]` or `[trans]` event. Korean speech and a subtitle/OCR rendering with the same meaning are omitted from playable output and TTS.
- **D-05:** `foreign` original audio may produce `[trans]` only when a confirmed foreign speech segment is needed for comprehension. Preserve negation, numbers, names, questions, honorifics, and core meaning; do not label a dialogue translation as visible screen text.
- **D-06:** `mixed` audio translates only confirmed non-Korean speech intervals. Korean intervals are not re-read. If the language or interval is uncertain, suppress translation rather than guess.
- **D-07:** `unknown` audio never triggers translation. Only independently evidenced visual information and clearly readable, important screen text may become `[v1]`–`[v3]` or `[txt]`.
- **D-08:** `[txt]` is reserved for important text directly readable in a frame and independent of the original dialogue. Semantic and time-window duplicate suppression applies between screen text and translated dialogue, and across repeated events; visual text must not be inferred from transcript content.

### Validation and quarantine boundary

- **D-09:** Candidate lines are parsed and validated before SSE publication or persistence as playable canonical output. The current behavior of streaming raw parsed lines into SQLite and filtering only a subset at the end must be replaced by a canonical validation gate shared by interactive and batch paths.
- **D-10:** Hard-invalid candidates are rejected: unsupported tag, malformed line, non-finite or out-of-range timestamp, empty text, excessive sentence length, missing/unsupported provenance, or invalid language decision. Out-of-range timestamps are not silently clamped.
- **D-11:** Semantically unsafe or ambiguous candidates are quarantined with a machine-readable reason rather than silently discarded as if valid. Valid neighboring events may remain available, but an unvalidated candidate never becomes playable.
- **D-12:** Validation includes tag and timestamp checks, language/provenance rules, duplicate suppression, sentence-length limits, dialogue occupancy/overlap checks, and TTS eligibility. `[trans]` may be associated with the confirmed foreign speech interval; visual descriptions must not be treated as safe merely because they parse syntactically.
- **D-13:** Canonical publication is the point at which the event becomes eligible for persistence, SSE, and later TTS selection. The validator must expose enough status/reason data for later job and playback phases to distinguish accepted, quarantined, and rejected output.

### Prompt path compatibility

- **D-14:** `backend/prompt_template_codex_v2.txt` is the mandatory common safety and language-policy baseline for every generation path, including interactive and batch processing and any legacy describer path still in use.
- **D-15:** Path-specific prompts may add input/task instructions, but may not weaken v2 invariants: visual evidence priority, no speculation, language-aware translation, no Korean-original duplication, short Korean honorific sentences, strict tags/timestamps, and repetition suppression.
- **D-16:** Resolve the prompt default/configuration drift toward v2. The selected policy/template version is recorded with canonical output so later prompt overlays and retries cannot be mistaken for the same policy revision.
- **D-17:** Legacy tags (`txt`/`trans`) and legacy internal verbosity values (`text`/`translation`) remain supported only through an explicit compatibility boundary. New validation and player selection must consume canonical policy/provenance decisions, not rely on prompt text alone.

### the agent's Discretion

- Exact TypeScript/JavaScript field names, module boundaries, and migration mechanics.
- Whether quarantined candidates use a dedicated table or a structured artifact/log, provided they cannot enter the playable canonical script and retain rejection reasons.
- The exact text normalization and semantic-similarity algorithm, thresholds, and fixture shape, provided the policy distinctions above are enforced deterministically and conservatively.
- Exact Korean sentence-length metric and dialogue guard-band values, subject to deterministic tests and later TTS timing validation.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Policy and requirements

- `backend/prompt_template_codex_v2.txt` — Common v2 visual-evidence, language, tag, timestamp, sentence, repetition, and original-audio duplication policy.
- `.planning/REQUIREMENTS.md` §Description Policy and Language — POLICY-01 through POLICY-04 acceptance requirements.
- `.planning/PROJECT.md` — Core value, non-negotiable description policy, compatibility constraints, and milestone decisions.
- `.planning/ROADMAP.md` §Phase 1 — Phase boundary, success criteria, and research flags.

### Prior repository research

- `.planning/research/PITFALLS.md` — Phase-specific warnings and required proof for provenance, typed output, language gates, duplicate suppression, and semantic validation.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `backend/videoProcessor.js:752-825` and `:1185-1223` — Existing interactive and batch line parsing, timestamp conversion, tag aliases, and OCR-vs-translation similarity filter. This logic is the starting point for extracting a shared canonical parser/validator, but it currently persists chunks before final validation and clamps timestamps.
- `backend/videoProcessor.js:1250-1290` — Existing VTT dialogue-track parser with `start`, `end`, `sourceLanguage`, `sourceText`, and `source: 'youtube_caption'`; it can supply structured speech interval provenance.
- `backend/modules/audioLanguageDetector.js:55-137` — Existing four-state audio classification (`korean`, `foreign`, `mixed`, `unknown`) based on sampled Whisper results, with conservative `unknown` fallback on failures.
- `frontend/src/screens/PlayerScreenV2.js:466-493` — Existing verbosity and subtitle-reading selection logic that maps `text`/`translation` and `v1`–`v3`; it is a compatibility consumer that must be hardened to honor canonical eligibility.

### Established Patterns

- Node.js/Express modular monolith with SQLite via `better-sqlite3`; database migrations are additive `try/catch` column checks in `backend/database.js`.
- Both interactive and batch generation are orchestrated in `backend/videoProcessor.js`; a shared validator should be called by both paths to prevent policy drift.
- Existing script storage is `scripts(id, videoId, timestamp, text, verbosity)` and `saveVideoChunk` uses `INSERT OR IGNORE`; new provenance/status data needs an additive compatibility strategy rather than replacing the old fields abruptly.
- Existing SSE sends `script_chunk` as soon as parsed lines arrive, while the player de-duplicates by `id`; canonical validation must move ahead of this publication boundary.

### Integration Points

- `backend/videoProcessor.js` prompt loading (`DEFAULT_PROMPT_FILE` and `PROMPT_FILE`) currently defaults to `prompt_template.txt`; v2 default/config drift must be resolved here and in any alternate generation path.
- `backend/modules/describer.js` reads `backend/prompts/stage2_describer.txt`, so it is a potential policy bypass and must either consume the common v2 policy block or be explicitly retired from the Phase 1-supported generation surface.
- `backend/database.js` `scripts` schema, `getVideo`, `saveVideo`, and `saveVideoChunk` define persistence and legacy API shape.
- `backend/routes.js` `/script/:videoId` returns the legacy-compatible video/script JSON and must keep working after canonical fields are introduced.
- `frontend/src/screens/PlayerScreenV2.js` `filteredScript`, `playableScript`, and `playDescription` are the downstream selection/TTS boundary; they cannot infer safety solely from `verbosity`.

</code_context>

<specifics>
## Specific Ideas

- Keep the policy contract centralized and immutable while allowing later genre overlays and chunk processing to add context.
- Prefer omission or quarantine over guessing when language, visual evidence, provenance, or duplicate status is uncertain.
- Treat the old serialization format as a compatibility boundary, not as the complete internal data model.

</specifics>

<deferred>
## Deferred Ideas

- Genre-specific prompt overlays and confidence/fallback routing — Phase 3.
- Durable job/chunk ownership, retries, and restart recovery — Phase 2.
- Universal 15-minute chunking and ordered continuity merge — Phase 4.
- TTS duration-aware scheduling, progressive playback, and accessible SSE replay — Phase 5.
- Evaluation thresholds and operational dashboards — Phase 6.

</deferred>

---

*Phase: 01-canonical-output-provenance-v2-policy*
*Context gathered: 2026-08-24*
