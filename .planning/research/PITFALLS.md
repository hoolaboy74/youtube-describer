# Domain Pitfalls

**Domain:** Accessible Korean YouTube screen-description generation with multimodal AI, long-video chunking, parallel workers, continuity, and prompt routing
**Researched:** 2026-08-24
**Overall confidence:** HIGH for repository-specific failure modes and provider/standards constraints; MEDIUM for model-quality failure rates, which require the project evaluation set

This document is intentionally specific to 뷰래이터. It treats the current prompt, processor, SQLite state, temporary media layout, SSE flow, and TTS player as one pipeline. A prompt rule is not considered enforced until the parser, persistence layer, scheduler, and player independently preserve it.

## Critical Pitfalls

### 1. Confusing original audio, transcript language, translation subtitles, and OCR text

**What goes wrong:** A Korean original is emitted as `[trans]` or `[txt]` and then read aloud over the Korean speech. An English transcript is treated as proof that the original audio is English. A Korean translation subtitle is mistaken for Korean original dialogue, or OCR text is translated again. The accessible result becomes repetitive, semantically wrong, or actively masks the source audio.

**Why it happens:** `sourceLanguage` describes `sourceText`, not necessarily the audio. The prompt already documents this distinction, but the current data path can still collapse language and provenance into a small number of fields. Titles, subtitle tracks, OCR, ASR, and audio-language detection are signals with different authority.

**Consequences:** Duplicate TTS, wrong-language narration, loss of negation/numbers/names, and mistrust from users who depend on exact dialogue timing.

**Prevention:** Store provenance on every candidate segment: `audioLanguage`, `transcriptLanguage`, `textOrigin` (`dialogue`, `translated_dialogue`, `visible_text`, `visual_description`, `unknown`), `subtitleKind` (`original`, `translation`, `unknown`), and `evidenceIds`. Use an explicit `unknown` state. Apply a hard gate before persistence and again before TTS:

- Korean original: suppress dialogue restatement and identical Korean subtitles; retain only independent visible text.
- Foreign original: allow Korean `[trans]` only when the source segment is needed and is not already represented by a visible Korean translation subtitle.
- Mixed original: translate only confidently foreign-language intervals.
- Unknown language: do not translate or re-narrate dialogue; emit independently verified visual information only.

Compare normalized text and time overlap, but do not use text similarity alone: a Korean translation may be intentionally different in wording while still duplicating the spoken content.

**Warning signs:** `[trans]` density rises on Korean videos; `[txt]` lines closely match ASR; `sourceLanguage` and `AUDIO_CLASSIFICATION` disagree; the same source segment has both a visible-subtitle and generated-translation candidate; users report hearing a sentence twice.

**Confidence:** HIGH. This is directly supported by the project prompt and requirements; the semantic quality threshold still needs representative fixtures.

### 2. Treating OCR or a subtitle transcript as visual truth

**What goes wrong:** Small, blurred, cropped, stylized, or partially occluded text is hallucinated. A dialogue transcript is presented as if it appeared on screen. A translated subtitle is described as visible when it was generated from audio. The service reads every line of a chat window, code editor, or document and drowns out the meaningful action.

**Why it happens:** Multimodal models are good at completing text-like patterns, and the input contains both frame pixels and text metadata. The current prompt correctly ranks directly visible text above dialogue context, but a free-form model response does not prove that a claimed string was legible in the frame.

**Prevention:** Require `visibleTextEvidence` for `[txt]`: frame ID, crop or OCR confidence, and a legibility decision. Reject guesses, preserve uncertain strings as no output, and cap long text to a meaning-preserving summary. Keep `[txt]` and `[trans]` distinct in the schema and player. Never phrase an audio-derived translation as “화면에 자막이 표시됩니다.”

**Warning signs:** unusually long `[txt]` lines, OCR output with low confidence, output text not present in any frame crop, or `[txt]` timestamps that match dialogue starts but not visual changes.

**Confidence:** HIGH for the required distinction; MEDIUM for any OCR threshold until calibrated against the evaluation set.

### 3. Scheduling descriptions into dialogue instead of pauses

**What goes wrong:** TTS speaks while a person is speaking, a key sound effect occurs, or a translated line is playing. The player technically plays every item but the user cannot understand any of them. Timestamping a description at the nearest keyframe is not the same as finding a safe audio window.

**Why it happens:** Frame times, subtitle times, ASR times, and generated-audio durations are different clocks. The existing format stores integer timestamps, while Korean TTS duration varies with sentence length and pronunciation.

**Prevention:** Build a timing validator that checks every candidate against dialogue intervals, translated-dialogue intervals, scene-change time, and synthesized duration. Prefer existing pauses, enforce a minimum lead/lag guard band, and reject or defer items that cannot fit. Keep an explicit “not enough pause” state instead of forcing overlap. Extended audio description is a separate product decision; do not silently pause the YouTube video to hide the scheduling failure. WCAG describes standard audio description as narration added during existing pauses and identifies failure to use available dialogue pauses as a common failure.

**Warning signs:** TTS start times are monotonic but overlap source speech; audio duration exceeds the gap; many lines are queued at the same second; users skip or replay dense sections.

**Confidence:** HIGH for the accessibility principle; MEDIUM for project-specific guard-band values.

