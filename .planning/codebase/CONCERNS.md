# Codebase Concerns

**Analysis Date:** 2026-08-31

## Tech Debt

**Duplicated processing pipelines:**
- Issue: Interactive processing, batch processing, and the CLI each implement their own download, media extraction, language detection, model invocation, and persistence flow. Policy fixes can therefore diverge between paths.
- Files: `backend/videoProcessor.js`, `backend/process_video_cli.js`, `backend/modules/describer.js`, `backend/modules/synchronizer.js`
- Impact: A fix to canonical validation, retries, cleanup, or resource limits can be bypassed by another entry point; behavior is difficult to reason about and test end to end.
- Fix approach: Extract one orchestration service with shared acquisition, chunk, generation, validation, persistence, and recovery interfaces; keep CLI and HTTP layers as thin adapters.

**Ad-hoc database migrations:**
- Issue: Startup migrations in `init()` probe columns and issue individual `ALTER TABLE` statements without a schema version table or migration transaction.
- Files: `backend/database.js`
- Impact: A process interruption or partially applied migration can leave startup non-repeatable or the database in a mixed schema state.
- Fix approach: Add versioned, transactional migrations with explicit compatibility checks and a tested backup/recovery procedure.

**Legacy compatibility is implemented as permissive defaults:**
- Issue: Missing `validation_status` and `tts_eligible` values are interpreted as accepted and eligible, while provenance and policy metadata may be absent.
- Files: `backend/database.js`, `backend/modules/ttsPolicy.js`, `backend/test_canonical_integration.js`
- Impact: Legacy rows can enter the new playback/TTS path without the current evidence and language-policy guarantees.
- Fix approach: Treat missing provenance as legacy-only, quarantine or revalidate it before TTS, and make the compatibility projection explicit at the API boundary.

**Multiple authentication and password implementations:**
- Issue: Password hashing is duplicated with a low PBKDF2 iteration count, admin authentication uses a password as a bearer credential, and old and active admin/player screens remain in parallel.
- Files: `backend/database.js`, `backend/utils.js`, `backend/routes.js`, `frontend/src/Admin.js`, `frontend/src/screens/Admin.js`, `frontend/src/contexts/AuthContext.js`
- Impact: Security fixes and behavior changes can be applied to one path while another path preserves the vulnerable contract.
- Fix approach: Centralize credential hashing and session issuance, migrate to a strong password KDF, remove plaintext admin-token handling, and retire or clearly isolate duplicate screens.

**Operational scripts bypass application boundaries:**
- Issue: Diagnostic and CLI scripts can use old prompts, all-at-once generation, destructive cleanup, and shell-interpolated commands independently of the HTTP pipeline.
- Files: `backend/process_video_cli.js`, `backend/run_batch_single.js`, `backend/test_matrix_runner.js`, `backend/clear-cache.js`
- Impact: Production or test data can be mutated with behavior that does not satisfy the canonical policy or normal safety checks.
- Fix approach: Route operational tools through the same service and policy modules, require explicit environment/target guards, and replace shell interpolation with argument arrays.

## Known Bugs

**Canonical event IDs are not video-scoped:**
- Symptoms: Two videos that produce the same normalized text, timestamp, tag, provenance, and interval can receive the same deterministic ID.
- Files: `backend/modules/canonicalOutput.js`, `backend/database.js`
- Trigger: The ID is generated without `videoId`, while `scripts.id` is a global primary key and accepted inserts use `INSERT OR IGNORE`.
- Workaround: None; a colliding event can be silently ignored for the second video.

**No-frame and partial-generation results can be reported as complete:**
- Symptoms: Interactive processing marks a video completed with an empty script when no frames are found; a response with some accepted events can also mark the whole video completed without coverage or chunk readiness checks.
- Files: `backend/videoProcessor.js`, `backend/database.js`, `frontend/src/screens/PlayerScreenV2.js`
- Trigger: The current status model has only pending/processing/completed/failed and does not represent ready-through coverage, incomplete chunks, or generation attempts.
- Workaround: A user can retry generation manually, but the completed status can prevent batch regeneration and mislead the player.

