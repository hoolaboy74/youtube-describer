# Frame density and current-window correction — 2026-09-14

The shared extractor used by both new video generation and Q&A full warming retains `-skip_frame nokey`, then selects frames at least one second apart **before** scaling, JPEG encoding and publication. Source PTS and legacy ordered frame filenames remain unchanged. This limits stored images even when the decoder outputs every frame; it does not claim to eliminate decoding cost or explain the original source codec's keyframe flags.

Backfill checks actual adjacent timestamps rather than a fixed two-second sampling grid. A gap exceeding 2000 ms receives targets spaced 1500 ms apart until the remaining gap is at most 2000 ms, leaving headroom for seeking to a real frame. The start must be within 1000 ms, and the tail within 2000 ms. Final actual PTS coverage is validated; missing/very sparse source frames or failed seeks cannot silently mark an incomplete cache ready. Backfill concurrency stays bounded at two.

Q&A reads metadata for the full T ± 4000 ms interval, preserving both endpoints and the nearest frame at or before T, then filling the eight-frame budget by temporal spacing. It checks only selected JPEG checksums, substituting other candidates when a selected file is invalid. There is no last-100-frames cutoff; old dense caches remain usable. Cache hits require a past frame as well as interval coverage. The existing 0.9-second local-window extractor remains available for missing intervals.

Verification: isolated backend regression suite **120 passed**. Real six-second 30fps all-intra fixture yields six JPEGs at 0–5 seconds instead of 180. VFR/nonzero-origin PTS, backfill failures, legacy filenames, dense-cache anchoring and repeated hits are covered by deterministic/real-FFmpeg tests. A copy of the local DB plus read-only existing snQEo87bWrA assets produced:

- T=9247 ms: [5272,7240,8241,9242,10244,11245,12246,13247], anchor 9242, window_hit.
- T=25774 ms: [21788,23757,24758,25759,26760,27761,28762,29763], anchor 25759, window_hit.

No real-model request, download, cache deletion or live DB update was required. Existing dense files are retained; the storage reduction applies to newly extracted caches. Backend restart loads the corrected selection and extraction code. Q&A format-only answer processing and model-owned search are unchanged. No frontend interaction changes.
