# Roadmap: 뷰래이터: YouTube 화면 해설 서비스

## Overview

This v1 milestone hardens 뷰래이터 around its core value: delivering accurate, natural Korean audio description without repeating the original soundtrack. The work proceeds from a canonical evidence and language policy, through durable job ownership and safe five-group genre routing, into a universal approximately 15-minute chunk pipeline with global memory and ordered continuity, then validated TTS and progressive accessible playback, and finally evaluation and operational release gates. Existing script tags, timestamps, SQLite storage, web player behavior, background processing, and SSE compatibility remain supported at the product boundary.

**Date:** 2026-08-24
**Granularity:** Standard
**v1 coverage:** 26/26 requirements mapped exactly once

## Phases

- [ ] **Phase 1: Canonical Output, Provenance & v2 Policy** - Establish the evidence, language, tagging, validation, and non-duplication contract that every generated result must satisfy.
- [ ] **Phase 2: Durable Jobs & Shared Pipeline Ownership** - Move processing into restartable, idempotent jobs with one durable owner for interactive and batch requests.
- [ ] **Phase 3: Five-Group Genre Classification & Safe Prompt Routing** - Classify videos conservatively and apply bounded genre overlays without weakening v2 safety rules.
- [ ] **Phase 4: Universal 15-Minute Chunking & Ordered Continuity** - Process every video in approximately 15-minute chunks with memory, bounded drafts, continuity, and deterministic merge.
- [ ] **Phase 5: Validated TTS, Progressive Playback & Accessible SSE** - Expose only validated audio-ready ranges through replayable progress and accessible player controls.
- [ ] **Phase 6: Evaluation & Operational Hardening** - Establish representative quality gates, user-centered accessibility review, and measurable production safeguards.

## Phase Details

### Phase 1: Canonical Output, Provenance & v2 Policy
**Goal**: Users receive only evidence-grounded, policy-compliant description events whose language source, timestamp, tag, and TTS eligibility are known before playback.
**Depends on**: Nothing (first phase)
**Requirements**: POLICY-01, POLICY-02, POLICY-03, POLICY-04
**Success Criteria** (what must be TRUE):
  1. Every generated event preserves the v2 visual-evidence, no-speculation, short Korean honorific, tag, timestamp, and repetition rules across all prompt paths, while remaining serializable to the existing `[v1]`, `[v2]`, `[v3]`, `[txt]`, and `[trans]` formats.
  2. Korean, foreign, mixed, and unknown original-audio cases produce distinct language/provenance outcomes; only confirmed foreign speech can become a needed Korean `[trans]` event.
  3. Korean original dialogue and subtitles that duplicate it are excluded from `[txt]`/`[trans]` generation and TTS, while independently evidenced screen text remains distinguishable from translated dialogue.
  4. Malformed or unsafe events are rejected or quarantined before persistence to the playable canonical script, including invalid tags, out-of-range timestamps, unsupported language decisions, duplicates, overlong sentences, dialogue overlap, and ineligible TTS content.
**Plans**: TBD
**Research flags**: Existing parser/player compatibility, prompt/config default drift, canonical provenance fields, and Korean audio-description wording need repository-specific design and fixtures.

### Phase 2: Durable Jobs & Shared Pipeline Ownership
**Goal**: Users can submit one video-generation request and reliably follow or resume one durable job even when requests duplicate or the processing service restarts.
**Depends on**: Phase 1
**Requirements**: JOB-01, JOB-02, JOB-03, JOB-04, JOB-05
**Success Criteria** (what must be TRUE):
  1. A generation request returns a job ID and accepted/queued status promptly, without holding the HTTP request until media or AI generation completes.
  2. Repeated requests for the same video and policy/profile fingerprint resolve to one job with no duplicate download, charge, canonical script, or TTS work.
  3. After a process restart, completed chunks and committed artifacts remain available, expired work is safely reclaimed, and only failed or pending chunks are retried or resumed.
  4. The user can see the durable stage, current chunk, aggregate progress, ready-through state, and whether a retry or resume action is needed; interactive and batch paths report the same job state.
  5. Reconnecting to the job stream restores persisted progress and script state from the server cursor/snapshot, with no duplicate progress or script delivery caused by the lost connection.
**Plans**: TBD
**Research flags**: SQLite WAL and backup behavior, lease fencing, one API plus one controlled worker topology, quota settlement, startup reconciliation, and disk-full timings require an implementation spike and local failure tests.

### Phase 3: Five-Group Genre Classification & Safe Prompt Routing
**Goal**: Users receive descriptions prioritized for the video’s likely genre while uncertain or conflicting signals safely fall back to a conservative general profile.
**Depends on**: Phase 2
**Requirements**: GENRE-01, GENRE-02, GENRE-03, GENRE-04
**Success Criteria** (what must be TRUE):
  1. A video is classified from its title/metadata, dialogue track, audio language, and representative frames into one allowed five-group profile or an explicit fallback profile, with recorded confidence and profile version.
  2. Low-confidence or conflicting signals visibly and behaviorally use the conservative fallback rather than making an unsupported genre-specific claim.
  3. Each supported genre changes information priority, wording style, detail/verbosity defaults, and scene-change sensitivity, while the Phase 1 evidence, language, non-duplication, tag, and timing policies remain active.
  4. An operator can compare representative routing results across all five genre groups and Korean, foreign, mixed, and unknown audio combinations, including the selected fallback and confidence.
**Plans**: TBD
**Research flags**: Confidence thresholds, signal weighting, targeted frame sampling for rapid sport/game or dense text, genre terminology, and fallback review criteria require validation against the evaluation fixtures.

