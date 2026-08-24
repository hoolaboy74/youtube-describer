# Phase 1: Canonical Output, Provenance & v2 Policy - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md; this log preserves the alternatives considered.

**Date:** 2026-08-24
**Phase:** 1-Canonical Output, Provenance & v2 Policy
**Areas discussed:** Provenance data contract, Language and duplication policy, Validation and quarantine boundary, Prompt path compatibility

> Interactive selection was unavailable in the current execution mode. The skill fallback selected the recommended scope (all four areas) and recorded the conservative defaults below.

## Provenance data contract

| Option | Description | Selected |
|--------|-------------|----------|
| Legacy fields only | Keep `id/timestamp/text/verbosity` as the complete internal contract. | |
| Typed canonical event with compatibility adapter | Preserve evidence, language, policy, validation, and TTS decisions internally; map to legacy fields at the boundary. | ✓ |
| Provenance only in logs | Keep playback data unchanged and record evidence outside the script. | |

**Default decision:** Use a typed canonical event with stable ID, evidence/provenance, audio-language context, policy version, validation status/reasons, and TTS eligibility; retain legacy DTO fields.

## Language and duplication policy

| Option | Description | Selected |
|--------|-------------|----------|
| Prompt-only language policy | Trust the model to decide translation and duplicate suppression. | |
| Conservative four-state gate | Korean/unknown suppress transcript translation; foreign translates only needed confirmed speech; mixed translates confirmed non-Korean intervals; independent visible text remains distinct. | ✓ |
| Translate whenever a subtitle exists | Any non-empty subtitle track may become `[trans]`. | |

**Default decision:** Enforce the conservative four-state gate in parsing, persistence, and later TTS selection.

## Validation and quarantine boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Validate only at final save | Continue streaming parsed lines and clean them up at the end. | |
| Validate before publication, quarantine unsafe candidates | Reject hard-invalid lines, quarantine ambiguous lines with reasons, and publish only accepted canonical events. | ✓ |
| Drop all invalid output silently | Keep the playable script clean without retaining rejection details. | |

**Default decision:** A candidate must pass canonical validation before SSE or playable persistence; invalid/ambiguous candidates retain machine-readable rejection reasons outside playable output.

## Prompt path compatibility

| Option | Description | Selected |
|--------|-------------|----------|
| Keep existing defaults and patch v2 selectively | Preserve `prompt_template.txt` as default and apply v2 only in selected paths. | |
| Common v2 baseline plus path-specific additions | Make `prompt_template_codex_v2.txt` mandatory for all paths; allow additions that cannot weaken invariants. | ✓ |
| Replace all legacy output immediately | Remove old tags/fields and update every consumer in one breaking change. | |

**Default decision:** Common v2 baseline for interactive, batch, and alternate describer paths; resolve default drift toward v2; preserve legacy serialization at the boundary.

## the agent's Discretion

- Exact field names, module boundaries, schema migration, quarantine storage, normalization algorithm, thresholds, and sentence-length metric.

## Deferred Ideas

None — scope stayed within Phase 1.
