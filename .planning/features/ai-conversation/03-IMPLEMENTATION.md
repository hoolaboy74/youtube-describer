# 03 — Current window and full cache coordination

Implemented on the test branch; opt-in through `QA_CACHE_WARMING_ENABLED=true` for generation integration. The new request API will call `getQaMedia().prepare` in stage 04.

- Independent window, subtitle and full-cache leases share verified frame assets. Questions in a 10-second bucket share extraction; returned frames never exceed the question timestamp.
- Subtitle preparation begins concurrently. Verified VTT assets override negative state; cue parsing is memoized and file checksums checked before reuse. Unproven caption language remains unknown.
- Current windows use cached JPEGs, local MP4, then a timestamp-preserving remote section. Original source start PTS is independently probed. A completed full source cancels the section before removing its temporary directory.
- Full MP4 manifests preserve checksum and path for retry/restart; hashing streams through bounded memory. Full warming failure does not discard published frames or fail an already prepared window.
- Interactive and batch generation announce their source before downloading, publish frames immediately through the same fenced writer, and make Q&A warming await that extraction. Source readers finish before generator cleanup.
- Cancellation belongs to each question waiter. Shared media work remains usable by other viewers. Full warming checks presence after a five-minute grace.

Validation: isolated backend suite **83/83 passed**, including new tests for window sharing, subtitle concurrency, future-frame exclusion, cancellation isolation, pipeline reuse and source-winning section cancellation. Existing real-download/PTS evidence is in RESULTS.md; this coordinator has not yet been measured on mobile or declared released.

Remaining integration/operational checks: presence wiring, request-location priority for full backfill, periodic orphan job-directory cleanup, recovery after runtime asset corruption, and the race where Q&A starts a full video-only download before the main audio-bearing generator starts. The pipeline-first case shares work; no claim is made that the reverse ordering shares its audio download. Stage 06 must retain these as release checks.
