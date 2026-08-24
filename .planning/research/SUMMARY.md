# Project Research Summary

**Project:** 뷰래이터: YouTube 화면 해설 서비스
**Domain:** Brownfield accessible Korean YouTube screen-description and audio-description generation
**Researched:** 2026-08-24
**Confidence:** MEDIUM-HIGH

## Executive Summary

뷰래이터는 범용 영상 요약기가 아니라, 시각장애인 사용자가 원음과 충돌 없이 영상의 중요한 시각 정보를 듣게 하는 시간 동기화 화면 해설 서비스다. 전문가가 이 유형의 제품을 만드는 방식은 모델 프롬프트만 개선하는 것이 아니라, 근거가 있는 typed event를 만들고 언어·중복·타이밍·TTS 적격성을 애플리케이션 검증기로 강제한 뒤, 기존 플레이어 호환 형식으로 렌더링하는 것이다. 장르 프로필은 정보 우선순위와 말투만 바꾸는 제한된 overlay여야 하며, `prompt_template_codex_v2.txt`의 시각적 근거 우선, 추측 금지, 짧은 한국어 존댓말, 태그·타임스탬프, 원음 중복 금지 규칙은 모든 경로의 불변 기반 정책이다.

60분 이상 영상은 전체 영상을 한 번에 모델에 보내지 않고, 영속 manifest와 compact global memory를 만든 뒤 3–8분 안팎의 시간·장면 청크로 나눈다. 청크 초안은 Gemini의 전역/작업별 제한을 지키며 bounded parallelism으로 생성할 수 있지만, overlap 소유권, continuity state, timestamp 변환, deduplication, canonical publication은 timestamp 순서의 merge frontier 하나만 변경해야 한다. 장시간 작업은 SQLite 기반 job/chunk/lease/event/artifact 상태로 restartable하게 만들고, SSE는 저장된 이벤트의 replay transport로 취급해야 한다. 가장 큰 위험은 잘못된 장르보다 한국어 원음·자막을 다시 읽는 것, 청크 경계 중복과 허구의 연속성, 그리고 긴 대기 중 진행률을 거짓으로 보이는 것이다.

## Key Findings

### Recommended Stack

기존 Node.js/Express 5.1.0, React 19.1.1, CommonJS 모듈형 모놀리스, `better-sqlite3` 12.4.1, Google Cloud TTS 6.3.0, FFmpeg/yt-dlp/Whisper를 유지한다. 새 AI 호출은 `@google/genai` adapter 뒤에 두고 Gemini structured output과 Zod 4로 profile, canonical event, persisted payload를 검증한다. 정확한 새 패키지 버전과 Gemini API surface는 구현 직전에 lock해야 하며 SDK migration과 prompt redesign을 한 변경으로 섞지 않는다.

**Core technologies:**
- Node.js + Express / React player: 기존 API, SSE, verbosity, 동기화 재생 계약을 보존한다.
- SQLite WAL + `better-sqlite3`: 단일 VM에서 transactional jobs, leases, chunks, events, artifacts를 추가하고 `BEGIN IMMEDIATE`로 claim한다.
- `@google/genai` adapter + structured JSON + Zod: 장르 profile과 description event를 typed contract로 만들되 semantic truth는 별도 검증한다.
- Per-resource limiters: Gemini, FFmpeg/Whisper, download, TTS에 별도 budgets를 두어 `Promise.all`식 폭주를 막는다.
- Cloud TTS + content/policy-aware cache: provider 교체보다 `speechPolicy`, 실제 음성 길이, voice/policy version을 올바르게 관리하는 것이 중복 방지에 중요하다.
- Pino/OpenTelemetry: job/chunk/stage correlation, 비용·지연·재시도·cache hit를 기록하되 prompt/audio/PII를 hot path에 남기지 않는다.

