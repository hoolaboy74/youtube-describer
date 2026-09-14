# 03 — Current window and full cache coordination

Implemented on the test branch; opt-in through `QA_CACHE_WARMING_ENABLED=true` for generation integration. The new request API will call `getQaMedia().prepare` in stage 04.

- Independent window, subtitle and full-cache leases share verified frame assets. Questions in a 10-second bucket share extraction. Following the user correction on 2026-09-14, Q&A returns up to eight verified frames within T ± 4 seconds, clipped at video boundaries. The `window-v2` lane extracts through the bucket end plus four seconds so questions near a bucket boundary retain after-frames; existing frame assets remain reusable. Direct historical-only callers retain the previous default.
- Subtitle preparation begins concurrently. Verified VTT assets override negative state; cue parsing is memoized and file checksums checked before reuse. Unproven caption language remains unknown.
- Current windows use cached JPEGs, local MP4, then a timestamp-preserving remote section. Original source start PTS is independently probed. A completed full source cancels the section before removing its temporary directory.
- Full MP4 manifests preserve checksum and path for retry/restart; hashing streams through bounded memory. Full warming failure does not discard published frames or fail an already prepared window.
- Interactive and batch generation announce their source before downloading, publish frames immediately through the same fenced writer, and make Q&A warming await that extraction. Source readers finish before generator cleanup.
- Cancellation belongs to each question waiter. Shared media work remains usable by other viewers. Full warming checks presence after a five-minute grace.

Validation: isolated backend suite **83/83 passed**, including new tests for window sharing, subtitle concurrency, out-of-window frame exclusion, cancellation isolation, pipeline reuse and source-winning section cancellation. Existing real-download/PTS evidence is in RESULTS.md; this coordinator has not yet been measured on mobile or declared released.

Follow-up hardening now wires presence, request-location priority, orphan cleanup and runtime corruption repair. A separate `raw-source-v1` lease and an `av-v1` manifest share the complete audio-bearing MP4 regardless of whether Q&A or the generator starts first. Generator files use hard links (bounded copy on another volume), so removing the cache cannot remove an in-use generator file. Old video-only manifests are not promoted to this source version. Subtitles may be fetched separately when a generator adopts a Q&A source. Both orderings and reuse after extraction failure/restart are covered by tests; live AV format validation is recorded in RESULTS.md.
