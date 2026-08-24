# Technology Stack

**Project:** 뷰래이터 (accessible YouTube screen-description service)
**Researched:** 2026-08-24
**Research mode:** Ecosystem — brownfield stack dimension
**Overall confidence:** HIGH for the core recommendations; MEDIUM for provider-specific SDK migration details

## Recommended Stack

### Core Framework

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Node.js + Express | Keep existing; current repository uses Express 5.1.0 | HTTP API, job submission/status, SSE | The modular monolith already exposes the required API and SSE flow. Do not introduce another web framework for this milestone. |
| React + existing player | Keep existing; current repository uses React 19.1.1 | Accessible job progress and synchronized playback | Preserve the current player, verbosity controls, and SSE contract; add reconnect/status recovery rather than replacing the UI stack. |
| `@google/genai` behind a Gemini adapter | Add/change; exact package version must be resolved and locked during implementation | Gemini multimodal calls, structured genre profiles, chunk drafts | Google’s current documentation recommends the Google GenAI SDK and identifies older libraries as legacy. Migrate behind an adapter so model, prompt, retry, and cost behavior remain independently testable. |
| Gemini structured output + Zod | Zod 4 is current and stable in official documentation; pin the resolved compatible release | Validate genre profiles and canonical description events | Structured output constrains syntax but not semantic truth; validate again in application code before persistence. |

### Database and Durable Jobs

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `better-sqlite3` | Keep existing repository-pinned 12.4.1; do not call it a current upstream version | Transactional catalog, scripts, users, costs, jobs, chunks, leases, and replayable events | Lowest migration cost and sufficient for the current single-host deployment. SQLite WAL permits readers alongside a writer, while `BEGIN IMMEDIATE` gives an explicit claim transaction. |
| SQLite WAL + explicit transactional migrations | SQLite capability; no new ORM | Concurrent status reads, atomic job/chunk claims, schema evolution | Move startup `ALTER TABLE` logic into numbered, transactional migrations with a schema-version table. Keep all SQLite processes on the same host and keep the `-wal`/`-shm` files with backups. |
| Zod schemas | Zod 4 | HTTP inputs, persisted JSON payloads, Gemini responses, and TTS eligibility DTOs | One runtime validation vocabulary across JavaScript/CommonJS modules; use `safeParse` at boundaries and reject unknown fields for security-sensitive inputs. |

### Infrastructure

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| One PM2 fork-mode Node process plus in-process worker loop | Keep existing deployment shape; explicitly avoid PM2 cluster mode with local SQLite | Durable job execution on the current VM | SQLite is the authoritative queue for this milestone. On startup, reclaim expired leases and resume pending chunks; a process restart must lose only active leases, not work. |
| `p-limit` (or equivalent small limiter) | Resolve a CommonJS-compatible release during implementation; no unverified version claim | Separate concurrency budgets for Gemini, FFmpeg/yt-dlp, Whisper, and TTS | A limiter bounds promises but is not a durable queue. Use one limiter per scarce resource and never let per-job parallelism bypass the global budget. |
| Google Cloud Text-to-Speech | Keep existing `@google-cloud/text-to-speech` 6.3.0 until a verified upgrade is tested | Korean narration and cached MP3 generation | The current provider documents `ko-KR` voices and SSML. Provider replacement is not needed to solve duplicate original speech; provenance and eligibility enforcement are. |
| FFmpeg, yt-dlp, Whisper | Keep existing external tools behind adapters | Download, media extraction, speech/language evidence | Reuse the existing pipeline. Add capability checks, bounded subprocess counts, timeouts, workspace quotas, and orphan cleanup rather than replacing these tools. |
| Pino + OpenTelemetry Node SDK | Add; versions require implementation-time verification | Structured logs, traces, metrics, and correlation | Pino gives low-overhead JSON logs with redaction; OpenTelemetry supplies standard traces/metrics and automatic Express instrumentation. Preserve Telegram alerting through a Pino transport or adapter. |

## Opinionated Queue Decision

### Use SQLite-backed durable workers first

Extend the existing `database.js` façade with these durable records:

- `jobs`: `id`, `idempotency_key`, `video_id`, `user_id`, `status`, `phase`, `profile`, `profile_confidence`, `config_hash`, `attempts`, `available_at`, `lease_owner`, `lease_expires_at`, `cancel_requested_at`, error code, timestamps, and a version.
- `job_chunks`: `job_id`, ordinal, media interval, overlap interval, status, attempt count, input hash, output path or JSON, lease fields, error code, and timestamps; unique `(job_id, ordinal)`.
- `job_events`: monotonic per-job sequence, event type, safe payload, and timestamp; use it to replay missed SSE progress after reconnect.
- `job_artifacts`: immutable paths and SHA-256 hashes for extracted media, frame manifests, transcripts, and TTS files; cleanup only unreferenced artifacts.

Claim work with one short `BEGIN IMMEDIATE` transaction: select an eligible job/chunk, atomically set owner and lease expiry, then perform network/media work outside the transaction. Heartbeat long work, mark completion idempotently, and let a startup sweeper return expired leases to `pending`. Enforce a unique idempotency key before any download or Gemini call.