운영 토폴로지에는 연구 간 미해결점이 있다. STACK은 기존 PM2 fork-mode 단일 프로세스와 in-process worker loop를 우선 제안하고, ARCHITECTURE는 API와 generation worker를 분리하라고 제안한다. 로드맵은 어느 경우에도 SQLite를 권위 있는 상태로 먼저 만들고, API handler가 작업을 직접 실행하지 않게 한다. 단일 VM에서 API 프로세스와 한 개의 fork-mode worker 프로세스로 시작하는 방안을 권장하며, 같은 프로세스 loop가 충분한지는 측정 후 결정한다. PM2 cluster와 로컬 SQLite 공유, Redis/BullMQ의 선행 도입은 피한다.

### Expected Features

**Must have (table stakes):**
- Evidence-grounded visual description과 보수적인 unknown 처리 — 보이지 않는 신원·관계·감정·의도·원인을 만들지 않는다.
- 5개 장르군(news/documentary, lecture, variety, film/drama, sport/game) + low-confidence `fallback` routing — 장르는 정보 우선순위만 조정한다.
- 한국어 원음/동일 자막 중복 억제, 확인된 외국어만 `[trans]`로 번역, 독립적으로 확인된 화면 글자만 `[txt]`로 처리한다.
- 짧고 시간 범위가 맞으며 dialogue와 TTS가 겹치지 않는 cue, deterministic validation, 기존 `[v1]`/`[v2]`/`[v3]`/`[txt]`/`[trans]` 호환 serialization.
- 60분 이상 영상의 chunk completeness, boundary dedupe, continuity, restartable job, 실패 청크만 retry/resume.
- 즉시 job acknowledgement, truthful stage/chunk/ready-through progress, SSE reconnect/replay, 키보드·스크린리더 접근 가능한 재생/오류/복구.
- 장르별 대표 영상과 한국어·외국어·혼합·unknown audio fixture를 포함한 human/evaluation gate.

**Should have (competitive):**
- 장르·정보 밀도·언어·verbosity에 따른 adaptive profile과 설명 우선순위.
- 검증된 범위만 먼저 재생하는 seamless partial playback과 안정적인 cue IDs/revisions.
- 장르별 typed state(스포츠 score/period, 게임 HUD, 강의 slide/topic, 뉴스 headline/location)와 근거가 있는 짧은 bridge recap.
- evidence-linked transcript navigation, failure-localized recovery, listener-adjustable interruption policy.

**Defer (v2+):**
- 세분화된 전 장르·전 언어 taxonomy, 라이브 스트리밍, native mobile, offline download, multi-host orchestration.
- 자유로운 narrator personality/emotional performance, 자동 speaker identity/relationship graph, plot inference.
- 사용자 편집·커뮤니티 correction·fine-tuning workflow와 Redis/BullMQ. 다중 호스트, 측정된 SQLite 병목, 독립 queue scaling이 확인될 때만 external queue를 재검토한다.

### Architecture Approach

API/job service는 인증·quota·idempotency만 처리하고, worker가 영속 SQLite claim과 stage handler를 실행하는 SQLite-first workflow가 적합하다. acquisition, frame/timeline extraction, language/genre routing, immutable global memory, chunk planner, bounded draft scheduler, ordered continuity/merge, policy validator, TTS, progress event store를 명확히 분리한다. 큰 media/frame/audio는 checksum artifact로 filesystem에 두고 SQLite에는 manifest와 작은 normalized data를 저장한다. Draft는 provisional attempt에만 쓰며, ordered merge service만 canonical script와 continuity state를 발행한다.

**Major components:**
1. **Job service/repository** — durable state transitions, idempotency, leases/fencing tokens, attempts, quota, artifact manifest, event sequence를 transactional하게 관리한다.
2. **Asset/profile/memory pipeline** — acquisition 후 audio-language evidence, frame/timeline index, 5-category profile, evidence index, entity/state registry, bounded hierarchical summaries를 freeze한다.
3. **Chunk planner and draft scheduler** — scene-aware primary ranges와 read-only overlap을 만들고 per-job/global resource budgets 안에서 초안을 생성한다.
4. **Ordered continuity/merge reducer** — `next_merge_ordinal`만 전진시키며 local-to-global timestamp, boundary ownership, dedupe, continuity revalidation, adjacent invalidation을 처리한다.
5. **Policy/TTS/playback boundary** — provenance와 timing을 검증해 TTS eligibility를 저장하고, legacy script/API/player와 replayable SSE에 안전한 결과만 노출한다.

