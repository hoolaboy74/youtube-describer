---
phase: quick-261125-oqy-gemini-audio-language-analysis
plan: 261125-oqy
status: complete
subsystem: audio-analysis
tags: [gemini-3.8-flash, audio, ffmpeg, performance, mixed-audio]
provides:
  - single-pass Gemini 3.8 Flash compact-audio language classification and mixed foreign-segment extraction
  - api_costs tracking under request_type=audio_analysis
  - elimination of 4-vCPU local Whisper bottleneck on mixed videos
affects: [audioLanguageDetector, videoProcessor]
tech-stack:
  added: []
  patterns: [compact 24k mono mp3 inlineData audio analysis in parallel with keyframe extraction]
key-files:
  created: []
  modified:
    - backend/modules/audioLanguageDetector.js
    - backend/videoProcessor.js
    - backend/tests/audioLanguageDetector.test.js
key-decisions:
  - "Extract 16kHz mono 24kbps MP3 (~1.8MB per 10min, fallback 16kbps if >18MB) and send inline to Gemini 3.8 Flash instead of Files API upload."
  - "Request MM:SS timestamps with temperature=0 and responseMimeType=application/json, then validate/clamp/merge server-side and preserve unknown/[] fail-safe on errors."
  - "Set GEMINI_AUDIO_TIMEOUT_MS default to 90000ms to accommodate up to 30-minute videos with thinking tokens."
completed: 2026-11-25
---

# Quick Task 261125-oqy: Single-Pass Gemini 3.8 Flash Audio Language Analysis

**Replaced local CPU-bound Whisper multi-point and timeline scanning (134s on production 4-vCPU VM) with a single parallel Gemini 3.8 Flash compact-MP3 analysis call (~28.8s, 1-second precision across all 13 English segments on `YXLWe_pqmjU`).**

## Accomplishments

- Rewrote `backend/modules/audioLanguageDetector.js` to extract a compact 16kHz mono 24kbps MP3 (downscaling to 16kbps if over 18MB) and analyze full audio in one `gemini-3.8-flash` JSON call (`analyzeAudioLanguage`), keeping `detectLanguage` backwards-compatible.
- Updated `backend/videoProcessor.js` (`processVideo` and `processVideoBatch`) to invoke `analyzeAudioLanguage` in parallel with `extractKeyframesHybrid` and persist provider usage via `db.recordGeminiUsage({ requestType: 'audio_analysis' })`.
- Updated `backend/tests/audioLanguageDetector.test.js` with deterministic tests covering `MM:SS`/`HH:MM:SS`/numeric parsing, fenced/malformed JSON handling, non-mixed segment clearing, clamping/merging, prompt bounds, and offline fail-safe behavior.

## Task Commits

1. **Gemini audio analyzer, videoProcessor wiring, and unit tests** - `3d1a94a`

## Verification

- `cd backend && node --check modules/audioLanguageDetector.js && node --check videoProcessor.js` — passed.
- `cd backend && node --test tests/audioLanguageDetector.test.js test_subtitle_provenance.js test_audio_language_policy.js test_prompt_policy.js test_canonical_output.js test_canonical_integration.js test_cli_canonical_output.js` — 48 passed, 0 failed.
- Live Gemini 3.8 Flash smoke test on `YXLWe_pqmjU` original Korean audio (`1.78 MB MP3`): `elapsedMs=28824`, `audioLanguage=mixed`, `foreignSegments=13` (`16-40s`, `62-108s`, `114-137s`, `158-179s`, `268-288s`, `295-321s`, `348-361s`, `374-400s`, `430-461s`, `494-527s`, `557-561s`, `568-575s`, `608-613s`), `totalCostUsd=0.024926`.

## Self-Check: PASSED

- Commit `3d1a94a` verified on `main`.
