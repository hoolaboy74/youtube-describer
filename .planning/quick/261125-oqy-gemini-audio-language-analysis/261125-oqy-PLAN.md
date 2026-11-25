---
phase: quick-261125-oqy-gemini-audio-language-analysis
plan: 261125-oqy
type: execute
wave: 1
depends_on: []
files_modified:
  - backend/modules/audioLanguageDetector.js
  - backend/videoProcessor.js
  - backend/tests/audioLanguageDetector.test.js
autonomous: true
---

# Quick Plan 261125-oqy: Replace Local Whisper Audio Analysis with Gemini 3.8 Flash

## Problem
On the production 4-vCPU GCP VM (`e2-custom-4-8192`), local Whisper multi-point detection (9 probes = 18s) plus `mixed` 10s-grid scanning (70 probes = 116s) took 134s after download before AI script generation could begin.

## Solution
Replace local Whisper execution in `backend/modules/audioLanguageDetector.js` with a single compact-audio Gemini 3.8 Flash JSON analysis call (`analyzeAudioLanguage`), executed in parallel with `extractKeyframesHybrid`:
1. Extract a compact mono 16kHz 24kbps MP3 track via FFmpeg (`~1.8 MB` per 10 min; downscales to 16kbps if >18MB) and send via `inlineData` (no Files API upload latency).
2. Request strict JSON (`audioClassification` + `MM:SS` `foreignSegments` for `mixed` only) at `temperature: 0` using `GEMINI_AUDIO_MODEL || GEMINI_MODEL || 'gemini-3.8-flash'`.
3. Parse and validate `MM:SS`/`HH:MM:SS`/numeric timestamps within `[0, totalDuration]`, merge adjacent non-Korean segments, clean up temporary audio files unconditionally, and fail conservatively to `'unknown'` with `[]` on error (preserving offline test contracts).
4. Wire `analyzeAudioLanguage` into both `processVideo` and `processVideoBatch` in `backend/videoProcessor.js` and record provider usage via `db.recordGeminiUsage({ requestType: 'audio_analysis' })`.
5. Keep `detectLanguage` backwards-compatible for existing callers and tests (`qaPipelineFoundation.test.js`, `compare_model.js`).
6. Verify with deterministic unit tests + a live Gemini 3.8 Flash test against `YXLWe_pqmjU`, then deploy to production.