### 4. Duplicating events at chunk boundaries

**What goes wrong:** The last action in chunk N is repeated at the start of chunk N+1 because overlapping frames and transcript windows are both included. Scene-change descriptions, translation lines, and screen text are each emitted twice with slightly different wording.

**Why it happens:** Parallel workers need overlap to see context, but no worker owns the overlap. A naive timestamp sort does not identify semantic duplicates. A four-second suppression rule in the prompt is not enough when the duplicate wording differs or when a boundary falls inside one action.

**Prevention:** Define boundary ownership: each event belongs to exactly one chunk by its canonical timestamp, while overlap is read-only context. Deduplicate after local parsing using normalized text, evidence overlap, event type, and a boundary window. Preserve the richer or better-evidenced candidate, not whichever worker finishes first. Run a deterministic ordered merge after all chunks complete and before TTS.

**Warning signs:** duplicate timestamps near `chunkStart`/`chunkEnd`; identical actors or objects reintroduced without a state change; output count increases linearly with the number of chunks; replay at a boundary repeats a sentence.

**Confidence:** HIGH. This is a direct consequence of the proposed overlap/parallel design and the prompt’s short-repeat rule.

### 5. Hallucinating continuity across independently generated chunks

**What goes wrong:** A worker assumes a person, object, scoreboard, or location persists after it leaves the overlap. Entity labels drift (“the woman in red” becomes “the woman in blue”), an off-screen event is invented, or a later reaction is incorrectly connected to an earlier action. Parallel drafts make locally plausible but globally contradictory descriptions.

**Why it happens:** Workers do not share hidden model state. A short free-form summary is insufficient to distinguish confirmed state from a prior guess. A merge pass may smooth contradictions by inventing a causal bridge.

**Prevention:** Carry a compact, typed continuity state: stable label, last confirmed timestamp, attributes with evidence, current location, active action, and uncertainty. Never promote an inferred identity to a stable label without repeated visual evidence. The ordered merge pass may remove, relabel, or downgrade a claim, but must not add an event absent from a frame or trusted transcript. Mark unresolved transitions as unknown and prefer omission over continuity fiction.

**Warning signs:** new names without evidence, contradictory colors/locations, “again/still/then/because” without a supporting transition, or a chunk’s first line depending on an event that the previous chunk did not emit.

**Confidence:** HIGH for the architecture risk; MEDIUM for the best state representation until tested on films, lectures, sports, and games.

### 6. Losing timestamp meaning during chunk offset and merge

**What goes wrong:** Local timestamps are stored as global timestamps without adding the chunk offset, overlap events are shifted twice, subtitle starts are rounded into the wrong scene, or an event is emitted outside the video duration. A restart replays a chunk with a different offset and creates a second version.

**Why it happens:** FFmpeg extraction, Whisper/ASR, keyframe indexing, model timestamps, integer output tags, and video duration each have different precision and origin. Chunk metadata is often kept in process memory rather than persisted with the result.

**Prevention:** Persist `chunkStart`, `chunkEnd`, `sourceTimebase`, and `inputFingerprint` with every artifact. Convert all local times to a canonical decimal-second representation exactly once. Validate `0 <= start < duration`, monotonic ordering, scene-evidence proximity, and stable output under retry. Keep integer tags as a presentation format only; retain higher precision internally.

**Warning signs:** negative or out-of-range timestamps, events clustering at chunk starts, a replay changing timestamps, or a TTS file whose spoken content starts before its database record.

**Confidence:** HIGH as an integration risk; exact tolerance values need real media fixtures.

### 7. Making long-video processing cost or latency quadratic

**What goes wrong:** Every chunk resends the entire transcript, all previous frames, and an ever-growing continuity summary. Parallelism lowers one request’s wall time but multiplies memory, FFmpeg processes, tokens, and API calls until the host or quota fails.

**Why it happens:** Long-video context is easy to model as “append more context.” Gemini’s video documentation notes that default visual sampling is about one frame per second and gives approximate per-second token costs; repeating the same media and prompt context defeats caching and makes cost proportional to both video length and chunk count.

**Prevention:** Bound each chunk’s media and text window. Keep a compact state summary rather than raw history, cache immutable media/transcript artifacts by content hash, and send only the overlap plus state required for the next decision. Measure input tokens, output tokens, wall time, RAM, disk, and child-process count per stage. Use separate semaphores for model calls, FFmpeg/Whisper, downloads, and TTS; one global worker count is not sufficient.

**Warning signs:** input tokens per chunk grow over time, later chunks are slower, RSS grows monotonically, duplicate media uploads appear, or cost per video increases faster than duration.

**Confidence:** HIGH for provider constraints; MEDIUM for the final chunk-size policy.

### 8. Assuming an in-memory lock is a job system

**What goes wrong:** Two batch requests for the same video create work concurrently in `backend/temp/<videoId>`, charge twice, race on cleanup, and overwrite each other’s status. Interactive processing has a process-local lock, while the batch path currently lacks equivalent locking and user context.

**Why it happens:** Cache lookup happens after work starts, and a `Set` disappears on restart or cannot coordinate another process.

