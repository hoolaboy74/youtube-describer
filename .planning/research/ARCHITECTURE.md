# Architecture Patterns

**Domain:** Accessible long-video screen-description generation service  
**Researched:** 2026-08-24  
**Recommendation:** A SQLite-first durable workflow with a separate worker process, bounded draft concurrency, and a strictly ordered merge/revision stage.

## Recommended Architecture

Keep the current modular monolith as the product boundary, but split request handling from job execution. The API creates or resumes a durable `video_generation_job`; a worker claims stages from SQLite and runs the existing media/Gemini adapters. The browser observes a replayable progress stream rather than owning the lifetime of generation.

```text
React Player
   │ create/status + SSE ticket
   ▼
Express API ───────────────► SQLite (jobs, chunks, scripts, events, leases)
                                  ▲                 │
                                  │                 ▼
                         Generation Worker      TTS eligibility/index
                                  │
             ┌────────────────────┼────────────────────┐
             ▼                    ▼                    ▼
       Asset adapters       Chunk draft pool     Ordered merge/reviser
     yt-dlp/FFmpeg/Whisper      Gemini calls          Gemini + rules
             │                    │                    │
             └────────────── local job workspace ──────┘
                              frames/audio/subtitles
```

The key invariant is that a 60-minute video is never sent to one all-at-once generation request. Planning and memory construction may inspect the complete metadata/timeline, but model calls operate on bounded scene windows. Drafts may run in parallel because they are provisional; continuity state, deduplication, and final script publication are applied in timestamp order.

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|----------------|-------------------|
| API/job service | Authenticate, authorize, quota-check, deduplicate requests, create/resume jobs, return status and SSE tickets | SQLite, progress API |
| Job repository | Transactional state transitions, leases, attempts, idempotency keys, event sequence numbers | SQLite only |
| Worker supervisor | Poll/claim runnable work, enforce process-wide resource limits, recover expired leases, stop cleanly | Job repository, stage handlers |
| Asset acquisition | Metadata, audio-language classification, subtitle/dialogue track, audio/video download | YouTube adapters, filesystem, job repository |
| Frame/timeline extractor | Keyframes, scene-change candidates, OCR/text candidates, timestamp normalization | FFmpeg, Whisper/subtitle data, filesystem |
| Genre router | Category, confidence, fallback policy, prompt profile version | Metadata, language classifier, job repository |
| Video memory builder | Immutable global manifest plus bounded summaries and registries | Assets, planner, SQLite/filesystem |
| Scene/chunk planner | Ordered chunk boundaries, overlap windows, dependencies, estimated cost | Timeline, global memory, SQLite |
| Draft scheduler | Claims eligible chunks and submits bounded model calls | Worker supervisor, Gemini adapter |
| Draft generator | Generates only a chunk draft using global memory, local window, and explicit boundary context | Gemini, chunk repository |
| Continuity/merge service | Consumes drafts in order, resolves boundary duplicates, updates continuity state, emits canonical script | Drafts, memory, deterministic validators, Gemini reviser |
| Policy/validator service | Enforces tag/timestamp schema, language policy, evidence/overlap rules, non-duplication, TTS eligibility | Dialogue track, canonical script, player/TTS API |
| Progress event store | Append-only, replayable job events; coalesces noisy updates | SQLite, SSE endpoint |
| Workspace manager | Per-job/per-attempt paths, quotas, checksums, cleanup, orphan recovery | Filesystem, worker supervisor |
| TTS service | Accepts only eligible canonical items, caches by policy/version/voice/text hash | Policy service, Google Cloud TTS, audio cache |

Do not let `routes.js` call Gemini or manage an in-memory processing lock. `routes.js` should call the job service. Do not let a draft worker publish directly to `scripts`; only the ordered merge service can publish canonical lines.

### Durable State Model

Add versioned migrations rather than more startup-only additive `ALTER TABLE` logic. The exact SQL can fit the existing database façade, but the ownership should be explicit:

