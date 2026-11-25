---
phase: quick-261125-nhn-fix-mixed-audio-dubbing-and-vtt-gaps
plan: 261125-nhn
status: complete
subsystem: audio-detection-and-script-pipeline
tags: [yt-dlp, whisper, mixed-audio, provenance, prompts]
provides:
  - original-audio-first yt-dlp format selection bypassing YouTube auto-dubbing
  - duration-adaptive multi-point confidence-filtered Whisper language detection
  - mixed-audio foreign timeline scanning and VTT-gap dialogue enrichment
  - +/-2s foreign audio boundary provenance fallback for mixed [trans] events
affects: [videoProcessor, audioLanguageDetector, prompts]
tech-stack:
  added: []
  patterns: [confidence-filtered multi-point audio classification, whisper audio timeline VTT gap enrichment]
key-files:
  created:
    - backend/tests/audioLanguageDetector.test.js
  modified:
    - backend/modules/audioLanguageDetector.js
    - backend/videoProcessor.js
    - backend/prompt_template_writer_v13.txt
    - backend/prompt_template_codex_v2.txt
    - backend/test_subtitle_provenance.js
key-decisions:
  - "Prefer DASH format_note*=original and language_preference>=10 with --merge-output-format mp4, falling back to single-file 360p for non-dubbed videos."
  - "Filter Whisper probes below p=0.70 and require either >=2 samples or p>=0.90 for a minority language on 5+ point runs to prevent pure Korean or pure English videos from flipping to mixed."
  - "Run full 10s-grid + 5s-boundary foreign audio timeline scan only when audioLanguage is classified as mixed, in parallel with keyframe extraction."
completed: 2026-11-25
---

# Quick Task 261125-nhn: Fix Mixed-Audio Auto-Dubbing & VTT Gap Translation Drops

**Original audio tracks are now prioritized over YouTube auto-dubbed tracks, multi-point confidence-filtered Whisper classification prevents pure-video misrouting and mixed-documentary misdetection, and mixed videos enrich missing ASR VTT foreign speech segments with Whisper audio timeline markers and boundary provenance.**

## Accomplishments

- Updated `backend/modules/audioLanguageDetector.js` to parse Whisper confidence `p`, adapt sample counts to video duration (3 / 5 / 9 points), drop low-confidence noise (`p < 0.70`), guard against single moderate-confidence outliers (`p < 0.90`) on 5+ point runs, and add `detectForeignAudioSegments` (chunked 10s grid + 5s boundary refinement, fail-safe `[]`) for `mixed` videos.
- Updated `backend/videoProcessor.js` (`processVideo` and `processVideoBatch`) to use `YTDLP_FORMAT_SELECTOR` with `--merge-output-format mp4`, run `detectForeignAudioSegments` in parallel with keyframe extraction for `mixed` videos, enrich `dialogueTrack` via `enrichMixedDialogueTrackWithAudioSegments` (clamping bloated Korean VTT tails, stripping non-speech tags like `[음악]`/`[웃음]` when marking English cues, and inserting `whisper_audio_timeline` markers in VTT gaps), and allow ±2s `foreignAudioSegments` + frame provenance fallback for `mixed` `[trans]` candidates.
- Updated `backend/prompt_template_writer_v13.txt` and `backend/prompt_template_codex_v2.txt` with explicit `mixed` guidance for `whisper_audio_timeline` / `[FOREIGN_AUDIO_CONFIRMED_VTT_MISSING]` intervals while keeping all codex-v2 policy markers and Korean non-duplication rules intact.
- Added deterministic unit test coverage in `backend/tests/audioLanguageDetector.test.js` and extended `backend/test_subtitle_provenance.js`.

## Task Commits

1. **Implementation & unit tests** - `c85bbc2`

## Verification

- `cd backend && node --check modules/audioLanguageDetector.js && node --check videoProcessor.js` — passed.
- `cd backend && node --test tests/audioLanguageDetector.test.js test_subtitle_provenance.js test_audio_language_policy.js test_prompt_policy.js test_canonical_output.js test_canonical_integration.js test_cli_canonical_output.js` — 48 passed, 0 failed.
- `cd backend && node --test tests/mediaResourceLimiter.test.js` — 8 passed, 0 failed.
- `loadPolicyPrompt` validated both `prompt_template_codex_v2.txt` and `prompt_template_writer_v13.txt`.
- Diagnostic A/B verification script (`test_scripts/diagnose_mixed_dubbing.js` on `YXLWe_pqmjU`) confirmed original Korean audio selection (`134+140-3`), `mixed` detection (9-point `765ms`), 0 Korean narration duplicate `[trans]`, and 6/6 recovery of previously missing English interview segments.

## Self-Check: PASSED

- Commit `c85bbc2` is present on `main`.
- All modified and created files verified.
