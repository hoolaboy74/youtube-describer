# Codebase Concerns

**Analysis Date:** 2026-09-30

## Tech Debt

**Statistics have no source/metric coverage contract:**
- Issue: Fixed queries and patterns omit QA receipts, daily QA ledgers, cache jobs, frames/subtitles, grounding, script validation/quarantine, donations and verification records.
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `backend/database.js`, `backend/modules/qaCacheStore.js`, `backend/modules/qaRequestReceipts.js`
- Impact: A report can finish without explaining significant operational state or paid usage.
- Fix approach: Maintain a schema/source coverage manifest with metric definitions, availability and reconciliation totals. The collector under audit is `/Users/chacha/src/youtube-describer/.agents/skills/analyze_system_stats/scripts/stats_collector.js`; report tooling and this test worktree are distinct targets.

**First-registration policy differs between skill and script:**
- Issue: The skill promises a first-registration lower bound, but the script computes/prints it without enforcing it; default start is 1970-01-01.
- Files: `.agents/skills/analyze_system_stats/SKILL.md`, `.agents/skills/analyze_system_stats/scripts/stats_collector.js`
- Impact: Default reports include historical development data while claiming a membership-era cutoff.
- Fix approach: Apply one explicit reporting policy and expose the effective interval.

**Startup initialization is unsuitable for read-only auditing:**
- Issue: Initialization runs column migrations, QA schema creation and cache reconciliation.
- Files: `backend/database.js`, `backend/modules/qaCacheStore.js`, `backend/modules/qaRequestReceipts.js`
- Impact: Importing application database code can mutate operational state.
- Fix approach: Use a separate SQLite read-only connection for reporting and schema inventory.

## Known Bugs

**Database/log boundaries disagree about timezone:**
- Symptoms: SQL compares local-looking dates directly to UTC CURRENT_TIMESTAMP strings; logs are bounded using +09:00, and costs also contain ISO strings. Receipts use epoch milliseconds.
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `backend/database.js`, `backend/logger.js`, `backend/modules/qaRequestReceipts.js`
- Trigger: Korean monthly reporting or mixed SQL/ISO timestamps.
- Workaround: Normalize instants per source; use half-open KST month boundaries converted to UTC, then convert grouping dates/hours to KST. Inclusive 23:59:59 loses fractional-second events.

**Cross-correlation appends Z twice:**
- Symptoms: SQL projections emit `%Y-%m-%dT%H:%M:%SZ`; JavaScript appends another Z, producing invalid Date values.
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`
- Trigger: Parsing watchLogs or apiRequests for Nginx correlation.
- Workaround: Parse normalized ISO strings once and count invalid dates explicitly.

**One-to-many cost joins multiply videos:**
- Symptoms: Top-requester COUNT(*) and SUM(video.duration) run after LEFT JOIN api_costs, while cost rows are not restricted by period/request type.
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `backend/database.js`
- Trigger: Multiple paid attempts or QA costs share videoId.
- Workaround: Aggregate video counts/duration separately; pre-aggregate period/type-filtered costs; attribute QA cost to its actual user, not the video requester.

**Build latency uses a cost-record proxy:**
- Symptoms: Video creation-to-each-cost-row timestamp differences are presented as processing latency and values over three hours are discarded.
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `backend/database.js`
- Trigger: Reprocessing, QA usage or delayed cost persistence.
- Workaround: Label the timing proxy explicitly until description attempt/start/completion events exist.

**Watch/favorite snapshots cannot count historical events:**
- Symptoms: Watches upsert watchedAt on UNIQUE(userId, videoId) and retain only 20 per user; unlike removes a favorite row.
- Files: `backend/database.js`, `.agents/skills/analyze_system_stats/scripts/stats_collector.js`
- Trigger: `addWatchHistory()` repeats/prunes or `toggleFavorite()` deletes.
- Workaround: Label surviving latest history/current favorites as snapshots. Add append-only events for future playback/like activity; requests are not completed-view evidence.

## Security Considerations

**Identity estimates and personal telemetry:**
- Risk: Shared/changing IP addresses and current lastLoginIp misclassify historical membership. Raw user/guest/IP exports and audio capability URLs can expose sensitive information.
- Files: `backend/routes.js`, `backend/database.js`, `.agents/skills/analyze_system_stats/scripts/stats_collector.js`
- Current mitigation: Middleware redacts QA audio tickets; collector masks requester name/email; api_requests records userId/guestId.
- Recommendations: Aggregate server-side, prefer authenticated request identity, preserve ticket redaction and label IP-based estimates. The collector already queries api_requests; its gap is incomplete aggregation/use, not complete omission.

## Performance Bottlenecks

**Whole-file synchronous log analysis:**
- Problem: Entire logs are read/gunzipped synchronously, each access file parsed twice, and raw period request rows exported.
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `backend/database.js`
- Cause: In-memory arrays/correlation instead of grouped SQL and streaming.
- Improvement path: Return aggregates plus bounded diagnostics; stream parsing and record rejected/read-error counts.

**Disk measurements cannot establish cache hit rate:**
- Problem: Current du/file counts and surviving files selected by mtime are treated as monthly cache creation/success evidence.
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `backend/index.js`, `backend/modules/qaCacheManager.js`
- Cause: Cleanup removes files; mtime is not request/generation/hit history, and QA cache/TTS mechanisms differ.
- Improvement path: Label disk data as collection-time inventory; derive true hits/misses from explicit events with coverage and denominator.

## Fragile Areas

**Incomplete log collection appears successful:**
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `backend/logger.js`
- Why fragile: Nginx read/gzip errors are silently caught, missing daily files skipped, and PM2 logs/Nginx error logs omitted. Existing parseError fields do not define full coverage.
- Safe modification: Record inventory, observed interval, missing files, invalid lines and failures; preserve unavailable separately from zero.
- Test coverage: No collector fixtures demonstrate corrupted gzip, rotation overlap, missing periods or partial source failures.

**QA ledgers have different denominators:**
- Files: `backend/modules/qaRequestReceipts.js`, `backend/modules/qaRequestStore.js`, `backend/modules/qaGeneration.js`, `backend/database.js`, `backend/modules/qaMedia.js`
- Why fragile: Endpoint counts include SSE/audio/polling/cancel, receipts represent incremental accepted requests, and legacy daily costs can cover another path. Cancellation can still consume recorded paid usage.
- Safe modification: Count routes, receipts, terminal statuses, usage statuses, paid calls and daily aggregates separately; reconcile receipts by costId where available; never sum duplicate ledgers.
- Test coverage: `backend/tests/qaRequestReceipts.test.js`, `backend/tests/qaIncremental.test.js` cover lifecycle, not monthly reporting reconciliation.

## Scaling Limits

**API request rows do not encode response outcomes:**
- Current capacity: api_requests stores timestamp/path/IP/user/guest, without method, response status, duration, requestId or completion outcome.
- Files: `backend/database.js`, `backend/routes.js`
- Limit: These rows alone cannot prove successful answers, paid generations, completed viewing or latency. Scan routes are also logged.
- Scaling path: Use bounded Nginx response metrics and add structured request/terminal correlation for future operational metrics.

**Remote collector output has a fixed buffer:**
- Current capacity: execSync uses a 128 MiB buffer with raw request arrays and complete retained-log processing.
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`
- Limit: Request growth can exceed memory/buffer even when aggregates are small.
- Scaling path: Aggregate on the server and expose query/export limits and collection durations.