| Record | Important fields | State/ownership rule |
|--------|------------------|----------------------|
| `video_generation_jobs` | `job_id`, `video_id`, `request_fingerprint`, `pipeline_version`, `status`, `stage`, `generation_epoch`, `created_by`, `cancel_requested_at`, `last_error` | Unique active fingerprint per video/profile; one canonical job owns publication |
| `job_leases` | `job_id`/`chunk_id`, `worker_id`, `lease_token`, `leased_until`, `heartbeat_at` | Claim is conditional on pending/expired state; token required to commit |
| `video_assets` | asset kind, source URI, checksum, local path/object key, metadata JSON | Immutable by checksum; retries reuse completed assets |
| `video_memory` | `job_id`, `memory_version`, global facts JSON, entity registry JSON, timeline index, policy snapshot | Immutable after planning except a new version; drafts reference a version |
| `scene_chunks` | ordinal, start/end, overlap start/end, planner version, status, input hash, output hash | Ordinal is the ordering key; chunk is regenerated only when its input hash changes |
| `chunk_attempts` | chunk id, attempt, lease token, provider request key, status, error class, cost, timestamps | Every external call has an auditable attempt; no blind duplicate attempt |
| `continuity_states` | boundary ordinal, prior canonical tail, active entities, unresolved references, recent descriptions, policy state | Written only after the preceding ordinal is canonically accepted |
| `script_items` | ordinal, timestamp, tag, text, source/evidence refs, eligibility, validation version | Unique `(job_id, ordinal, item_hash)`; canonical publication is idempotent |
| `progress_events` | monotonically increasing `event_id`, job id, type, payload, created_at | Append then publish; clients replay from `Last-Event-ID` |

Store large frames, audio, and downloaded media outside SQLite, referenced by checksum and path/object key. Retain small manifests and normalized transcripts in SQLite. A retry must be able to reconstruct its exact input from `input_hash`, `memory_version`, `policy_version`, asset checksums, and chunk window.

### Global Video Memory and Context Representation

Global memory is not a giant prompt copy of the video. It is a compact, versioned data product with four layers:

1. **Immutable manifest:** video id, duration, title, genre/confidence, audio classification, dialogue-track language, source asset checksums, timeline bounds, and prompt/policy versions.
2. **Evidence index:** timestamped keyframe/scene references, readable screen text, subtitle/dialogue spans, and confidence/evidence type. Each candidate description must cite one or more local evidence ids.
3. **Persistent registries:** stable visual references such as `person_A = red jacket, left side when last observed`, recurring locations/objects, named entities only when explicitly evidenced, and unresolved references. Never promote an inference to a fact.
4. **Hierarchical summaries:** chapter/segment summaries and a rolling canonical tail. Summaries contain facts, changes, unresolved threads, and “do not repeat” items, each linked to time ranges. They are replaceable versions, not an unbounded conversation transcript.

For each chunk, construct a deterministic `ChunkContext`:

```text
{ job_id, generation_epoch, chunk_ordinal,
  primary_range: [start, end], overlap: [overlap_start, overlap_end],
  memory_version, genre_profile, language_policy,
  global_facts, relevant_registry_entries,
  prior_canonical_tail, prior_boundary_state,
  local_frames_and_text, local_dialogue_spans,
  next_boundary_preview, evidence_ids, input_hash }
```

Use a primary range of roughly 3–8 minutes, adjusted at scene boundaries and token/cost limits, with a small overlap on both sides. The overlap is context, not permission to publish duplicate lines. The model may draft in parallel with a stale-but-valid global memory snapshot; only the ordered merger can update continuity state. If a merge revision changes a boundary, invalidate the immediately adjacent chunks and re-run only those affected ordinals.

### Data Flow