**Prevention:** Create a durable job record before any download or AI call. Use a unique idempotency key such as `(canonicalVideoId, profileVersion, promptVersion, outputPolicyVersion)` and a database uniqueness constraint. Return the existing job for a duplicate request. Acquire a lease with owner, expiry, heartbeat, and attempt number; make every stage safe to replay. Use a per-job workspace, never a shared video directory, and apply authorization, balance, and quota checks at enqueue and worker execution.

**Warning signs:** multiple active jobs for one key, duplicate Gemini request IDs, temp-directory collisions, negative balance after retries, or a batch job with no user ID.

**Confidence:** HIGH from the repository audit.

### 9. Losing jobs and SSE progress on process restart

**What goes wrong:** SQLite says a job is processing while the Node process has stopped; the lock and timers are gone; the browser’s EventSource disconnects; a new request starts a second job; partial chunks are either discarded or presented as complete.

**Why it happens:** Runtime state is split between SQLite, filesystem artifacts, caches, and process memory. SSE is a delivery channel, not durable state.

**Prevention:** Persist job and chunk state transitions, heartbeats, attempt IDs, artifact paths, and output revision. On startup, reconcile expired leases and filesystem artifacts: resume only validated pending chunks, mark ambiguous external calls for review/reconciliation, and clean only unowned files past retention. Provide a job-status endpoint and replayable progress cursor so SSE reconnects can catch up. Emit “partial, resumable” distinctly from “complete.”

**Warning signs:** stuck `processing` records, progress resets to zero after reconnect, completed chunks are regenerated, or the UI reports success while the output file is absent.

**Confidence:** HIGH from the repository audit and SQLite/WAL transaction behavior.

### 10. Letting temporary media and audio cache consume the host

**What goes wrong:** A long video, duplicate batch, interrupted FFmpeg process, or failed cleanup leaves hundreds of megabytes in `backend/temp`; a TTS cache or SQLite WAL grows without retention; the next job fails during download or synthesis.

**Why it happens:** `finally` cleanup cannot run after a hard kill, and current cleanup focuses on TTS cache rather than every job artifact. Disk use is not reserved before acquisition.

**Prevention:** Preflight duration, estimated media size, and free disk. Allocate a unique workspace, write a manifest and owner lease, enforce per-job and host-wide quotas, and run startup orphan cleanup with a grace period. Delete only artifacts whose lease is expired and whose job is terminal. Track cache hit rate and bytes by type; retain source fingerprints and metadata after deleting bulk media. Test SIGTERM, SIGKILL simulation, disk-full, and partial-download cleanup.

**Warning signs:** free disk below reservation, orphan directories older than the lease timeout, temp size diverging from active-job estimates, or cleanup deleting a file still referenced by a resumable chunk.

**Confidence:** HIGH from the repository audit.

### 11. Turning retries into quota exhaustion or a retry storm

**What goes wrong:** The same 429, 403, invalid-cookie, timeout, or malformed response is retried immediately by the route, worker, provider SDK, and batch wrapper. Parallel chunks amplify the storm. A retry is charged or billed again even though the first external request may have succeeded.

**Why it happens:** Failure classification is not explicit, provider rate limits are multidimensional, and the project records cost/request telemetry but does not yet have a durable attempt policy.

**Prevention:** Classify errors as transient, quota, authentication, unavailable-content, validation, or permanent. Use exponential backoff with jitter, honor provider retry guidance, cap attempts and total elapsed time, and pause a shared circuit when quota is exhausted. Reserve user balance before enqueueing, record actual usage after each provider response, and make external calls idempotent where possible. The YouTube Data API documents that even invalid requests consume quota, while Gemini limits are evaluated across RPM, input TPM, and RPD; concurrency alone cannot protect all three.

**Warning signs:** repeated calls with the same input fingerprint, retry count rising across all jobs, quota falling while useful output is flat, or a user being charged for a job that never produced a validated artifact.

**Confidence:** HIGH for provider quota facts; HIGH for the repository retry risk.

### 12. Treating YouTube acquisition failure as a content failure, or vice versa

**What goes wrong:** Bot detection, cookies, impersonation, 403/429 responses, unavailable captions, private videos, and malformed URLs are collapsed into “AI generation failed.” The system may spend AI budget after a partial or wrong download, or retry an access denial forever.

**Why it happens:** Acquisition uses several local strategies and runtime capabilities vary. Metadata, media, caption, and frame stages have different failure semantics.

**Prevention:** Make acquisition a typed stage with source URL/video ID, extractor version, cookie profile, HTTP status, media fingerprint, duration, and caption availability. Stop on permanent access errors; allow a bounded fallback only when the failure is plausibly transient. Never infer successful acquisition from metadata alone. Keep a user-safe explanation and an operator diagnostic code. Prefer one supported extractor adapter and representative smoke tests over an undocumented collection of fallback commands.

**Warning signs:** the same video cycles through cookie files without a new error class, a job has metadata but no media fingerprint, or AI calls begin after caption/frame extraction reported failure.

**Confidence:** HIGH from repository logs and dependency concerns; provider behavior is volatile and must be rechecked operationally.

## Moderate Pitfalls

### 1. Letting genre routing override accessibility invariants

