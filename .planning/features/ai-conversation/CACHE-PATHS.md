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

The legacy Q&A route and generator compatibility copies still use public/frames and public/subtitles. Those are not removed by this path-only change. New incremental Q&A uses the durable cache. Restart the backend to use readable paths for new writes.

Isolated backend regression suite: **123 passed**. Verification includes readable frame/VTT paths, unsafe path rejection, historical asset preservation across reconciliation, historical source reuse after restart, shared source orderings and current-window reuse. No changes to UI, model prompts, output processing or TTS behavior.