### Critical Pitfalls

1. **원음·번역·OCR·화면 글자의 provenance 혼동** — `audioLanguage`, `transcriptLanguage`, `textOrigin`, `subtitleKind`, evidence IDs를 분리하고 `speechPolicy`를 생성·저장·API·TTS·player에서 반복 적용한다. uncertain은 suppress한다.
2. **프롬프트와 장르 overlay가 v2 불변 규칙을 약화** — versioned immutable base + constrained overlay를 사용하고, 모든 profile이 동일한 Korean-original/foreign/OCR/no-speculation regression fixture를 통과하게 한다.
3. **청크 경계 중복과 허구의 continuity** — overlap은 context일 뿐 ownership이 아니며, ordinal merge frontier만 canonical state를 변경한다. evidence-backed typed state가 없으면 bridge를 만들지 말고 생략한다.
4. **60분 context와 병렬성이 비용·메모리를 폭발** — 전체 transcript/frames를 매 청크에 복사하지 말고 global memory, local evidence, rolling canonical tail만 보낸다. Gemini/FFmpeg/download/TTS 별 semaphores와 token/RAM/disk metrics를 둔다.
5. **fire-and-forget, in-memory lock, lossy SSE가 복구를 망침** — unique job key, leases/heartbeats, attempt fingerprints, atomic artifact commit, replayable event store, startup reconciliation을 기본 상태 모델로 만든다.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Canonical Output, Provenance, and v2 Policy Contract
**Rationale:** 장르 routing과 chunking보다 먼저 서비스가 무엇을 말하고 무엇을 TTS하지 않을지를 코드 계약으로 고정해야 한다. 현재 line format은 호환 경계로 보존하되 내부 모델은 typed event여야 한다.
**Delivers:** canonical event schema, evidence/provenance fields, `speechPolicy`, language/duplicate/OCR/timestamp validator, legacy serializer, prompt/config/policy versioning, `prompt_template_codex_v2.txt` regression fixtures.
**Addresses:** evidence-grounded description, non-duplication, quality gate, safe Korean/foreign/mixed/unknown behavior.
**Avoids:** prompt-only enforcement, OCR-as-truth, parser drift, Korean original speech being emitted as `[trans]`/`[txt]`.

### Phase 2: Durable Jobs and One Shared Pipeline Owner
**Rationale:** 장시간 처리와 bounded parallelism은 restart-safe ownership 없이는 안전하지 않다. interactive와 batch를 하나의 job service로 합치고 API에서 실행 lifetime을 분리한다.
**Delivers:** versioned migrations, jobs/chunks/attempts/leases/events/artifacts, unique request fingerprint, quota reservation/settlement, worker claim/heartbeat/fencing, startup recovery, workspace quotas and cleanup, status API.
**Uses:** SQLite WAL, `BEGIN IMMEDIATE`, checksum artifacts, one API plus one controlled worker process (or measured in-process loop).
**Implements:** job repository, worker supervisor, workspace manager, shared stage handlers.
**Avoids:** duplicate charges/jobs, process-memory locks, orphan media, retry storms, unauthenticated batch fire-and-forget.

### Phase 3: Genre Profile Classification and v2-Safe Prompt Routing
**Rationale:** typed output and job identity are prerequisites for reproducible profile experiments. Routing must be cheap, explainable, bounded to five groups, and safe when wrong.
**Delivers:** title/metadata/audio/frame/transcript signal profile, structured category + confidence + model/version, conservative fallback, base-plus-overlay prompt composition, per-genre information priorities and verbosity policy.
**Addresses:** genre-aware feature coverage and adaptive profiles.
**Avoids:** genre priors treated as visual evidence, energetic overlays overriding v2 rules, unknown confidence presented as fact, prompt injection from YouTube content.