**What goes wrong:** A sports, game, or entertainment overlay asks for energetic narration, dense event coverage, or character interpretation and silently weakens the common rules for visual evidence, Korean honorific phrasing, original-dialogue suppression, or short TTS units.

**Prevention:** Compose prompts as immutable base policy plus a constrained genre overlay. Test every overlay against the same Korean-original, foreign-original, OCR, timing, and hallucination fixtures. Route low-confidence classifications to the conservative fallback rather than inventing genre-specific behavior.

### 2. Using one frame cadence for every genre

**What goes wrong:** One-frame-per-second sampling misses a fast sports play, game HUD change, sign-language gesture, scrolling text, or a brief on-screen warning, while dense sampling of a static lecture wastes tokens and disk.

**Prevention:** Make sampling an explicit profile: scene-change/shot detection plus targeted dense frames around speech, OCR changes, rapid motion, and score/HUD updates. Record the sampling profile in the input fingerprint so retries cannot silently produce a different evidence set.

### 3. Publishing speculative partial output as final output

**What goes wrong:** A chunk completes and is streamed to the player before the ordered merge, dedupe, timing, and provenance checks. Later correction leaves the listener with duplicate or contradictory speech and makes SSE reconnect behavior non-deterministic.

**Prevention:** Stream durable stage/chunk progress immediately, but publish transcript revisions only after validation. Give each segment a stable ID and revision; the player must ignore superseded segments and never synthesize unvalidated candidates.

### 4. Charging at the wrong point in the retry lifecycle

**What goes wrong:** The service debits once at enqueue, again on each retry, or after a provider response that was never persisted. A restart then either charges twice or permits unbounded free retries.

**Prevention:** Reserve a bounded estimate at enqueue, attach provider request/usage IDs to each attempt, settle only from recorded usage, and release unused reserve on terminal completion. Make settlement idempotent with a unique `(jobId, stage, attempt)` key.

### 5. Treating cache hits as interchangeable across policy versions

**What goes wrong:** TTS or AI artifacts generated with another voice, speed, prompt, language policy, frame profile, or model version are reused because the cache key contains only video ID and text.

**Prevention:** Include input/media fingerprint, segment text, output policy version, prompt/genre version, model, voice, locale, speaking rate, and format in cache keys. Keep provenance with the artifact and invalidate on policy changes.

### 6. Making accessibility state visual-only

**What goes wrong:** A screen-reader user hears no useful explanation for queued, retrying, partial, failed, or resumed states; a spinner or color-coded genre label is the only status signal. Controls can be reached visually but not operated or announced through keyboard and assistive technology.

**Prevention:** Expose semantic labels, focus-safe live-region updates, pause/skip/retry controls, transcript navigation, and text equivalents for all status states. Test with a Korean screen reader and keyboard, not only DOM snapshots.

## Minor Pitfalls

### 1. Inconsistent entity labels after a scene cut

**What goes wrong:** “왼쪽 인물” changes to “빨간 옷의 인물” or a speaker is named after a single ambiguous frame, making the narration harder to follow even when individual descriptions are factual.

**Prevention:** Keep labels descriptive and stable only within an evidence-backed scene scope; reset them after hard cuts and do not infer identity from appearance alone.

### 2. Raw model punctuation and markup reaching Korean TTS

**What goes wrong:** Tags, brackets, markdown, URLs, emoji, or unexpanded numbers are read aloud awkwardly or cause SSML errors.

**Prevention:** Normalize plain text before synthesis, escape SSML, use tested Korean pronunciation rules, and verify the synthesized duration and returned audio artifact before caching.

### 3. Unbounded telemetry and debug payloads

**What goes wrong:** Full prompts, OCR, captions, request URLs, or repeated progress events fill SQLite/logs and expose PII or cookies while adding synchronous write latency.

**Prevention:** Log hashes, IDs, stage/error classes, timings, and bounded samples; redact content by default, add retention, and keep operational metrics separate from raw evidence.

## Technical Debt Patterns

### Duplicated interactive and batch pipelines

`processVideo` and `processVideoBatch` independently implement download, extraction, AI, persistence, and cleanup. Fixes to language gates, cost checks, retries, or cleanup will drift. Extract shared stage functions and one job policy layer; keep only request-adapter differences at the route boundary. Warning sign: the same bug is fixed in one path or a test mentions only interactive processing.

### Prompt/config/default drift

`PROMPT_FILE` configuration, code defaults, and `prompt_template_codex_v2.txt` can select different behavior. Genre routing can also accidentally replace v2’s invariant rules. Version the base policy, genre overlay, parser schema, and player policy together; persist their versions on every output. Warning sign: a generated script cannot identify which prompt and language policy produced it.

### Free-form line output as the only contract

The current physical-line format is useful for compatibility but weak for provenance, evidence, confidence, duration, and retry reconciliation. Parse into a typed internal representation, validate it, then serialize legacy tags for storage/player compatibility. Warning sign: downstream code infers type from text prefixes or silently drops malformed lines.

### State split across SQLite, files, caches, and memory

A database row, temp file, TTS cache file, and in-memory timer can disagree. Define the durable state machine and artifact manifest first. Treat files as committed only after checksum/size validation and an atomic rename. Warning sign: a status says complete but the artifact is missing or a file exists with no owning job.

### Startup migrations and broad request telemetry