1. `POST /api/process` (or the batch equivalent) authenticates and checks quota/balance. Normalize the YouTube id, profile options, and pipeline version into a `request_fingerprint`. In one transaction, return the existing active job or insert a new job and an initial `job_created` event.
2. The worker claims `acquire_assets`. It downloads into `workspace/{job_id}/assets`, records checksums, and commits metadata, duration, dialogue track, audio classification, and asset status. A crash leaves a lease to expire; a retry reuses checksum-matching assets.
3. The worker runs frame extraction, timestamp normalization, and genre routing. Store a compact timeline index and a frozen language/policy snapshot. Reject unsupported/live/over-limit inputs as terminal, typed failures.
4. `plan_chunks` creates ordered chunks at scene boundaries, with explicit overlap and estimated token/frame budgets. It also builds global memory and records `planning_complete`. Planning must fail closed if a chunk cannot fit its bounded input budget.
5. The draft scheduler claims at most the configured draft slots whose dependencies are satisfied. For each chunk it creates a `chunk_attempt` with an input hash, sends a bounded Gemini request, validates the stream into a temporary draft, and atomically stores the draft plus cost. A failed attempt changes only that chunk to retryable/failed.
6. The ordered merger advances `next_merge_ordinal` only when that chunk’s draft is complete. It loads the prior canonical tail and boundary state, runs deterministic normalization/deduplication, then uses a small revision call only when ambiguity remains. It validates timestamp bounds, tags, evidence references, continuity, and language policy before publishing canonical `script_items`.
7. After each accepted ordinal, persist the new continuity state and append `script_item_published` plus aggregate progress events in the same SQLite transaction. The worker can then merge the next ordinal while later drafts continue generating.
8. Expose an SSE endpoint that reads stored events from `Last-Event-ID`, emits monotonically increasing ids, sends heartbeats, and follows the stream with the current durable snapshot. A reconnect does not restart generation and does not depend on process memory.
9. Mark TTS eligibility during canonical validation. The player/TTS endpoint can request audio only for eligible items; ineligible items remain visible as text/script metadata but cannot be synthesized.
10. On completion, atomically mark the job and script generation complete, record aggregate cost/metrics, and retain the final memory/policy versions needed to reproduce or audit the result.

### Parallelism and Sequential Continuity

Parallelize independent I/O and draft generation, not facts that need a canonical history. Asset download, metadata lookup, language detection, and initial frame indexing may run concurrently when their host limits permit. Draft chunks can run concurrently after planning. Merge, boundary deduplication, continuity-state mutation, canonical publication, and final TTS eligibility are ordered by chunk ordinal.

Start with conservative per-host limits, configurable rather than hard-coded:

| Resource | Initial limit | Control rule |
|----------|---------------|--------------|
| Whole-video jobs | 1–2 | Reserve CPU, disk, and model budget before acquisition |
| Gemini draft calls | 2 | Global semaphore; lower on quota/rate errors |
| Merge/revision calls | 1 | Strictly ordered; never concurrent for one job |
| FFmpeg/Whisper | 1 heavy task | Separate from network/model slots; cap threads explicitly |
| Downloads | 1–2 | Per-provider timeout and byte/disk reservation |
| Per-user active jobs | 1 initially | Enforced transactionally in job creation |

Use both a global semaphore and a per-job semaphore. `Promise.all` is acceptable only for a bounded set selected by the scheduler; never create one promise per video chunk. The limit must be acquired before spawning FFmpeg/Whisper/model work and released in `finally`. Backpressure means leaving later chunks pending, not buffering all frames or prompts in memory.

The tradeoff is intentional: a 3–8 minute draft window can complete early and improve perceived progress, but the final script cannot be declared correct until its predecessor’s state is accepted. Therefore the UI may show `draft_ready` for later chunks, while playback/publication progress follows the ordered merge frontier. This preserves throughput without allowing parallel drafts to create inconsistent names, repeated descriptions, or contradictory scene state.

### Original-Language and Non-Duplication Enforcement

The prompt remains a useful policy reminder, but it is not the enforcement boundary. Store normalized dialogue spans with `start`, `end`, `source_language`, `text`, and a confidence/status from the audio classifier. At canonical validation time:

- For `korean`, reject `[trans]`/`[txt]` items whose normalized text is equal or highly similar to a Korean dialogue span or its subtitle representation; reject translation items for Korean speech unless an explicit independent screen-text evidence type exists.
- For `foreign`, permit `[trans]` only when a source dialogue span is foreign and the item has a matching time overlap plus a translation/source reference. Prefer a readable Korean subtitle evidence id; otherwise require the translated source span. Never accept raw foreign text as TTS content.
- For `mixed`, require the item to reference a non-Korean speech span; unknown-language spans are not eligible for translation.
- For `unknown`, allow only evidence-backed `[v1]`, `[v2]`, `[v3]`, and independent `[txt]` items. `[trans]` is rejected.
- For every item, normalize Unicode/spacing/punctuation, compare against nearby accepted items and dialogue translations, apply a time-window overlap rule, and reject near-duplicate visual descriptions inside the configured repetition window unless new evidence ids show a material scene change.
- Require exactly one allowed tag, integer timestamp within video duration, one physical line, short sentence length, and evidence ids before publication. Keep rejected draft text for diagnostics, but never expose it to TTS or canonical playback.

