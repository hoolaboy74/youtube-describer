# Adaptive frame extraction — test implementation

Authorized 2026-10-01: implement on test, validate and deploy test; main/production wait for user acceptance.

Preserve actual visual evidence approximately every two seconds even in static performances, existing frame API and keyframe/backfill provenance. QA storage time is outside this benchmark.

1. Probe original key PTS and compare best-effort timestamps/order/decoder warnings before choosing the key-only path. Missing or unreliable metadata forces full decode.
2. Few backfills: key-only extraction, independently compare output PTS with preflight before publication, then bounded individual seeks.
3. Many backfills: one full decode selects the actual two-second grid plus real keys at least one second apart. Keep source integer PTS/time_base, no synthetic fps timestamps.
4. Duration-scaled initial cost model from the 600-second benchmark: seek incremental cost 0.11 seconds/target versus full/key cost difference 0.01 seconds/source-second plus 0.3 seconds. This is an estimate, not a universal hardware constant. Verify 3/12/60/180 backfill controls and real orchestra/choir/MV/long talk with the implemented auto selector.
5. Bound full decodes to two within the existing shared process limiter; retain cancellation, disk budgets and incomplete-coverage failure behavior. Keep frames-v1 as explicitly requested by the user; reuse existing stored frames without bulk invalidation, regeneration or migration. Preserve source/subtitle caches.
6. Tests: original timestamp mismatch, VFR/nonzero origin, B frames, static cadence, thinning/keys, replay determinism, publication failure, abort cleanup/resource release, existing cache reuse without extraction across restart. Run existing backend regression/policy suites.
7. Reproduce three runs per downloaded fixture without QA storage; independently fully decode selected source timestamps and compare JPEG hashes exactly. Commit only this change, push test, deploy via the test deployment script, check PM2/API/site and run deployed extraction smoke test. Record results and deployment revision.