Schema changes embedded in startup and synchronous `api_requests` inserts make recovery and performance depend on application boot. Use versioned migrations and bounded, retained telemetry. Warning sign: a restart changes schema unexpectedly, or telemetry latency appears in every request’s critical path.

### Diagnostic scripts mistaken for regression tests

Backend `test_*.js` files are live probes, not assertions or deterministic fixtures, and the backend test command intentionally fails. Add pure parser/scheduler/idempotency tests, fake provider boundaries, SQLite test databases, and a small media fixture matrix. Warning sign: a script prints an error but exits successfully, or a change is “verified” only against a live YouTube URL.

## Integration Gotchas

- **Gemini video sampling:** Current documentation says visual descriptions use about 1 FPS by default and warns that rapid motion or quick scene changes may be missed. Sports, games, flashing text, and sign-language content need targeted frame extraction or a slower/denser analysis path; do not assume more prompt text restores pixels that were never sampled.
- **Gemini long media and uploads:** The File API is the documented fit for large/reusable media, while inline data is for small one-off inputs. Re-uploading every chunk wastes time and tokens. Store the media/input fingerprint and reuse the provider-side or local artifact only when the provider contract permits it.
- **YouTube URL input is not equivalent to local acquisition:** The Gemini YouTube URL feature is documented as preview and public-video-only. It should not silently replace the repository’s acquisition path for private, age-gated, caption-dependent, or reproducibility-sensitive jobs.
- **Structured output is not semantic validation:** JSON/schema mode can prevent malformed syntax but does not prove that a timestamp, tag, language decision, or visual claim is correct. Validate enum values, timestamps, evidence references, overlap, and provenance in application code.
- **TTS language and SSML:** BCP-47 language codes, selected voice, speed, and pronunciation policy belong in the TTS cache key. Escape SSML reserved characters; do not pass model-generated text as raw markup. Cloud TTS documents that `<lang>` is best effort and has known language-combination failures, so mixed-language Korean narration should use tested voices or separate synthesis segments.
- **TTS duration is not character count:** Korean names, numbers, punctuation, and foreign words change speech duration. Schedule from returned audio duration or a calibrated estimate, not a fixed milliseconds-per-character rule.
- **FFmpeg/Whisper child processes:** Every spawned process needs timeout, cancellation, exit-code capture, stderr classification, and cleanup. A worker crash must not leave a child process holding the job lease or file handle.
- **SQLite WAL:** WAL allows readers and writers to overlap but still has one writer, requires same-host shared memory, and can grow when checkpoints are starved. Do not use a network filesystem for the database, do not copy only the `.db` file while `-wal` state matters, and keep transactions short.
- **SSE is lossy transport:** A reconnecting client can miss events. Persist progress and expose a replay/status API; never make an SSE event the only record of a completed chunk.
- **SSE token leakage:** The current query-string JWT fallback can expose tokens in browser history, proxy logs, and referrers. Prefer a short-lived single-use ticket or header-capable streaming transport.
- **External input injection:** Titles, transcripts, visible text, and captions are untrusted data. Delimit them as data, preserve the prompt’s instruction hierarchy, validate output, and never let model text select a filesystem path, SQL fragment, shell command, or HTML without an allowlist/escaping boundary.

## Performance Traps

| Trap | Observable symptom | Prevention and measurement |
|---|---|---|
| One concurrency number for every resource | CPU thrashing, API 429s, slow TTS, or memory spikes | Separate semaphores for download, FFmpeg, Whisper, Gemini RPM/TPM, and TTS; record queue wait and service time per resource. |
| Full transcript/frames copied into every chunk | Later chunks grow in tokens and latency | Bound context, use overlap plus typed state, hash and reuse immutable artifacts, alert on input-token growth. |
| Parallel drafts merged eagerly | UI shows unstable order or repeated lines | Publish only validated ordered merge revisions; stream chunk progress, not unmerged script as final truth. |
| Eager TTS for rejected candidates | TTS cost and cache size grow with no user-visible lines | Validate language, type, timing, dedupe, and policy before synthesis; include voice/policy version in cache keys. |
| Synchronous telemetry on every API request | Request latency rises under load and SQLite locks appear | Sample/batch noncritical telemetry, retain only needed dimensions, and measure database write time separately. |
| Unbounded search/admin/page limits | Large responses and slow leading-wildcard queries | Clamp page sizes and query lengths; paginate and index the actual reporting/search dimensions. |
| Reprocessing unchanged inputs after restart | Repeated downloads and identical AI charges | Content-address media/transcript/frame artifacts and use durable stage fingerprints with attempt records. |
| Streaming all generated text in memory | RSS grows for long videos and reconnects become expensive | Persist chunks incrementally, cap in-memory buffers, and send cursors/IDs over SSE. |

## Security Mistakes

### Cost and resource abuse through batch or TTS surfaces

Unauthenticated batch processing and permissive public TTS turn a public endpoint into a download/AI/billing proxy. Enforce authentication, per-user quotas, balance reservation, text length limits, global concurrency, and idempotency in the shared job service—not only in the interactive route. Alert on anonymous volume, repeated video IDs, and high-cost users.

### Prompt injection through YouTube-controlled content

