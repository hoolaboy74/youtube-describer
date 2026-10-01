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

Tests cover VFR/nonzero origin, static B-frame cadence, key thinning, integer/rational PTS, unsafe preflight, decoder/preflight mismatch before publication, duplicate/replay behavior, incomplete coverage, publication failure, cancellation/staging cleanup, shared full-decode permits and existing frames-v1 cache reuse (updated per user request below).

Initial backend suite: 130/130 passed. After the last additions, 132/133 passed, with one existing real-time deadline test delayed for 617 seconds during an observed local execution pause/SSH disconnection. That test passed when rerun (46.1 seconds). Additional canonical/CLI/subtitle/prompt suites: 24/24 passed. Final combined release run (`node --test backend/tests/*.test.js backend/test_*.js`): **157/157 passed**, 46.44 seconds, no failures or skips.

## Artifacts

- Implementation: backend/modules/frameExtraction.js, mediaResourceLimiter.js, qaMedia.js and videoProcessor.js.
- Reproduction: backend/bin/benchmark-frame-extraction.js FIXTURE_ROOT OUTPUT_ROOT 3. BENCH_CASES selects comma-separated fixture names.
- Server fixtures/results: /home/chacha/frame-methods-20261001-uCtxnH and /home/chacha/frame-implementation-20261001/results-final.
- Local benchmark JSON: /tmp/youtube-frame-implementation/summary.json.
- Final cache policy: continue reading/writing frames-v1. Existing stored frames and ready jobs are reused; no bulk regeneration or migration. Raw-source/subtitle cache versions are preserved.

## Test deployment

Deployed application revision: **d28ae3d79abda95725f2820c202c966f3bf22838**. Test site: https://test.blindmom.org/. Deployment script completed successfully including frontend build. Test PM2 backend online (PID 2521788). Deployed source hashes match the local committed frame extractor, limiter, QA media and video processor.

HTTP checks: home 200, featured-videos API 200, unauthenticated auth/me 401 as expected. Served index.html hash matches the built artifact.

On-server focused tests: **44/44 passed**. Deployed module single-run extraction plus independent reference verification passed for all nine fixtures, including a two-second-GOP control with zero backfills. These post-deployment wall times are single-run smoke measurements under live host load and are separate from the three-run medians above.

| Deployed fixture | Single-run seconds | Strategy | Source verification |
|---|---:|---|---:|
| orchestra | 9.568 | single-pass | 218/218 |
| choir | 7.625 | single-pass | 167/167 |
| music-video | 5.994 | single-pass | 232/232 |
| long-talk | 25.436 | single-pass | 870/870 |
| sparse-3 | 5.722 | key-seek | 301/301 |
| sparse-12 | 7.112 | key-seek | 304/304 |
| sparse-60 | 11.851 | single-pass | 300/300 |
| sparse-180 | 11.622 | single-pass | 300/300 |
| gop2s-control | 0.931 | key-seek | 30/30 |

Artifacts: /home/chacha/frame-implementation-20261001/deploy-test.log, deployed-tests.log and deployed-results/summary.json; local copies under /tmp/youtube-frame-implementation/.

Production remained on PID 2257014 throughout deployment. Production extractor SHA256 0045fd50f2b3c7a9a400bb0220588c5a93f0dbc84047836c6d22081160f76753 and QA media SHA256 b6b67be5a824c865c4f33c4866e4dd3f80d2806ef203eaac6eadced58b89b586 are unchanged. No main merge or production deployment was performed.

User acceptance: use a video without an existing generated-script cache to observe fresh extraction. Check wait until AI starts, visual description of static scenes, and QA frame timing. Await the user’s confirmation before main integration/production deployment.

## Existing-cache compatibility correction

User explicitly requested reuse of all existing saved caches on 2026-10-01. Reverted the frame cache namespace to frames-v1 while retaining the new extraction strategies and timestamp checks for newly extracted media. Existing files/rows/ready jobs are used as saved, with the pre-existing file/checksum validation. No cache purge, migration or timestamp rewrite.

Read-only test-server inventory before this correction: 3,553 frames-v1 assets and no frames-v2 assets. Regression fixtures cover literal frames-v1 data surviving coordinator restart, cache-only summaries and ordinary QA with default warming doing zero downloads/extractions, unchanged stored rows/job state, and new pipeline frames saved alongside existing assets in frames-v1.

Correction local validation: 51/51 passed (`qaMedia`, `frameExtraction`, `mediaResourceLimiter`, `qaPipelineFoundation`, `qaRoutes`). Test redeployment verification follows.