**CLI part processing can corrupt overall status and leak temporary files:**
- Symptoms: A single `--part` invocation can mark the entire video completed or failed based only on that part; empty extracted chunks skip cleanup.
- Files: `backend/process_video_cli.js`
- Trigger: Overall status is updated from per-invocation accepted count, and the empty-frame branch continues before the chunk cleanup block.
- Workaround: Avoid treating part-mode status as authoritative and remove abandoned chunk directories manually through a controlled maintenance operation.

**Mixed-language translation can be omitted:**
- Symptoms: Mixed audio prefers a Korean subtitle track and can produce no foreign-language intervals, even when foreign speech exists in the audio.
- Files: `backend/videoProcessor.js`, `backend/modules/audioLanguageDetector.js`, `backend/modules/canonicalOutput.js`
- Trigger: Detection samples only three coarse positions and subtitle selection returns the Korean VTT before segment-level foreign detection is available.
- Workaround: None beyond supplying reliable foreign interval context; the conservative result is safe but incomplete.

**Timestamp zero is rejected despite player support:**
- Symptoms: The canonical validator rejects timestamp `0`, while the player contains special handling for events at the beginning of playback.
- Files: `backend/modules/canonicalOutput.js`, `frontend/src/screens/PlayerScreenV2.js`, `frontend/src/PlayerScreen.js`, `frontend/src/screens/PlayerScreen.js`
- Trigger: Validation uses a non-positive timestamp rejection, so the first possible description cannot be persisted.
- Workaround: Shift the event into the valid range, which can lose the intended timing.

## Security Considerations

**Admin credentials and bearer tokens are exposed in client-side storage and transport:**
- Risk: Admin passwords are stored in plaintext settings and sent as bearer credentials; normal JWTs are long-lived, and SSE accepts tokens in query parameters. Browser history, proxy logs, referrers, local storage, or XSS can expose them.
- Files: `backend/database.js`, `backend/routes.js`, `frontend/src/Admin.js`, `frontend/src/screens/Admin.js`, `frontend/src/contexts/AuthContext.js`, `frontend/src/screens/PlayerScreenV2.js`
- Current mitigation: Password comparison and bearer checks exist, but there is no robust session revocation or query-token prohibition.
- Recommendations: Hash all passwords/PINs, issue short-lived scoped sessions in secure HTTP-only cookies, remove query tokens, add revocation/rotation, and never return admin secrets from settings.

**Stored XSS is possible in board content:**
- Risk: Authenticated users can submit arbitrary post content and the active post screen renders it with `dangerouslySetInnerHTML`.
- Files: `backend/routes.js`, `frontend/src/screens/PostScreen.js`, `frontend/src/PostScreen.js`
- Current mitigation: Newline replacement is applied, but it is not HTML sanitization.
- Recommendations: Render text as text or sanitize against an allowlist on write and read; add an authenticated-post XSS regression test.

**Unauthenticated work and TTS are cost-abuse surfaces:**
- Risk: Public batch processing starts background generation without identity, quota, balance, idempotency, or rate limiting; public TTS can invoke a paid provider for arbitrary eligible events.
- Files: `backend/routes.js`, `backend/videoProcessor.js`, `backend/modules/ttsPolicy.js`, `frontend/src/screens/PlayerScreenV2.js`
- Current mitigation: URL validation, cache lookup, and model calls exist, but they do not establish caller accountability or concurrency budgets.
- Recommendations: Authenticate or tightly rate-limit these endpoints, create durable user-owned jobs, enforce quotas and provider budgets, and make TTS cache writes atomic and deduplicated.

**PII and sensitive artifacts are retained or logged broadly:**
- Risk: User phone, birthdate, PIN, ID-card images, IP addresses, guest IDs, watch history, raw request paths, download/model errors, and external responses can enter SQLite, logs, telemetry, or notifications.
- Files: `backend/routes.js`, `backend/database.js`, `backend/utils.js`, `backend/logger.js`, `backend/index.js`, `backend/my_cookies.txt`, `backend/.env`, `backend/.env.bak`
- Current mitigation: Sensitive local files are ignored by `.gitignore`; file existence and permissions still require deployment review, and the application has no documented retention or redaction policy.
- Recommendations: Remove PINs from response payloads, encrypt or minimize identity data, redact logs and Telegram notifications, define retention/deletion jobs, restrict local file permissions, and scan artifacts before deployment.