### Phase 4: Universal 15-Minute Chunking & Ordered Continuity
**Goal**: Every video, including short videos, is processed through one approximately 15-minute chunk workflow that preserves global context and publishes a complete, ordered, non-duplicated script.
**Depends on**: Phase 3
**Requirements**: CHUNK-01, CHUNK-02, CHUNK-03, CHUNK-04, CHUNK-05
**Success Criteria** (what must be TRUE):
  1. Short and long videos alike are divided into deterministic time chunks targeting approximately 15 minutes, with the final chunk bounded by the video end and no alternate “only over 60 minutes” path.
  2. Each chunk’s result reflects the frozen full-video memory, adjacent overlap context, genre profile, and evidence-backed continuity state, so supported referents and scene/topic state do not reset at boundaries.
  3. Chunk drafts may run in parallel only within separate configured Gemini, FFmpeg/Whisper, download, disk, and TTS resource limits; later work remains pending when a resource budget is full.
  4. The canonical script is merged in timestamp order with one owner per overlap event, exactly-once local-to-global timestamp conversion, boundary deduplication, and removal of unnecessary re-introductions.
  5. The job exposes every chunk as completed or explicitly failed; the final script never silently includes missing time ranges, unvalidated drafts, or a false complete state.
**Plans**: TBD
**Research flags**: The approximately 15-minute target, scene-aware boundaries, overlap guard bands, global-memory size, continuity expiry, frame cadence, provider context/cost, and merge revision cost require load tests and representative media fixtures.

### Phase 5: Validated TTS, Progressive Playback & Accessible SSE
**Goal**: Users can listen to validated description audio as it becomes safely available, with accurate timing, replayable progress, and keyboard/screen-reader control.
**Depends on**: Phase 4
**Requirements**: PLAY-01, PLAY-02, PLAY-03, PLAY-04
**Success Criteria** (what must be TRUE):
  1. The player offers only validated, audio-ready time ranges for partial playback; newly validated chunks extend the ready-through boundary without unnecessarily restarting or duplicating current playback.
  2. TTS speaks only policy-eligible visual descriptions, independent screen text, and needed foreign translations; Korean original speech and duplicate dialogue are never synthesized, including after seek, retry, cache hit, or SSE reconnect.
  3. Keyboard and screen-reader users can discover and operate generation status, errors, retries, play/pause, seeking, verbosity, subtitle reading, and description audio, with meaningful announcements for queued, partial, resumed, and failed states.
  4. Actual synthesized audio duration and occupied dialogue/translation intervals determine scheduling, so descriptions are rejected, deferred, or placed in safe pauses instead of unexpectedly masking important original audio.
**Plans**: TBD
**UI hint**: yes
**Research flags**: Korean TTS voice/prosody, returned-audio duration, pause guard bands, mixed-language behavior, partial-playback reconciliation, SSE replay/resync, stream-ticket security, and the target screen-reader/browser matrix require integration and user testing.

### Phase 6: Evaluation & Operational Hardening
**Goal**: Operators and release reviewers can detect quality, accessibility, reliability, cost, and resource failures before they harm listeners or exhaust the single-host service.
**Depends on**: Phase 5
**Requirements**: EVAL-01, EVAL-02, EVAL-03, EVAL-04
**Success Criteria** (what must be TRUE):
  1. A reproducible evaluation set covers all five genre groups, Korean/foreign/mixed/unknown audio, rapid scene changes, and screen-text-heavy scenes, with repeatable inputs and expected review annotations.
  2. Evaluation reports separately record visual factuality, original-dialogue duplication, translation accuracy, timing/overlap, chunk continuity, genre fit, repetition, and speculation rather than hiding catastrophic failures in one average score.
  3. Operators can inspect per-job processing time, chunk wait time, AI cost, retry rate, cache hit rate, failure class, temporary disk use, and relevant queue/WAL/resource health without exposing raw prompts, credentials, or unnecessary personal data.
  4. A release passes blind/low-vision listening and screen-reader/keyboard review plus restart, child/API timeout, disk-full, quota/rate-limit, malformed-output, cleanup, and external-service failure tests; failures preserve useful validated work and remain resumable where safe.
**Plans**: TBD
**UI hint**: yes
**Research flags**: Korean blind/low-vision reviewer recruitment, accessibility browser matrix, hard-failure thresholds, telemetry retention/redaction, operational SLOs, and the measured decision point for an external queue need explicit project decisions.

## Coverage Validation

Every v1 requirement is mapped to exactly one phase:

| Requirement group | Requirements | Phase |
|-------------------|--------------|-------|
| Description Policy and Language | POLICY-01–POLICY-04 | Phase 1 |
| Jobs, Progress, and Recovery | JOB-01–JOB-05 | Phase 2 |
| Genre Routing | GENRE-01–GENRE-04 | Phase 3 |
| Universal Chunk Processing | CHUNK-01–CHUNK-05 | Phase 4 |
| Playback and Accessibility | PLAY-01–PLAY-04 | Phase 5 |
| Evaluation and Operations | EVAL-01–EVAL-04 | Phase 6 |

**Mapped:** 26/26 v1 requirements
**Orphans:** 0
**Duplicates:** 0

## Progress

**Execution Order:** Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Canonical Output, Provenance & v2 Policy | 0/TBD | Not started | - |
| 2. Durable Jobs & Shared Pipeline Ownership | 0/TBD | Not started | - |
| 3. Five-Group Genre Classification & Safe Prompt Routing | 0/TBD | Not started | - |
| 4. Universal 15-Minute Chunking & Ordered Continuity | 0/TBD | Not started | - |
| 5. Validated TTS, Progressive Playback & Accessible SSE | 0/TBD | Not started | - |
| 6. Evaluation & Operational Hardening | 0/TBD | Not started | - |
