# Phase 01: Existing Patterns for Canonical Output, Provenance & v2 Policy

**Status:** Fallback pattern map based on direct repository inspection

## Planned file to existing analog map

| Planned role | Closest existing analog | Reuse / constraint |
|---|---|---|
| Canonical parser/validator module | `backend/videoProcessor.js:752-825`, `:1185-1223` | Extract the existing regex/tag alias behavior into pure functions; replace timestamp clamping and early persistence with explicit result statuses. Keep CommonJS exports and deterministic `crypto` IDs. |
| Provenance/evidence types | `backend/videoProcessor.js:1250-1290` | Reuse VTT `{start,end,sourceLanguage,sourceText,source}` shape for speech evidence; add frame/visible-text provenance without claiming captions are visible. |
| Language policy matrix | `backend/modules/audioLanguageDetector.js:107-125` | Consume exactly `korean`, `foreign`, `mixed`, `unknown`; detector errors already fail closed to `unknown`. |
| Persistence migration | `backend/database.js:31-67`, `:69-79`, `:369-401` | Use additive `try/catch` column migrations and retain `scripts` legacy columns; transaction all accepted event writes. |
| Chunk/API compatibility | `backend/database.js:516-532`, `backend/routes.js:136-150` | Keep `saveVideoChunk` and `/api/script/:videoId` legacy projections, but call only after canonical acceptance. |
| Prompt policy loader | `backend/videoProcessor.js:53-82`, `:730-740` | Centralize default to `prompt_template_codex_v2.txt`; preserve `PROMPT_FILE` override only when it includes/uses the common v2 policy contract. |
| Alternate prompt path | `backend/modules/describer.js:6-47` | Inventory and route this path through the same policy block or explicitly mark unsupported; never leave `stage2_describer.txt` as an untested bypass. |
| Player/TTS eligibility | `frontend/src/screens/PlayerScreenV2.js:466-493`, `:520-570` | Preserve `verbosity` filtering and `playDescription` flow through a canonical compatibility projection; prevent `ttsEligible=false`, quarantined, or rejected lines from `playableScript`. |
| Deterministic tests | `frontend/src/App.test.js`, `backend/test_*` scripts | Backend has no assertion framework. Use Node 24 built-in `node:test`; keep fixtures inline or in a small backend fixture module and avoid network/media commands. |

## Data flow to preserve

```text
Gemini/legacy line
  -> canonical parser
  -> structural + language/provenance + cross-event validation
  -> accepted/quarantined/rejected result
  -> accepted persistence + SSE
  -> legacy API projection
  -> player eligibility/TTS selection
```

## Repository conventions

- Backend modules use CommonJS (`require`, `module.exports`) and camelCase filenames.
- SQLite schema changes are performed at startup with additive `SELECT` probes followed by `ALTER TABLE`.
- Database writes are wrapped in `better-sqlite3` transactions; preserve short transactions and `INSERT OR IGNORE` semantics only where deterministic IDs make idempotency safe.
- Existing output IDs are SHA-256 hashes of raw lines. Canonical IDs should hash normalized canonical fields so whitespace-only model changes do not create duplicates.
- Existing SSE event names are `start`, `status_update`, `script_chunk`, and `end`; Phase 1 should not rename them.
- Player compatibility expects `verbosity` values `v1`, `v2`, `v3`, `text`, and `translation`; the adapter must continue to provide these values.

## Test conventions for the plan

- Use `node:test` and `node:assert/strict`; tests must run under `backend/package.json` CommonJS without adding a dependency.
- No test should load production `.env`, call Gemini, download YouTube media, run FFmpeg/Whisper, or synthesize TTS.
- Table-driven fixtures should assert exact status (`accepted`, `quarantined`, `rejected`), reason codes, legacy tag/verbosity, timestamp, and `ttsEligible` values.
- Run the focused canonical test after each task and the full Phase 1 test list after each wave.
