# Current window fallback — 2026-09-14

Production log for YmEnygA7pHc: request 21:58:31, source downloaded 21:59:04, request aborted 22:00:31, full frames completed 22:00:32, window completed 22:00:47. The 120-second total deadline expired before model invocation. Moving the first-sentence timer did not address this wait.

The section-download failure branch awaited ensureFullCache, which includes the entire keyframe/backfill extraction. It now waits only for the shared source via getSource, then extracts the question window immediately while full warming continues. Both paths reuse one downloaded source and preserve reader lifetime, leases and bounded resource concurrency. A window_source_fallback diagnostic records the error category; it does not expose signed URLs or process arguments. The historical log lacks the section error, so its underlying network/protocol cause remains unverified.

The total timeout remains 120 seconds. Timeout diagnostics now retain QA_TOTAL_TIMEOUT or QA_FIRST_SENTENCE_TIMEOUT instead of reporting the resulting AbortError as QA_GENERATION_FAILED. This change cannot guarantee an answer when source download or other preparation itself exceeds the overall deadline.

Regression coverage blocks full extraction indefinitely while forcing section failure and verifies that current-window preparation still completes with one source download. A controlled-clock test checks timeout event/log consistency. No server deployment or real-model invocation is performed.