### Phase 4: 60+ Minute Memory, Chunking, Bounded Drafts, and Ordered Merge
**Rationale:** this is the core long-video capability and must be built as one ownership/continuity design. Drafts may be parallel; facts and publication may not be.
**Delivers:** deterministic manifest, scene-aware 3–8 minute chunks, exact overlap ownership, compact global memory/evidence index, typed continuity state, per-resource bounded draft pool, canonical timestamp conversion, ordered merge/revision, boundary dedupe, selective adjacent re-run, deterministic partial revisions.
**Addresses:** long-video completeness, continuity-aware descriptions, progressive validated ranges, perceived latency from early draft work.
**Avoids:** one giant request, quadratic context growth, eager parallel merge, offset drift, invented causal bridges, repeated boundary events.

### Phase 5: Timing-Aware TTS, Cache, and Progressive Playback
**Rationale:** only canonical validated events should consume TTS cost or reach the listener. Real audio duration and dialogue occupancy must drive scheduling; this is where perceived latency becomes usable playback.
**Delivers:** pause/overlap validator, returned-audio-duration scheduling, policy-aware TTS cache keys, TTS failure isolation, stable cue IDs and ready-through boundary, partial playback append/reconciliation, SSE event IDs/`Last-Event-ID` replay and single-use stream tickets, accessible progress states.
**Uses:** existing Cloud TTS/player/SSE contracts with compatibility mapping; cache/artifact fingerprints.
**Avoids:** audio collisions, eager TTS for rejected lines, completion before playable audio, reconnect-triggered duplicate speech, query-string token leakage.

### Phase 6: Evaluation, Accessibility, and Operational Hardening
**Rationale:** model quality and Korean listening burden cannot be established from provider docs or aggregate scores. Release gates must expose catastrophic failures separately from average quality.
**Delivers:** five-genre evaluation set, Korean/foreign/mixed/unknown and rapid-motion/OCR fixtures, blind/low-vision listening review, screen-reader/keyboard UAT, cost/latency/retry/WAL/disk dashboards, redaction/retention/security checks, restart/SIGTERM/disk-full/429 tests, external-queue decision metrics.
**Addresses:** user-centered evaluation, accessible controls, truthful recovery, cost/resource security.
**Avoids:** quality averages hiding duplicate narration, diagnostic scripts mistaken for tests, secret/PII leakage, premature Redis migration.

### Phase Ordering Rationale

- Phase 1 establishes the non-negotiable content and TTS contract before any genre or long-video optimization can weaken it.
- Phase 2 makes every later stage restartable and idempotent; the API never owns a generation job merely because an HTTP request is alive.
- Phase 3 freezes a reproducible profile before chunk input hashes are computed, so profile changes cannot silently reuse drafts.
- Phase 4 couples overlap ownership, global memory, continuity state, bounded concurrency, and ordered merge; separating these concerns would recreate boundary and restart bugs.
- Phase 5 schedules only canonical output and then exposes progressive playback from durable state, keeping perceived latency improvements truthful.
- Phase 6 validates accessibility and hard failure rates continuously; it is a hardening phase, not permission to postpone screen-reader contracts until the end.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** Existing parser/player compatibility, exact v2 prompt/config drift, canonical provenance schema, and Korean audio-description wording need repository-specific design work.
- **Phase 2:** SQLite WAL/backup behavior, lease fencing, worker topology, quota settlement, and real restart/disk-full timings need an implementation spike.
- **Phase 3:** Genre thresholds, signal weighting, frame sampling profiles, and Korean domain terminology lack universal standards; validate against the planned fixture set.
- **Phase 4:** Gemini model context/sampling, chunk size, overlap guard bands, continuity state expiry, merge revision cost, and host/API concurrency require load tests and representative long videos.
- **Phase 5:** Korean TTS voice/prosody, synthesized duration, pause policy, mixed-language behavior, and partial-playback semantics require accessible-user testing.
- **Phase 6:** Browser/screen-reader matrix, retention/redaction, and operational SLOs need project decisions even though the underlying accessibility patterns are documented.