TTS eligibility is a stored boolean/reason code derived from these checks, not recomputed from the model’s prose by the browser. Eligible items are `v1/v2/v3`, independent `txt`, and validated foreign/mixed `trans`; Korean original-dialogue duplicates, unknown-language translations, raw source-language text, invalid timing, and unresolved policy violations are ineligible. The TTS cache key must include voice, canonical text, and policy/generation version so a policy change cannot reuse an unsafe prior artifact.

### Restart, Retry, and Idempotency

Treat every stage as an at-least-once operation. A worker claims a job/chunk with a lease and heartbeat; the commit transaction checks the lease token and expected state. On startup, a reconciler marks expired leases as retryable, removes only attempt-scoped temporary files, and resumes from the lowest incomplete stage. It must not mark an active job failed merely because the API process restarted.

Use deterministic keys:

- `request_fingerprint = video_id + profile + source_asset_version + pipeline_version` prevents duplicate active jobs.
- `chunk_input_hash = hash(memory_version, chunk ranges, asset checksums, policy/prompt profile, relevant dialogue/frames)` prevents stale drafts being accepted after replanning.
- `provider_request_key = hash(job_id, generation_epoch, chunk_ordinal, chunk_input_hash, attempt policy)` is logged and passed where the provider supports it; otherwise the database commit is the deduplication boundary.
- Canonical script insertion uses a unique key and expected merge frontier. Retried insertion returns the already-published result instead of appending a second line.

Classify failures. Retry transient network errors, provider 429/5xx, timeouts, and expired worker leases with bounded exponential backoff and jitter. Do not retry invalid URLs, unsupported/live videos, policy validation failures without changed input, or deterministic parse failures indefinitely. After the retry budget, mark the chunk blocked and expose a resumable job error. A manual retry increments `generation_epoch` or explicitly reuses the same input hash; it must never silently mix old and new policy versions.

### Progress and Event Delivery

Persist coarse events such as `stage_started`, `assets_ready`, `chunk_planned`, `chunk_draft_ready`, `merge_frontier_advanced`, `script_item_published`, `retry_scheduled`, and `job_completed`. Include `job_id`, `event_id`, stage, chunk ordinal, completed/total counts, merge frontier, retryable flag, and a human-safe message. Coalesce token-level model deltas; do not write every streamed token to SQLite.

Publish an event only after its state transaction commits. The SSE handler replays events after the client’s last id, then tails new events. If a replay window is pruned, send the current snapshot and a `resync` event. Replace the long-lived JWT query parameter with an authenticated short-lived, single-use stream ticket as part of this work; the current URL-token fallback leaks credentials into logs and browser history.

### SQLite-First vs External Queue

| Criterion | SQLite-first (recommended now) | External queue (later) |
|-----------|-------------------------------|------------------------|
| Fit for repository | Reuses `better-sqlite3`, existing video/script/cost tables, one VM, and no new service | Adds Redis/queue operations, deployment, credentials, and a second source of job state |
| Durability | Strong when claims, leases, attempts, and events are transactional; survives Node restart | Queue state survives worker restart, but content state still needs database transactions |
| Coordination | One writer at a time; WAL allows readers with a single serialized writer | Better distributed claiming and worker fleet coordination |
| Parallel drafts | Fine for a small bounded worker pool; do not poll aggressively or hold long transactions | Natural multi-worker concurrency, global limits, priorities, delayed retries, stalled-job recovery |
| Operational risk | Must handle busy timeouts, WAL checkpoints, backups, orphan media, and polling fairness | Must operate Redis/queue HA, monitor stalled jobs, reconcile queue and SQLite, and handle network partition |
| Scaling ceiling | Single host/database file; not suitable for multi-host WAL or high event-write volume | Appropriate when workers span hosts or jobs exceed one VM’s CPU/disk/model quota |
| Recommendation | Implement now with one API process plus one worker process; move telemetry/events out of the hot path and checkpoint/backup deliberately | Adopt only after measured queue wait, worker count, or multi-host requirements justify it |

