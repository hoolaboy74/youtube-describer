---
phase: 01
slug: canonical-output-provenance-v2-policy
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-24
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in `node:test` and `node:assert/strict` |
| **Config file** | none |
| **Quick run command** | `node --test backend/test_canonical_output.js` |
| **Full suite command** | `node --test backend/test_canonical_output.js backend/test_audio_language_policy.js backend/test_prompt_policy.js` |
| **Estimated runtime** | < 5 seconds; no network/provider/media calls |

---

## Sampling Rate

- **After every task commit:** Run `node --test backend/test_canonical_output.js`
- **After every plan wave:** Run `node --test backend/test_canonical_output.js backend/test_audio_language_policy.js backend/test_prompt_policy.js`
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | POLICY-01 | T-01 / T-02 | v2 invariants, tags, timestamps, short Korean sentences, repetition rules are enforced | unit | `node --test backend/test_canonical_output.js backend/test_prompt_policy.js` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | POLICY-02 | T-03 | four audio classes produce conservative language/provenance outcomes | unit | `node --test backend/test_audio_language_policy.js` | ❌ W0 | ⬜ pending |
| 01-01-03 | 01 | 1 | POLICY-03 | T-02 / T-03 | Korean original dialogue and duplicate captions/OCR never become playable/TTS events | unit | `node --test backend/test_audio_language_policy.js backend/test_canonical_output.js` | ❌ W0 | ⬜ pending |
| 01-01-04 | 01 | 1 | POLICY-04 | T-01 / T-04 | malformed, unsafe, duplicate, overlapping, out-of-range, or TTS-ineligible events are rejected/quarantined | unit | `node --test backend/test_canonical_output.js` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `backend/test_canonical_output.js` — parser, canonical schema, serializer, validation, duplicate, overlap, and TTS eligibility fixtures
- [ ] `backend/test_audio_language_policy.js` — Korean/foreign/mixed/unknown language matrix and duplicate dialogue/OCR fixtures
- [ ] `backend/test_prompt_policy.js` — v2 default/config drift and all supported prompt path policy coverage
- [ ] `backend/test_canonical_integration.js` — accepted-only persistence, generation-path parity, and API/player TTS eligibility fixtures
- [ ] No framework installation required — Node.js 24 built-in test runner is available

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Korean TTS wording remains natural and short for representative accepted events | POLICY-01 | Naturalness and pronunciation are not fully captured by deterministic assertions | Listen to a small accepted fixture set with a Korean screen reader/TTS reviewer; confirm no raw tags, duplicated dialogue, or unnatural long sentence. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
