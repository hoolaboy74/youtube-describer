# Adaptive frame extraction validation — 2026-10-01

Scope: test branch only. Main and production deployment require user acceptance after testing.

## Extraction benchmarks

Same downloaded fixtures on mom, three sequential repetitions each. QA storage, AI calls and downloads excluded. New times include the independent key-timeline preflight and JPEG validation. Baseline is the earlier three-run measurement on the same host/files, not a simultaneous load-controlled A/B run.

| Fixture | Previous current median (s) | Implemented auto median (s) | Selected path | Verified source frames |
|---|---:|---:|---|---:|
| orchestra | 16.12 | 7.306 | single-pass | 218/218 |
| choir | 19.9 | 6.026 | single-pass | 167/167 |
| music-video | 7.14 | 4.754 | single-pass | 232/232 |
| long-talk | 73.48 | 18.826 | single-pass | 870/870 |
| sparse-3 | 3.86 | 4.682 | key-seek | 301/301 |
| sparse-12 | 4.5 | 5.176 | key-seek | 304/304 |
| sparse-60 | 8.64 | 7.998 | single-pass | 300/300 |
| sparse-180 | 18.54 | 7.934 | single-pass | 300/300 |

All 24 extraction runs completed with no coverage holes or failed targets. Per-fixture hashes/PTS are deterministic across the three runs. An independent full decode using source integer PTS/time_base verified all 2,692 selected frames with identical JPEG hashes and zero timestamp difference.

The 3/12/60/180 backfill fixtures are 600-second synthetic GOP controls. The four named real fixtures are orchestra bg6nf6PTiVg, choir HcrSZqWju-Y, MV HGpyXfCqBCk and long talk 7Nqb1X25WJk. Earlier historical nominal-fps counts do not establish actual source coverage.

Few-backfill preflight adds about 0.7–0.8 seconds in these controls; these cases remain faster than always fully decoding. Initial duration-scaled crossover is an estimate for this host/360p media and should be reviewed against the new strategy/timing logs.

Orchestra/MV key-only PTS are unsafe and select full decoding automatically. A separate exact half-millisecond rounding issue was found during source verification and fixed with rational integer rounding; regression tests cover both positive and negative boundaries.

## Regression checks

Tests cover VFR/nonzero origin, static B-frame cadence, key thinning, integer/rational PTS, unsafe preflight, decoder/preflight mismatch before publication, duplicate/replay behavior, incomplete coverage, publication failure, cancellation/staging cleanup, shared full-decode permits and exclusion of frames-v1 cache.

Initial backend suite: 130/130 passed. After the last additions, 132/133 passed, with one existing real-time deadline test delayed for 617 seconds during an observed local execution pause/SSH disconnection. That test passed when rerun (46.1 seconds). Additional canonical/CLI/subtitle/prompt suites: 24/24 passed. Final combined release run (`node --test backend/tests/*.test.js backend/test_*.js`): **157/157 passed**, 46.44 seconds, no failures or skips.

## Artifacts

- Implementation: backend/modules/frameExtraction.js, mediaResourceLimiter.js, qaMedia.js and videoProcessor.js.
- Reproduction: backend/bin/benchmark-frame-extraction.js FIXTURE_ROOT OUTPUT_ROOT 3. BENCH_CASES selects comma-separated fixture names.
- Server fixtures/results: /home/chacha/frame-methods-20261001-uCtxnH and /home/chacha/frame-implementation-20261001/results-final.
- Local benchmark JSON: /tmp/youtube-frame-implementation/summary.json.
- Previous frames-v1 are preserved but not selected for new QA evidence; raw-source/subtitle cache versions are preserved.

## Test deployment

Pending final regression run and test deployment. Production hashes/PID were captured before deployment for verification.
