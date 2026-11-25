---
phase: quick-261125-nhn-fix-mixed-audio-dubbing-and-vtt-gaps
plan: 261125-nhn
type: execute
wave: 1
depends_on: []
files_modified:
  - backend/modules/audioLanguageDetector.js
  - backend/videoProcessor.js
  - backend/prompt_template_writer_v13.txt
  - backend/prompt_template_codex_v2.txt
  - backend/tests/audioLanguageDetector.test.js
  - backend/test_subtitle_provenance.js
autonomous: true
---

# Quick Plan 261125-nhn: Fix Mixed-Audio Auto-Dubbing & VTT Gap Translation Drops

## Root Causes Verified (Video `YXLWe_pqmjU`)
1. `yt-dlp` format `-f best[height<=360][vcodec!=none][acodec!=none]/best[height<=360]` selected `format 18` (`lang=en`, YouTube auto-dubbed English audio) instead of original Korean audio (`format_note*=original`, `language_preference>=10`).
2. Fixed 3-point Whisper sampling (`20%, 50%, 80%`) hit English interview segments on all three probes (`124s, 310s, 497s`), misclassifying a 60% Korean / 40% English `mixed` documentary as `foreign` even on original audio.
3. Without confidence filtering, expanding sampling risks flipping pure Korean (with hardcoded subtitles) or pure English videos to `mixed` on single BGM/silence noise probes.
4. YouTube Korean ASR omits major English interview segments in `ko.vtt` and stretches preceding Korean cue end-timestamps across English speech; `provenanceForModelCandidate` also rejects valid screen-translated `[trans]` events falling in VTT gaps.

## Tasks
1. **Audio Language Detector hardening & mixed foreign timeline** (`backend/modules/audioLanguageDetector.js`):
   - Parse Whisper probability `p` alongside language code.
   - Use duration-adaptive multi-point sampling (3 / 5 / 9 points) with `25000ms` FFmpeg slice timeout.
   - Ignore low-confidence probes (`p < 0.70`) and single non-dominant outliers below `p >= 0.90` on 5+ point runs so pure Korean and pure English videos do not flip to `mixed`.
   - Add `detectForeignAudioSegments` (10s grid + 5s boundary refinement for `p < 0.75`, chunked FFmpeg extraction, fail-safe `[]` on error) invoked only for `mixed` videos.
2. **Original audio format, mixed dialogue enrichment, and boundary provenance** (`backend/videoProcessor.js`):
   - Prefer `format_note*=original` / `language_preference>=10` DASH streams with `--merge-output-format mp4`, falling back to `best[height<=360][vcodec!=none][acodec!=none]/best[height<=360]` for single-audio videos in both `processVideo` and `processVideoBatch`.
   - Enrich `mixed` `dialogueTrack` with `enrichMixedDialogueTrackWithAudioSegments`: clamp bloated Korean cue tails overlapping confirmed foreign audio, mark overlapping English cues (`[음악]`/`[웃음]` stripped) as `foreign: true`, and inject `whisper_audio_timeline` markers for uncovered foreign segments.
   - Allow `mixed` `[trans]` provenance fallback when a timestamp falls within ±2s of a confirmed `foreignAudioSegments` interval with frame evidence.
3. **Prompt guidance** (`backend/prompt_template_writer_v13.txt`, `backend/prompt_template_codex_v2.txt`):
   - Document `whisper_audio_timeline` / `[FOREIGN_AUDIO_CONFIRMED_VTT_MISSING]` handling for `mixed` videos while keeping all v2 policy markers and Korean non-duplication boundaries intact.
4. **Deterministic unit tests & full regression verification** (`backend/tests/audioLanguageDetector.test.js`, `backend/test_subtitle_provenance.js`).