**Trust and input boundaries are too broad:**
- Risk: All-origin CORS, a 50 MB request-body limit, unconditional proxy trust, raw forwarded IP usage, and unbounded search/API telemetry increase abuse and spoofing exposure.
- Files: `backend/index.js`, `backend/routes.js`, `backend/database.js`
- Current mitigation: Some routes require bearer authentication and YouTube URLs are validated, but there is no consistent per-route input/rate policy.
- Recommendations: Allowlist origins, configure trusted proxy hops, cap fields and pagination, rate-limit expensive/auth endpoints, validate forwarded identity data, and add telemetry retention limits.

**Downloader and prompt inputs remain hostile-boundary concerns:**
- Risk: Downloading uses `--no-check-certificate`, browser cookie files, and proxy settings; captions, OCR text, titles, and dialogue are inserted into prompts and can contain prompt-injection instructions.
- Files: `backend/videoProcessor.js`, `backend/modules/promptPolicy.js`, `backend/utils.js`, `backend/process_video_cli.js`
- Current mitigation: Canonical validation constrains output tags, evidence, and language policy, but acquisition and model-input sanitization are not isolated.
- Recommendations: Restore certificate verification, protect and rotate cookies, constrain outbound destinations, delimit/untrust all source text in prompts, and add adversarial-input tests.

## Performance Bottlenecks

**Production generation is still all-at-once:**
- Problem: The HTTP pipeline extracts the full video and reads every JPEG into base64 memory for one model request; it buffers the complete streamed response before canonicalization.
- Files: `backend/videoProcessor.js`, `backend/modules/describer.js`, `backend/modules/synchronizer.js`
- Cause: The planned durable approximately 15-minute chunk/job architecture is not used by `processVideo()` or `processVideoBatch()`.
- Improvement path: Chunk acquisition and model context, bound frame counts/tokens, persist validated partial output, and merge ordered chunks with explicit global memory.

**External and media work has no global resource scheduler:**
- Problem: FFmpeg, Whisper, downloads, model calls, and frame backfills run concurrently per request or batch job.
- Files: `backend/videoProcessor.js`, `backend/modules/audioLanguageDetector.js`
- Cause: Local `Promise.all` and fixed per-job concurrency exist without process-wide semaphores, queue limits, cancellation, or provider backoff.
- Improvement path: Add bounded queues for each resource, timeouts with process reaping, exponential backoff/circuit breaking, and visible saturation metrics.

**Frame-gap analysis can become unnecessarily expensive:**
- Problem: Long-video keyframe backfill repeatedly searches the accumulated frame list for each target, producing avoidable quadratic behavior.
- Files: `backend/videoProcessor.js`
- Cause: Gap detection uses repeated nearest-frame scans rather than indexed timestamps.
- Improvement path: Sort/index timestamps once, use binary search, and cap backfill work per chunk.

**Runtime artifacts grow without complete retention control:**
- Problem: API request telemetry, logs, quarantine rows, SQLite WAL state, temporary workspaces, and TTS audio are not governed by a unified retention or quota policy.
- Files: `backend/database.js`, `backend/logger.js`, `backend/index.js`, `backend/videoProcessor.js`
- Cause: Cleanup only targets selected TTS cache files once daily; it does not remove abandoned jobs/temp data or bound database/log tables.
- Improvement path: Add ownership and expiry metadata, scheduled bounded cleanup, WAL/checkpoint monitoring, disk-pressure admission control, and atomic cache writes.

## Fragile Areas

**In-memory locks and shared workspaces are not restart-safe:**
- Files: `backend/videoProcessor.js`, `backend/routes.js`, `backend/index.js`
- Why fragile: `processingLocks` exists only in one Node process, batch processing has no matching lock, and concurrent work can share `backend/temp/<videoId>`.
- Safe modification: Introduce durable job/attempt/lease records, unique workspace paths per attempt, startup recovery, and idempotent cleanup before changing concurrency.
- Test coverage: No deterministic restart, duplicate-request, cross-process, or workspace-collision tests are present.