## Dependencies at Risk

**Collection depends on fixed host layout and shell date interpretation:**
- Risk: Absolute remote paths/module location, find date parsing, du formatting and host timezone are embedded assumptions.
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`
- Impact: Host/runtime changes alter or break collection without compatibility checks.
- Migration plan: Parameterize layout, inspect schema read-only, normalize time explicitly and capture schema/source hashes.

## Missing Critical Features

**QA and policy report sections:**
- Problem: Receipts/usage uncertainty, cache leases/retries/frames/subtitles, QA-MEDIA/QA-GENERATION events, grounding costs and script acceptance/quarantine are not separately reported.
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `backend/modules/qaCacheStore.js`, `backend/modules/qaGeneration.js`, `backend/modules/canonicalOutput.js`
- Blocks: Detection of unfinished QA, cache stalls, uncertain paid usage and policy rejection.

**Historical transitions and date-aware inventory:**
- Problem: Mutable video/user/history/favorite/cache rows do not establish historical event counts. The production read-only inventory collected at 2026-09-30T02:11:30.649Z lists 120860 API rows, 4873 costs, 453 receipts, 549 cache jobs, 70202 frames, 124 subtitles, 97 QA daily rows and 239 quarantine rows; these are current inventories.
- Files: `backend/database.js`, `backend/modules/qaCacheStore.js`, `/Users/chacha/src/youtube-describer/prod_report/stats_coverage_inventory_20260930.json`
- Blocks: Exact past play/like/auth/cache transitions cannot be recovered with COUNT alone. QA routes/costs/receipts are observed only in September; the 31 August daily files contain no QA-MEDIA/QA-GENERATION markers. This is evidence of no observed August activity in those sources, not proof every possible historical QA path was unused. Costs mix 4339 SQL and 534 ISO timestamps.

## Test Coverage Gaps

**Statistics correctness fixtures:**
- What's not tested: KST month edges, ISO/SQL coexistence, epoch receipts, duplicate-Z parsing, join multiplication, QA reconciliation, snapshot labels and source failures.
- Files: `.agents/skills/analyze_system_stats/scripts/stats_collector.js`, `backend/tests/qaRequestReceipts.test.js`, `backend/tests/geminiCost.test.js`
- Risk: A successful report can contain systematic measurement errors.
- Priority: High; introduce deterministic synthetic DB/log fixtures before relying on revised sponsor metrics.

**Backend npm test does not execute existing suites:**
- What's not tested: npm test remains a placeholder despite direct Node tests for QA, latency, cache and resource limits.
- Files: `backend/package.json`, `backend/tests/qaLatencyBenchmark.test.js`, `backend/tests/qaCacheManager.test.js`, `backend/tests/mediaResourceLimiter.test.js`
- Risk: Routine package testing skips backend verification.
- Priority: Medium; configure deterministic suites separately from external/media benchmarks.

---

*Concerns audit: 2026-09-30*