A title, caption, visible sign, chat message, or transcript can contain “ignore previous instructions” text. The prompt says to treat such input as data, but the model can still be influenced. Keep trusted policy after untrusted content where supported, label each input channel, use structured output, run output policy checks, and include adversarial fixtures. Never use external text as authorization or as a tool command.

### Secret, cookie, and personal-data exposure

Cookie files, `.env` backups, identity verification/OCR results, phone numbers, and request logs are high-value artifacts. Do not include raw captions, OCR, cookies, tokens, or personal fields in debug logs or model prompts unless required. Remove tracked secrets and rotate them; apply retention and access policy to temp media, logs, audio, and database backups.

### Path, URL, and artifact confusion

Never derive a filesystem path directly from a user URL, title, or model output. Canonicalize and validate YouTube IDs, use generated workspace IDs, reject traversal/control characters, and serve only known artifact roots. Do not treat a remote URL as a local file or allow arbitrary fetch targets.

### Unsafe rendering of generated transcript text

Generated descriptions and visible text can contain markup, scripts, or misleading control characters. Escape before HTML rendering, keep plain-text storage separate from markup, and test screen-reader output. Tags such as `[v1]` are internal metadata, not user-provided HTML.

## UX Pitfalls

- **Progress that lies:** “Generating” with no stage, chunk, retry, or estimated uncertainty makes a 60-minute job appear frozen. Announce durable stages and distinguish queued, processing, retrying, partial/resumable, failed, and complete.
- **Completion before playable audio:** Do not mark a script complete before validation and required TTS artifacts are ready. If audio is partial, expose which timestamps are unavailable and keep the text usable.
- **Reconnect resets the job:** A blind user should be able to return to the player and hear the same job state after SSE loss or refresh. Restore status from the server and announce only genuinely new progress.
- **Wrong genre confidence presented as fact:** Genre routing is a quality hint, not a fact about the creator or subject. Show fallback behavior internally or accessibly, and route low-confidence classifications to the conservative common policy.
- **Verbosity changes core access:** Low verbosity may remove plot-critical visual changes or foreign dialogue translations. Apply verbosity after safety/provenance/timing selection, not by deleting required content indiscriminately.
- **Audio collisions are invisible:** The player must prevent or clearly sequence overlapping TTS, original dialogue, and translated speech. Do not rely on a visual timeline alone; expose accessible status such as “translation skipped because Korean original is already audible.”
- **Poor Korean prosody:** Long sentences, raw tags, unexpanded abbreviations, numbers, names, and mixed scripts sound unnatural or become ambiguous. Enforce short sentence units, tested pronunciation rules, and audible review by Korean screen-reader users.
- **Inaccessible controls and errors:** Keyboard focus, semantic labels, live-region announcements, pause/skip controls, playback speed, verbosity, transcript navigation, and retry actions need automated and manual screen-reader checks. A color-only category or spinner-only failure is not sufficient.
- **Failure destroys useful work:** Preserve validated chunks and offer resume/retry-from-failed-chunk. Never force a blind user to restart a multi-hour job because one late TTS call failed.

## Looks-Done Checklist

### Quality and language

- [ ] Korean-original fixtures prove that spoken Korean and identical Korean subtitles are never emitted as TTS `[trans]`/`[txt]`.
- [ ] Foreign-original fixtures prove that translation is emitted once, preserves negation, numbers, names, questions, and timing, and is not falsely described as visible text.
- [ ] Mixed and unknown-language fixtures prove that uncertain intervals are suppressed rather than guessed.
- [ ] OCR fixtures cover blurred, cropped, stylized, scrolling, and long text; `[txt]` requires visible evidence and never falls back to transcript text.
- [ ] Model output is parsed into typed segments, semantically validated, and rejected/quarantined when evidence, tag, timestamp, or provenance is invalid.
- [ ] Genre routing cannot remove common v2 invariants: visual evidence, no speculation, no duplicate original dialogue, short Korean honorific sentences, and strict tags.

### Timing and continuity

- [ ] Every description is checked against dialogue/translation occupancy and synthesized duration.
- [ ] Chunk boundary fixtures prove no duplicate event, subtitle, or screen text in the overlap window.
- [ ] Continuity fixtures cover an actor/object leaving and returning, identity ambiguity, scene cuts, scoreboard changes, and contradictory local drafts.
- [ ] Local-to-global timestamp conversion is tested across nonzero offsets, overlap, retries, truncation, and end-of-video boundaries.
- [ ] Output order is deterministic for the same input fingerprint, prompt versions, and provider response fixtures.

### Jobs, restart, and storage

- [ ] Duplicate interactive and batch submissions return one durable job and one charge.
- [ ] Worker leases expire safely; a restarted process resumes only pending/validated chunks and does not duplicate completed artifacts.
- [ ] SSE reconnect replays status/progress from a cursor or status endpoint.
- [ ] SIGTERM, child timeout, provider timeout, disk-full, partial-download, and malformed-output paths leave no active lease or unowned artifact.
- [ ] Startup reconciliation, orphan cleanup, cache retention, SQLite backup/WAL handling, and disk reservations are exercised on a disposable test database/workspace.

### Cost, quota, and security