**SSE is tied to a request lifetime rather than a recoverable job:**
- Files: `backend/routes.js`, `frontend/src/screens/PlayerScreenV2.js`, `frontend/src/PlayerScreen.js`, `frontend/src/screens/PlayerScreen.js`
- Why fragile: Disconnect only clears the heartbeat; processing continues without a durable event cursor, and the client closes on error without reconnect or replay.
- Safe modification: Return a job ID, persist event sequence/progress, support status polling and `Last-Event-ID`, and distinguish cancellation from client disconnect.
- Test coverage: No browser or network-disconnect tests verify reconnect, duplicate event delivery, or partial playback recovery.

**Persistence can erase valid output during retries:**
- Files: `backend/database.js`, `backend/videoProcessor.js`, `backend/process_video_cli.js`
- Why fragile: `saveVideo()` deletes every existing script for a video before reinserting a supplied batch, while chunk publishing and final publishing are separate operations.
- Safe modification: Use generation/version and chunk keys, transactional upserts, immutable accepted events, and an explicit publish cursor; never replace complete output with an unverified partial set.
- Test coverage: Existing integration tests cover accepted/quarantined inserts but not failure between chunk publish and final status or concurrent replacement.

**Child-process cleanup is incomplete:**
- Files: `backend/videoProcessor.js`, `backend/modules/audioLanguageDetector.js`, `backend/process_video_cli.js`
- Why fragile: Several spawned processes have timeouts but no consistent error/close handling, cancellation propagation, or orphan verification; abrupt CLI exits can bypass cleanup.
- Safe modification: Centralize subprocess execution with kill escalation, settled-close semantics, bounded output, and finally-based workspace cleanup.
- Test coverage: No process-timeout, SIGTERM, orphan, disk-full, or partial-download tests are present.

**Evidence and player policy are not aligned end to end:**
- Files: `backend/modules/canonicalOutput.js`, `backend/videoProcessor.js`, `backend/modules/ttsPolicy.js`, `frontend/src/screens/PlayerScreenV2.js`
- Why fragile: Interactive visual events carry timestamp-only frame evidence, `[txt]` lacks the required screen-text evidence, TTS checks flags rather than the complete policy contract, and the player still applies legacy collision filtering.
- Safe modification: Define one validated event contract containing evidence, policy version, audio language, and playback eligibility; make the player consume it without reinterpreting safety rules.
- Test coverage: Deterministic backend policy tests pass, but no real-frame, screen-reader, browser timing, or audio-overlap verification exists.

## Scaling Limits

**Single-process SQLite is the coordination bottleneck:**
- Current capacity: The application uses one local SQLite database with WAL and synchronous per-request API telemetry inserts.
- Limit: Concurrent jobs, admin traffic, and generation writes contend on one file; there is no durable queue, lease, worker pool, or horizontal coordination.
- Scaling path: Move job state to a durable queue/store or implement transactional leases and bounded workers before adding process replicas; retain SQLite only with measured write contention and backup controls.

**The current duration limit conflicts with universal chunking:**
- Current capacity: The API path enforces a configured maximum duration whose default is approximately 30 minutes, while the direction requires approximately 15-minute chunks and restartable long-video processing.
- Limit: Longer inputs are rejected rather than admitted as chunked jobs, and accepted inputs still send full-video context through the current path.
- Scaling path: Make duration admission and chunk scheduling job-based, with per-chunk budgets and resumable global memory.

**Paid-provider capacity is not enforced:**
- Current capacity: Gemini, Google TTS, Whisper, FFmpeg, downloads, and frame work can each run concurrently for multiple callers.
- Limit: A burst of public batch/TTS requests can exhaust provider quotas, CPU, RAM, disk, or monthly budget before application status reflects the problem.
- Scaling path: Add per-resource concurrency, per-user quotas, cost accounting, circuit breakers, and admission control tied to disk/RAM/provider health.

## Dependencies at Risk

**Runtime media tooling is machine-specific:**
- Risk: `yt-dlp`, `ffmpeg`, `deno`, Whisper/model paths, cookies, proxies, and Gemini/Google credentials are assumed at runtime or resolved from host-specific defaults.
- Impact: A new host or worker can fail at import/startup, use incompatible command flags, or lack the required model/binary without a clear health check.
- Migration plan: Add startup capability checks, pinned/versioned tool configuration, explicit dependency injection, and a worker image or documented provisioned runtime.