This is production-suitable for the documented single VM and directly fixes the current process-memory locks, duplicate batch work, crash recovery, and SSE loss. It also keeps the existing SQLite catalog and cost accounting coherent.

### Defer Redis/BullMQ

Do not add Redis/BullMQ in this milestone. BullMQ is a strong later option for multi-process or multi-host dispatch, retries, delayed work, and worker fleets, but it adds Redis availability, connection/reconnect policy, deployment state, and a second source of job truth. Its documented delivery model still requires idempotent processors because at-least-once delivery is possible.

Introduce BullMQ only when one of these is true: workers must run on more than one host, the single VM cannot meet queue latency/resource targets, deploys must not interrupt worker capacity, or operational requirements demand independent queue scaling. Preserve the SQLite `jobs` domain contract and make BullMQ a dispatch adapter; SQLite should remain the result/catalog authority until a separate database migration is justified. Never use BullMQ merely to obtain bounded concurrency that an in-process limiter already provides.

## Media and Multimodal Generation Pattern

### Keep the existing extraction path; add a chunk manifest

For each video, persist a deterministic manifest containing media time bounds, representative-frame hashes/timestamps, subtitle and Whisper segments, detected audio language, and a prompt/profile hash. Use a target chunk interval with a small context overlap. Generate chunk drafts in bounded parallelism, then merge and continuity-check in timestamp order.

Use the Gemini File API only when it materially reduces repeated upload cost or a chunk needs unified audio/video reasoning. Google documents File API use for large inputs and long videos, while inline data is for small one-off inputs. Do not upload the entire 60+ minute source to every chunk: reuse extracted frames/transcript evidence, cache by input hash plus model/profile/prompt version, and send only the chunk plus a compact rolling summary and boundary context.

The canonical Gemini result should be JSON such as `{ events: [{ startMs, endMs, tag, text, evidence, speechSource, ttsEligible }] }`, validated with the Gemini schema and Zod, then rendered into the legacy `[v1]`/`[v2]`/`[v3]`/`[txt]`/`[trans]` representation. Keep the existing text format at the API and player boundary while avoiding regex-only parsing internally.

Profile routing should be a cheap, bounded stage: title/metadata/audio-language/transcript cues plus a small frame sample, returning one of the five supported genre groups or `fallback` with confidence. Low confidence routes to the common v2 rules and does not trigger a second expensive multimodal classification call. Every genre prompt must include the immutable v2 rules: visual evidence only, no guessing, short Korean honorific sentences, strict tags/timestamps, and suppression of spoken-content duplication.

Budget separately for classifier, chunk draft, merge/continuity pass, and TTS. Record model, input/output token counts where available, retries, latency, cache hits, and estimated cost per job/chunk. Retries must be bounded, exponential with jitter, and safe only for idempotent calls.

## Korean TTS and Original-Speech Suppression

Keep Cloud TTS and the existing cache, but insert a mandatory `speechPolicy` stage before synthesis and again before player selection. Do not infer TTS eligibility from text tags alone.

Persist provenance on every canonical event:

- `speechSource`: `visual_description`, `foreign_translation`, `original_dialogue`, `original_korean`, `uncertain`.
- `sourceLanguage`, `evidenceSegmentIds`, `ttsEligible`, and `suppressionReason`.

Rules:

1. `original_korean` and `original_dialogue` are never TTS eligible, even if the generated Korean text looks like a useful translation.
2. Foreign-language dialogue may produce a Korean TTS event only when translation is enabled and the event is explicitly `foreign_translation`; never synthesize the raw foreign transcript.
3. Visual descriptions remain eligible only when they do not paraphrase a nearby spoken segment. Use transcript interval overlap, normalized text similarity, and a conservative uncertainty rule: uncertain provenance is suppressed.
4. Store the suppression decision and reason, expose it to validation/evaluation, and apply the same policy in backend generation, persisted-script validation, API serialization, and `PlayerScreenV2` playback filtering.
5. Escape dynamic text before SSML. Use SSML only for pronunciation, sentence boundaries, and short pauses; do not use it to conceal a policy decision. Select a tested `ko-KR` voice from the supported-voices list at deployment time rather than hard-coding an unverified voice name.