Phases with standard patterns (skip research-phase unless repository findings change the scope):
- **Phase 2 portions:** transactional outbox, leases, fencing tokens, idempotent state transitions, and SQLite migration patterns are established; validate locally rather than researching a new queue.
- **Phase 5 SSE portions:** event IDs, `Last-Event-ID`, heartbeats, replay, and resync follow established SSE patterns; research is needed for integration and security, not for inventing the transport.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Existing versions and SQLite-first recommendation align with repository constraints and official provider/database documentation; new SDK/package compatibility remains MEDIUM until locked. |
| Features | MEDIUM-HIGH | Table stakes and non-duplication are explicit project requirements and accessibility guidance; genre priorities, thresholds, and exact UX metrics are product hypotheses. |
| Architecture | HIGH | Durable claims, ordered reducer, evidence-carrying output, and replayable events are mutually reinforcing and directly address current process-memory state; worker-process topology remains unresolved. |
| Pitfalls | HIGH | Repository-specific failures and provider/standards constraints are well supported; model failure rates and chunk thresholds need measurement. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **Genre and sampling policy:** determine confidence threshold, fallback behavior, density profiles, and targeted frame cadence for fast sport/game, dense lecture text, and scene cuts.
- **Continuity semantics:** define which labels/state facts may persist, their evidence requirements, expiry at hard cuts, and when omission beats a revision call.
- **Worker topology:** benchmark one process with loop versus API + worker process under SQLite WAL, child-process limits, deploy/restart, and queue-wait targets.
- **Timing and TTS:** measure Korean synthesis duration, pause guard bands, mixed-language voice behavior, and whether any extended-description mode is allowed; never silently pause the source video.
- **Evaluation and release gates:** recruit blind/low-vision Korean listeners, set separate hard-failure thresholds for duplicate narration, hallucination, overlap, wrong language, and missing core events, and define the accessibility browser matrix.
- **Provider details:** verify `@google/genai` surface, model context/pricing/rate limits, File API reuse, structured-output support, and exact package versions at implementation time.

## Sources

### Primary (HIGH confidence)
- [STACK.md](./STACK.md) — brownfield stack, SQLite-first jobs, Gemini adapter, TTS policy, and provider verification gaps.
- [FEATURES.md](./FEATURES.md) — table stakes, differentiators, anti-features, evaluation needs, and feature dependencies.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — durable workflow, global memory, chunk context, ordered reducer, restart semantics, and build order.
- [PITFALLS.md](./PITFALLS.md) — repository-specific failure modes, phase mapping, recovery strategies, and looks-done checks.
- [PROJECT.md](../PROJECT.md) — validated/active requirements, constraints, current architecture, and key decisions.
- [Google Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output), [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) — schema limits, long-media input, sampling, and context considerations.
- [SQLite WAL](https://www.sqlite.org/wal.html), [SQLite transactions](https://www.sqlite.org/lang_transaction.html) — single-host WAL, one-writer behavior, `BEGIN IMMEDIATE`, and checkpoint constraints.
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/), [W3C audio description guidance](https://www.w3.org/WAI/WCAG21/Understanding/audio-description-prerecorded.html) — synchronized audio-description and accessibility requirements.
- [Google Cloud TTS SSML](https://docs.cloud.google.com/text-to-speech/docs/ssml) — escaping, pauses, locale, and synthesis constraints.

### Secondary (MEDIUM confidence)
- [BullMQ concurrency](https://docs.bullmq.io/guide/workers/concurrency) and [idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs) — future external-queue comparison, not a current recommendation.
- [WHATWG Server-sent events](https://html.spec.whatwg.org/dev/server-sent-events.html) — event IDs and reconnect semantics used to frame the replay design.
- [VidHalluc (CVPR 2025)](https://openaccess.thecvf.com/content/CVPR2025/html/Li_VidHalluc_Evaluating_Temporal_Hallucinations_in_Multimodal_Large_Language_Models_for_Video_Understanding.html) — rationale for explicit temporal-hallucination and continuity evaluation.

### Tertiary (LOW confidence)
- No roadmap dependency is based on a low-confidence source. Exact model quality, OCR thresholds, chunk sizes, and extractor behavior are intentionally treated as validation gaps rather than facts.

---
*Research completed: 2026-08-24*
*Ready for roadmap: yes*