SQLite WAL permits readers and a writer to proceed concurrently, but SQLite still has only one simultaneous write transaction; WAL also requires all processes to be on the same host and can grow when checkpoints are starved. Keep transactions short, use busy timeouts/backoff, append events in small batches, avoid long read transactions, and monitor WAL size. These constraints fit a single-VM milestone but are a hard boundary for a distributed worker fleet. [SQLite WAL documentation](https://www.sqlite.org/wal.html), [SQLite transaction documentation](https://www.sqlite.org/lang_transaction.html)

An external Redis-backed queue such as BullMQ becomes the right next step when multiple worker hosts, global quotas, priorities, or high queue volume are required. Its documented worker concurrency, global concurrency, stalled-job, retry/backoff, and idempotent-job patterns are useful, but the canonical state should remain transactionally recorded in the application database; the queue is a delivery/claim mechanism, not the script source of truth. [BullMQ concurrency](https://docs.bullmq.io/guide/workers/concurrency), [BullMQ global concurrency](https://docs.bullmq.io/guide/queues/global-concurrency), [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs), [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs)

### Recommended Build Order

1. **Durable job foundation:** versioned migrations, job/chunk/attempt/lease/event tables, request fingerprints, status endpoint, and startup lease reconciliation. Remove the batch route’s unauthenticated fire-and-forget path.
2. **Single pipeline owner:** extract shared acquisition/analysis/generation stages from `processVideo` and `processVideoBatch` into stage handlers; make API routes enqueue only. Add workspace quotas, checksums, cleanup, and cost/quota checks at the job boundary.
3. **Planning and memory:** implement the immutable manifest, evidence index, registries, hierarchical summaries, scene-boundary chunk planner, overlap, input hashes, and bounded model-input budget. Validate that no request contains the whole 60-minute timeline plus all frames.
4. **Bounded draft pool:** add the worker supervisor, global/per-job semaphores, two draft slots initially, chunk attempts, streaming-to-draft persistence, provider timeout/backoff, and `draft_ready` progress events.
5. **Ordered merge/revision:** implement the merge frontier, continuity state, boundary overlap resolution, deterministic validators, selective revision calls, canonical script idempotency, and adjacent-chunk invalidation.
6. **Policy and TTS gate:** move language/duplicate detection into a shared canonical policy module used by parser, merger, script API, and TTS endpoint; persist reason codes and tests for Korean/foreign/mixed/unknown cases.
7. **Replayable SSE:** add single-use stream tickets, event ids, replay/resync, aggregate progress, reconnect tests, and compatibility mapping for current `status_update`, `script_chunk`, and `full_script` events.
8. **Operational hardening:** add metrics for queue wait, stage duration, tokens/cost, retries, disk use, WAL size, merge lag, and rejection reasons; add crash/restart, duplicate-submit, timeout, disk-full, and partial-chunk recovery tests.
9. **External queue decision gate:** measure the single-VM limits. Introduce Redis/BullMQ only when multi-host execution or SQLite claim contention is demonstrated; retain SQLite job state and make queue messages idempotent during migration.

## Patterns to Follow

### Pattern 1: Transactional outbox for progress
**What:** Commit state and a progress event together, then let the SSE publisher read committed events.  
**When:** Any state change users must observe after reconnect or restart.  
**Example:** `BEGIN IMMEDIATE; update chunk; insert progress_event; COMMIT;` followed by a publisher notification. Never emit a success event before the commit.

### Pattern 2: Ordered reducer over parallel drafts
**What:** Drafts are unordered, versioned proposals; the merge frontier is the only writer of canonical script and continuity state.  
**When:** Any output whose meaning depends on prior scenes, names, or repeated descriptions.  
**Example:** `while draft(nextOrdinal) && state(nextOrdinal-1) are ready: validate -> revise boundary -> publish -> advance frontier`.

### Pattern 3: Evidence-carrying output
**What:** Every accepted line carries frame/dialogue/text evidence references and a policy decision.  
**When:** Accessibility, hallucination prevention, language routing, and later audit matter.  
**Why:** The prompt says what to do; evidence and deterministic validators decide what is allowed to ship.

### Pattern 4: Lease plus fencing token
**What:** A worker lease expires, but an old worker cannot commit after takeover because every write checks its fencing token.  
**When:** Process crashes, deployment restarts, or a long Gemini/FFmpeg call outlives its lease.  
**Why:** An in-memory lock prevents only same-process duplicates and cannot protect shared temp paths after restart.

## Anti-Patterns to Avoid

### Anti-Pattern 1: One giant multimodal request
**What:** Sending all 60+ minutes of frames, subtitles, and dialogue to a single streamed Gemini call.  
**Why bad:** Input/token limits, memory pressure, long failure domains, poor retry granularity, and no safe continuity checkpoint.  
**Instead:** Plan bounded scene chunks, draft in limited parallel, and merge in order.

### Anti-Pattern 2: Parallel workers mutate shared continuity
**What:** Each chunk updates a global entity map or script table as soon as its draft finishes.  
**Why bad:** Completion order is nondeterministic; later chunks can become canonical before earlier context, causing contradictions and duplicates.  
**Instead:** Drafts write isolated attempt records; only the merge frontier mutates continuity.

### Anti-Pattern 3: Prompt-only policy enforcement
**What:** Trusting the model to avoid Korean dialogue repetition, foreign-language mistakes, and duplicate visual lines.  
**Why bad:** Prompts are probabilistic and a retry/model/version change can violate the service contract.  
**Instead:** Validate language spans, evidence, time overlap, similarity, tags, timestamps, and TTS eligibility in code.

### Anti-Pattern 4: Fire-and-forget plus in-memory locks
**What:** Start processing from an HTTP handler and assume `Set` locks/timers represent job truth.  
**Why bad:** Restart loses ownership, batch duplicates collide in the same temp directory, and clients cannot resume.  
**Instead:** Persist job identity, leases, attempts, events, and workspace ownership.

### Anti-Pattern 5: Polling with long SQLite transactions
**What:** Workers hold a read transaction while doing network/model work or poll at high frequency.  
**Why bad:** A reader can starve WAL checkpoints, while long writes block all other writers.  
**Instead:** Claim in a short transaction, do work outside it, then commit with a fencing check.

## Scalability Considerations

| Concern | At 100 users | At 10K users | At 1M users |
|---------|--------------|--------------|--------------|
| Generation jobs | One worker process, 1–2 active videos, SQLite leases | Separate API/workers; external queue likely; per-user/provider quotas | Distributed queue, multiple worker pools, managed database/object storage |
| Draft concurrency | Two Gemini slots, one heavy media slot | Global/provider rate limits, job priority, autoscaling workers | Regional/provider pools, admission control, budget-aware scheduling |
| Frames/media | Local per-job workspace with quota and cleanup | Object storage or dedicated volume; content-addressed assets | Object storage lifecycle policies and CDN/access controls |
| Script/events | SQLite canonical rows, coalesced events, WAL monitoring | Separate telemetry/event store and read replicas/cache | Partitioned event/analytics systems; canonical script database remains transactional |
| Continuity memory | JSON snapshots and indexed evidence in SQLite | Versioned blobs/object storage with DB pointers and cache | Durable memory service/index with reproducible snapshots |

## Sources

- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html) — HIGH confidence for WAL concurrency, single-host limitation, checkpoint behavior, and one-writer implications.
- [SQLite Transactions](https://www.sqlite.org/lang_transaction.html) — HIGH confidence for one simultaneous write transaction, `BEGIN IMMEDIATE`, and `SQLITE_BUSY` behavior.
- [BullMQ Worker Concurrency](https://docs.bullmq.io/guide/workers/concurrency) and [Global Concurrency](https://docs.bullmq.io/guide/queues/global-concurrency) — MEDIUM confidence for the external-queue comparison; vendor documentation, not a repository requirement.
- [BullMQ Retrying Failing Jobs](https://docs.bullmq.io/guide/retrying-failing-jobs) and [Idempotent Jobs](https://docs.bullmq.io/patterns/idempotent-jobs) — MEDIUM confidence for retry/backoff/idempotency patterns.
- [MDN Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — MEDIUM confidence for SSE event ids, reconnection, and heartbeat behavior.
- Repository evidence: `.planning/PROJECT.md`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md`, `.planning/codebase/INTEGRATIONS.md`, and `backend/prompt_template_codex_v2.txt` — HIGH confidence for current boundaries and constraints.