**Model and pricing assumptions are hard-coded:**
- Risk: Model names and token pricing are embedded in processing code rather than versioned configuration with provider limits.
- Impact: Provider model retirement, pricing changes, output-format drift, or quota behavior can silently change cost and canonical output quality.
- Migration plan: Version provider adapters and prompt-policy hashes, validate structured output at the boundary, and record model/config versions with every job and event.

## Missing Critical Features

**Durable jobs, recovery, and truthful progress:**
- Problem: There is no durable job ID, attempt/lease, per-chunk state, retry policy, startup recovery, ready-through cursor, or replayable progress stream.
- Blocks: Reliable restart behavior, truthful partial playback, safe duplicate requests, bounded retries, and horizontal workers.
- Files: `backend/routes.js`, `backend/videoProcessor.js`, `backend/database.js`, `frontend/src/screens/PlayerScreenV2.js`

**Policy-aware playback scheduling:**
- Problem: The player polls every 250 ms and triggers TTS from event timestamps without duration-aware scheduling, dialogue occupancy, cancellation, or a durable audio identity/cache lifecycle.
- Blocks: Predictable non-overlap behavior, safe seek/pause semantics, and accessible progressive playback under mixed speech and visual events.
- Files: `frontend/src/screens/PlayerScreenV2.js`, `frontend/src/contexts/AuthContext.js`, `backend/routes.js`, `backend/modules/ttsPolicy.js`

**Genre classification and evaluation gates:**
- Problem: The analyzer still uses a legacy analyzer prompt and falls back to a general genre without a confidence/allowlist contract; browser, audio, accessibility, and large-input evaluation gates are not automated.
- Blocks: Genre-specific policy enforcement, quality regression detection, and objective release readiness for the current milestone direction.
- Files: `backend/modules/analyzer.js`, `backend/prompts/stage1_analyzer.txt`, `.planning/REQUIREMENTS.md`, `.planning/phases/01-canonical-output-provenance-v2-policy/01-VERIFICATION.md`

## Test Coverage Gaps

**Backend test command is not configured:**
- What's not tested: The package test script exits with “no test specified”; only direct Node test invocations cover the current canonical fixtures.
- Files: `backend/package.json`, `backend/test_canonical_output.js`, `backend/test_audio_language_policy.js`, `backend/test_prompt_policy.js`, `backend/test_canonical_integration.js`
- Risk: CI can report no meaningful suite, and integration/restart/resource regressions can land unnoticed.
- Priority: High

**Frontend verification is blocked and lacks behavioral coverage:**
- What's not tested: The existing frontend test cannot resolve `react-router-dom` under the current Jest setup, and there are no tests for SSE recovery, TTS races, seeking, keyboard controls, or screen-reader state.
- Files: `frontend/package.json`, `frontend/src/App.test.js`, `frontend/src/App.js`, `frontend/src/screens/PlayerScreenV2.js`
- Risk: Accessibility and playback regressions are likely to reach users despite the service’s accessibility-critical purpose.
- Priority: High

**Reliability and security scenarios are absent:**
- What's not tested: Duplicate jobs, process restart, client disconnect, provider timeout, child-process orphaning, disk pressure, cache races, global ID collision, query-token leakage, stored XSS, quota abuse, and PII redaction.
- Files: `backend/routes.js`, `backend/videoProcessor.js`, `backend/database.js`, `backend/logger.js`, `frontend/src/screens/PostScreen.js`
- Risk: The highest-impact concerns remain unverified in the failure modes that the next phases are intended to address.
- Priority: High

**Policy tests do not cover real evidence and full lifecycle behavior:**
- What's not tested: The deterministic suite does not exercise actual frame/image provenance, screen-text extraction, segment-level mixed audio, persisted cross-chunk duplicate suppression, or player/TTS interpretation of accepted canonical events.
- Files: `backend/modules/canonicalOutput.js`, `backend/modules/audioLanguageDetector.js`, `backend/videoProcessor.js`, `frontend/src/screens/PlayerScreenV2.js`, `backend/test_canonical_integration.js`
- Risk: A green parser suite can coexist with unsafe or unusable end-to-end output.
- Priority: Medium

---

*Concerns audit: 2026-08-31*
