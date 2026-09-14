# Readable Q&A cache paths — 2026-09-14

New Q&A assets use:

```
backend/cache/qa/
  assets/<videoId>/frames/<cacheVersion>/<sourcePtsMs>-<checksum>.jpg
  assets/<videoId>/subtitles/<cacheVersion>/<checksum>.vtt
  jobs/<videoId>/source.json
  jobs/<videoId>/<work-kind>-<unique-suffix>/...
```

Video IDs and versions are validated path components. Checksummed filenames, SQLite relative paths, version isolation, leases, resource limits and atomic publication are unchanged. Both new-generation frame publication and existing-video cache misses use the shared manager.

Existing hashed asset paths remain valid through DB references; they are not moved or downloaded again. Raw source lookup supports both the new video-ID job folder and the old SHA256 folder. Cleanup protects active work in both layouts. Existing files are not bulk migrated in this change.

## Deployment unification

Because production has no previous Q&A deployment, all runtime Q&A paths now use the same cache service. Interactive and batch video generation always publish extracted frames through the pipeline coordinator. Downloaded captions are published to the same subtitle store (unknown provenance unless independently verified); failure is logged and remains retryable on demand. No-caption generation does not persist a false permanent absence marker.

Both incremental and legacy-response Q&A endpoints prepare evidence through createQaMedia; the old endpoint no longer has its own downloader, inferred frame timestamps, public directory scanner or subtitle cache. Its response transport remains compatible, and fromCache reflects whether the requested frame window was available before preparation. All public/frames and public/subtitles generator writes and runtime reads are removed. Periodic job cleanup runs for the shared store regardless of the incremental feature flag. The UI feature flag still controls incremental speech, not the cache directory.

Existing developer hash paths remain readable through DB references; all new writes use the video-ID layout. No production migration or public-directory prerequisite is needed. Keep the configured QA_CACHE_ROOT and DB persistent, and restart the backend after deployment. This change does not delete local historical directories or claim live search execution is verified.

Isolated backend regression suite: **123 passed**. Verification includes readable frame/VTT paths, unsafe path rejection, historical asset preservation across reconciliation, historical source reuse after restart, shared source orderings and current-window reuse. No changes to UI, model prompts, output processing or TTS behavior.


Unification verification: **125 backend regression tests passed** using isolated SQLite. Generator-caption reuse, missing-caption retry and truthful cold/warm metadata are covered. The explicit clear-cache maintenance script now addresses the configured QA cache root and matching media index tables; it was syntax-checked, not executed. No production deployment, cache deletion or environment change was performed. Storage unification does not require enabling incremental speech, but the new conversational/streaming UI still requires QA_INCREMENTAL_SPEECH_ENABLED=true.