- [ ] Per-stage token, request, audio, CPU, RAM, disk, and wall-time metrics are stored without blocking the request path.
- [ ] 429/RPM/TPM/RPD and YouTube access failures use bounded classified retries with jitter and circuit behavior.
- [ ] Balance/quota authorization is enforced both when enqueueing and when a worker starts/retries a stage.
- [ ] Batch, TTS, SSE tickets, CORS, URL validation, output escaping, cookies, secrets, OCR, and PII logging have explicit tests or operational checks.
- [ ] Prompt-injection fixtures from titles, captions, OCR, and visible signs cannot alter output schema or invoke tools.

### Accessibility and operations

- [ ] At least one representative video from each supported genre has human review by blind/low-vision Korean listeners for timing, duplication, omission, prosody, and continuity.
- [ ] The evaluation set includes rapid action, dense text, foreign dialogue, Korean dialogue, music/no-dialogue, lecture slides, sports scoreboard, game HUD, and scene-cut boundaries.
- [ ] The player exposes accessible recovery and partial-result states and never requires visual-only interaction.
- [ ] Operators can identify job ID, input fingerprint, stage, attempt, provider error class, artifact checksum, and safe user-facing error without reading secrets or raw PII.

## Recovery Strategies

| Failure | Safe recovery | User-visible behavior |
|---|---|---|
| Duplicate job request | Return the existing job by unique idempotency key; do not re-download or re-charge | “This video is already being processed,” with current progress. |
| Worker/process restart | Reconcile leases; resume only committed pending chunks; quarantine ambiguous provider calls | Resume from the last validated chunk; retain partial transcript. |
| Chunk fails transiently | Retry that chunk with bounded backoff and same input fingerprint; preserve prior chunks | Show retry count and affected time range, not a reset progress bar. |
| Gemini 429/quota | Stop new work for the affected quota bucket, respect retry policy, drain/retry later | Explain delay as service capacity; do not endlessly spin. |
| YouTube 403/429/private/unavailable | Classify as acquisition/access failure; bounded fallback only for transient classes | Ask for another accessible/public video or retry later; do not report “AI quality” failure. |
| Malformed or semantically invalid model output | Reject the candidate, retry with same evidence at most once if transient, otherwise mark chunk for fallback/manual review | Keep validated neighboring output and identify the missing interval. |
| Boundary conflict | Re-run deterministic merge using canonical ownership and evidence; prefer omission over invented bridge | Publish the last stable revision; do not flicker between contradictory lines. |
| TTS failure or unsupported language | Keep validated text, retry with tested voice/profile, or mark audio unavailable; never substitute the original dialogue | Let the user read/navigate the text and retry only missing audio. |
| Disk reservation failure | Do not start acquisition; reclaim only expired unowned artifacts, then re-evaluate | Clear storage-capacity error with job preserved for later resume. |
| SSE disconnect | Use server status/replay cursor; do not restart processing because the client disconnected | Reconnect and announce only missed/new progress. |
| Database busy/WAL/backup issue | Keep transactions short, retry bounded writes, checkpoint/backup with the database’s journal state, alert operators | Preserve job state and show temporary service delay rather than false failure. |

## Pitfall-to-Phase Mapping

| Suggested phase | Primary risks addressed | Required proof before phase completion |
|---|---|---|
| 1. Provenance and output contract | Original-language TTS duplication, translation/OCR confusion, free-form parser drift, prompt/config version drift | Typed segment schema, language/provenance gates, legacy serialization, adversarial language/OCR fixtures, semantic validation tests. |
| 2. Genre classification and prompt routing | Wrong genre voice/verbosity, genre prompt overriding safety invariants, prompt injection through metadata | Confidence/fallback policy, versioned base-plus-overlay prompts, structured classification, per-genre evaluation set, no-regression checks for v2 rules. |
| 3. Long-video chunking and continuity | Boundary duplication, hallucinated continuity, offset drift, context/token growth | Deterministic chunk ownership, typed continuity state, ordered merge, timestamp property tests, long-video fixture with scene cuts and repeated entities. |
| 4. Durable jobs and bounded workers | Duplicate batch jobs, restart loss, retry storms, orphan children, quota/resource abuse | Durable state machine, unique job key, leases/heartbeats, per-resource semaphores, classified retries, restart/SIGTERM/disk-full tests, authenticated enqueue. |
| 5. Cost, cache, storage, and TTS scheduling | Repeated uploads/calls, token and disk exhaustion, TTS collisions, wrong cache reuse, SQLite telemetry pressure | Input/artifact fingerprints, stage metrics, cache-key policy, disk quotas/orphan cleanup, pause-aware timing validator, TTS duration and language tests. |
| 6. Accessible playback and operational hardening | SSE recovery, inaccessible progress/errors, audio overlap, secrets/PII exposure, unsafe rendering | Screen-reader UAT, keyboard and live-region checks, replayable progress, partial-result UX, redaction/retention audit, security regression suite. |

**Phase ordering rationale:** Provenance and typed output must precede genre overlays because routing must not weaken language or evidence rules. Chunk ownership and continuity must precede parallel workers because durable retries cannot safely replay an ambiguous merge. Cost/storage and TTS scheduling depend on stable artifacts and timestamps. Playback and hardening come after the server can expose durable, truthful state, while their accessibility contracts should be tested throughout rather than deferred entirely.