This is the key accessibility safeguard: changing TTS voice quality cannot solve duplicate original speech; explicit provenance can.

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Job dispatch now | SQLite jobs + leases + one worker loop | Redis/BullMQ immediately | Adds infrastructure and dual-state failure modes before the repository needs horizontal workers. Reconsider at the stated scale triggers. |
| DB access | Existing `better-sqlite3` with migration runner | Prisma/Drizzle ORM | ORM migration and query-model churn is high in this CommonJS brownfield service; it does not solve lease semantics or media artifacts. |
| AI client | Adapter with planned `@google/genai` migration | Continue expanding `@google/generative-ai` directly | Google’s official library guidance recommends the newer GenAI SDK and calls legacy libraries migration candidates. Do not combine migration with prompt redesign. |
| LLM output contract | Gemini structured output plus Zod semantic validation | Free-form tagged text from the model | Syntax errors, malformed timestamps, unknown tags, and unsafe TTS provenance remain too easy to persist. Render legacy tags after validation. |
| Concurrency | Per-resource `p-limit` budgets plus durable claims | `Promise.all` over all chunks | Unbounded Gemini, FFmpeg, Whisper, disk, and API usage creates cost spikes and host exhaustion. |
| TTS | Keep Google Cloud TTS with policy/provenance gate | Add a second TTS provider or synthesize all transcript text | Provider choice does not prevent original-speech duplication and increases voice/cache/evaluation surface. |
| Observability | Pino logs + OpenTelemetry traces/metrics | More synchronous SQLite request-log writes | Existing request logging is on the critical path and lacks job/chunk correlation; telemetry should be sampled, retained, and kept free of prompts/audio/PII. |

## What Not to Use

- Do not use process-memory `Set` locks as the source of truth for jobs, and do not run PM2 cluster workers against the same local SQLite file.
- Do not make the whole video, all frames, and all transcript text part of every chunk request; this multiplies multimodal cost and latency.
- Do not trust Gemini’s schema compliance as factual correctness or as proof that a line is safe to narrate.
- Do not use raw transcript text, Korean subtitles, or a translated copy of Korean speech as a TTS input.
- Do not log prompts, frame payloads, transcript contents, identity data, access tokens, or full external API responses. Log hashes, IDs, sizes, counts, and error classes.
- Do not introduce Kafka, Temporal, a hosted workflow engine, or a database migration solely for this milestone; they are operationally disproportionate to the current single-host scope.

## Installation

Exact versions for new packages must be resolved from their official release documentation at implementation time and committed in `backend/package-lock.json`; the research date is explicit because these packages move independently.

```bash
# Add after the compatibility spike
npm install @google/genai zod p-limit pino pino-http \
  @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node

# Keep existing media and TTS packages until verified upgrades pass smoke tests.
```

## Sources and Confidence

- **HIGH — Google GenAI SDK guidance:** [Gemini API libraries](https://ai.google.dev/gemini-api/docs/libraries) recommends the Google GenAI SDK and describes legacy-library migration; [structured outputs](https://ai.google.dev/gemini-api/docs/structured-output) documents JSON Schema limits, Zod support, and the need for application validation; [video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) documents File API use for large/long media and sampling limitations; [Files API](https://ai.google.dev/gemini-api/docs/files) documents reusable uploads and the 100 MB threshold.
- **HIGH — SQLite durability:** [WAL](https://www.sqlite.org/wal.html) documents reader/writer concurrency, same-host limitations, checkpointing, and WAL backup requirements; [transactions](https://www.sqlite.org/lang_transaction.html) documents `BEGIN IMMEDIATE`, single-writer behavior, and `SQLITE_BUSY` handling.
- **HIGH — Korean TTS:** [supported voices and languages](https://cloud.google.com/text-to-speech/docs/voices) documents `ko-KR` voices; [SSML](https://cloud.google.com/text-to-speech/docs/ssml) documents pauses, timepoints, escaping, and supported tags; [creating audio](https://docs.cloud.google.com/text-to-speech/docs/create-audio) documents text/SSML synthesis.
- **HIGH — Validation:** [Zod documentation](https://zod.dev/) identifies Zod 4 as stable and documents runtime validation, JSON Schema conversion, and type inference.
- **HIGH — Observability:** [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/) documents stable traces/metrics and the current status of logs; [JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/) and [instrumentation libraries](https://opentelemetry.io/docs/languages/js/libraries/) document automatic and manual Node instrumentation; [Pino](https://github.com/pinojs/pino) documents low-overhead JSON logging and transports/redaction patterns.
- **MEDIUM/HIGH — Future queue option:** [BullMQ](https://docs.bullmq.io/) documents Redis-backed durable queues, retries, concurrency, crash recovery, and horizontal workers; [worker concurrency](https://docs.bullmq.io/guide/workers/concurrency) distinguishes async I/O concurrency from CPU-heavy sandboxed processing. The recommendation to defer it is project-specific and based on the current single-host constraint.
- **MEDIUM — Limiter:** [`p-limit`](https://github.com/sindresorhus/p-limit) documents bounded promise concurrency. Verify CommonJS integration and the exact release before adding it.

## Verification Gaps

- Verify the installed `@google/genai` API surface against the repository’s current `generateContent` usage before changing prompts or model names.
- Load-test SQLite WAL claims, lease recovery, disk quotas, and SSE replay with real FFmpeg/Whisper/Gemini timings; official SQLite behavior does not establish this host’s capacity.
- Evaluate Korean voice naturalness and pause timing with representative accessible-user tests; the supported-voices page establishes availability, not suitability.
- Confirm Gemini model-specific context, token pricing, rate limits, and structured-output support at implementation time because those values change independently of this document.