## Phase-Specific Warnings

| Phase topic | Likely pitfall | Mitigation |
|---|---|---|
| Language classification | Treating a high-confidence transcript language as audio truth | Keep signal provenance separate and gate unknown conservatively. |
| Genre routing | A classifier chooses a confident but inappropriate template | Five-category allowlist plus conservative fallback; record confidence and model version. |
| Chunking | Overlap is counted twice or local time is offset twice | Canonical ownership, exact offset conversion, deterministic merge tests. |
| Parallel workers | More workers increase total host/API contention | Per-resource budgets, queue wait metrics, and a small default concurrency. |
| Continuity | Merge pass invents causal links to make drafts coherent | Evidence-backed state; allow “unknown” and omission. |
| Job persistence | Database status and filesystem artifact disagree | Atomic artifact commit, manifest/checksum, startup reconciliation. |
| TTS | Cache returns audio generated under a different policy/voice/language | Include all synthesis parameters and policy version in the cache key. |
| SSE/player | Client reconnect causes duplicate speech or restarts work | Server-side cursor/replay, client dedupe by segment ID and output revision. |
| Evaluation | Aggregate quality score hides catastrophic duplicate narration | Report hard-failure rates separately: original-dialogue duplication, hallucination, timing overlap, missing core event, and wrong language. |

## Sources

### Repository evidence (HIGH confidence; inspected 2026-08-24)

- `.planning/PROJECT.md` — active requirements, constraints, decisions, and architecture context.
- `.planning/codebase/CONCERNS.md` — duplicate batch jobs, YouTube acquisition failures, in-memory state, temp-disk exhaustion, permissive batch/TTS surfaces, SSE token exposure, and missing recovery tests.
- `.planning/codebase/TESTING.md` — absence of backend assertion tests, deterministic fixtures, API tests, restart tests, and E2E accessibility coverage.
- `backend/prompt_template_codex_v2.txt` — language/provenance rules, visual-evidence priority, no-speculation policy, timing/tag format, and duplicate suppression rules.

### Standards and provider documentation (HIGH confidence; current pages checked 2026-08-24)

- [W3C WCAG 2.2, Guideline 1.2 and Success Criterion 1.2.5](https://www.w3.org/TR/WCAG22/) — audio description requirement for prerecorded synchronized media.
- [W3C Understanding Audio Description (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/audio-description-prerecorded.html) — descriptions during existing pauses, important visual information, and failure F113.
- [W3C Description of Visual Information](https://www.w3.org/WAI/media/av/description/) — descriptive transcripts, extended description, and planning for timed visual information.
- [American Council of the Blind TTS Guidelines](https://www.acb.org/guidelines-for-use-of-text-to-speech-tts) — quality, timing, dignity, and accessibility considerations for synthetic audio description.
- [European Union Publications Office: Audiovisual Elements](https://op.europa.eu/en/web/accessibility/transcript-audiovisual-elements) — pause-aware, synchronized, objective description and spoiler avoidance.
- [Google Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) — video input modes, long-media guidance, timestamp handling, sampling behavior, and token considerations.
- [Google Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) — RPM, input TPM, and RPD dimensions plus batch limits.
- [Google Gemini context caching](https://ai.google.dev/gemini-api/docs/caching) — implicit caching behavior and API-specific caching constraints.
- [Google Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output) — schema-constrained syntax does not replace application semantic validation.
- [Google Cloud Text-to-Speech SSML](https://docs.cloud.google.com/text-to-speech/docs/ssml) — escaping, pauses, voice selection, BCP-47, mixed-language limitations, and timepoints.
- [Google Cloud Vision text detection](https://docs.cloud.google.com/vision/docs/ocr) — OCR extracts detected text; it is not evidence that text was legible, semantically important, or spoken on the original audio.
- [YouTube Data API quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost) — invalid requests consume quota and pagination incurs additional cost.
- [yt-dlp README](https://github.com/yt-dlp/yt-dlp/blob/master/README.md) and [YouTube extractor guidance](https://github.com/yt-dlp/yt-dlp/wiki/Extractors) — cookie formats, retry/concurrency controls, request-rate constraints, and volatile acquisition behavior.
- [SQLite Write-Ahead Logging](https://sqlite.org/wal.html) — one-writer behavior, same-host constraint, checkpointing, and WAL growth risks.
- [SQLite transactions](https://sqlite.org/lang_transaction.html) — transaction boundaries and rollback behavior relevant to durable job state.
- [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs) — retry-safe job boundaries and idempotent completion behavior as a reference pattern for durable workers.
- [OWASP LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) and [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/) — untrusted multimodal content, output validation, prompt injection, and unbounded-consumption risks.

## Confidence Notes

- **HIGH:** Repository-specific risks that are explicitly documented in the supplied audits or prompt, and provider/standards facts stated in current official documentation.
- **MEDIUM:** Exact model quality behavior, OCR thresholds, chunk sizes, pause guard bands, and concurrency values. These require measurement on the planned genre-balanced evaluation set.
- **LOW:** No low-confidence claims are required for the roadmap; extractor bot-detection behavior is volatile and should be treated as an operational observation rather than a stable provider guarantee.
