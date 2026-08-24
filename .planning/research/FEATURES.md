# Feature Landscape

**Domain:** Accessible Korean YouTube screen-description and audio-description generation
**Researched:** 2026-08-24
**Scope:** Improvements in `.planning/PROJECT.md`; existing timed Korean descriptions, verbosity, language tags, subtitle controls, TTS, SSE, and background processing are treated as baseline capabilities.
**Overall confidence:** MEDIUM-HIGH

## Product Reading of the Ecosystem

The product is not a generic video summarizer. Its success criterion is that a blind or low-vision listener can understand important visual information without hearing the same content twice, while the original soundtrack remains usable. Established audio-description guidance consistently emphasizes concise, objective, accurate language, fit within available pauses, and a voice that complements rather than overwhelms the program. WCAG treats synchronized audio description for prerecorded video as a Level AA requirement, and accessible-player guidance includes keyboard operation, clear labels, focus visibility, contrast, and screen-reader support. [HIGH]

For this milestone, genre awareness should change information priority and delivery style, not relax the evidence rules. A classifier with low confidence must route to a conservative general profile. The common rules in `prompt_template_codex_v2.txt`—visual evidence first, no invented identity or intent, explicit language handling, short Korean honorific sentences, timestamps, tags, and duplicate suppression—are product invariants, not optional prompt advice. [HIGH]

Long-video support is a reliability feature visible to the user: a 60-minute job must finish with no silent gaps, preserve references across chunk boundaries, expose usable partial results, and survive reconnects or isolated failures. There is no single accepted product standard for AI-generated long-video continuity, so the proposed features below are an opinionated synthesis of audio-description practice, current video-hallucination research, the existing pipeline, and the user's stated requirements. [MEDIUM]

## Table Stakes

Features users need to trust the service. Missing one makes the output incomplete, unsafe, or unusable for the primary audience.

| Feature | User-observable behavior | Complexity | Dependencies | Confidence |
|---------|--------------------------|------------|--------------|------------|
| Evidence-grounded visual description | Descriptions state only what the supplied frames and reliable timed context support. Unknown identity, relationship, emotion, intent, cause, age, gender, or location is left unknown or described with observable attributes. | High | Frame/context provenance, prompt rules, parser/quality validator, evaluation set | High |
| Genre-aware priority with safe fallback | The service classifies into the five project groups—news/documentary, lecture, variety, film/drama, sport/game—and changes what it prioritizes. Low-confidence or conflicting classification uses the general profile and never invents genre facts. | High | Metadata/audio/frame profile, confidence threshold, per-genre prompt policy, fallback profile | Medium-High |
| Genre-specific information coverage | News/documentary favors headlines, lower-thirds, charts, maps, and scene context; lectures favor slide/board/diagram changes; variety favors entrances, actions, reactions, and readable labels; drama favors scene/location/action continuity and safe referents; sport/game favors score, state, possession, action, and overlays. | High | Genre profile, OCR/text policy, temporal change detection, representative fixtures | Medium |
| Language and non-duplication policy | Korean original speech is not re-read. Foreign speech is translated only when needed and only when language is known. Mixed and unknown audio default safely. Screen subtitles that duplicate speech are omitted; independent important text is retained as `[txt]`; translated foreign speech is `[trans]`. | High | Audio classification, subtitle/source-language metadata, normalized text comparison, script validator, player filter | High |
| Timed, nonintrusive narration | Every line has an in-range integer timestamp, is short enough for TTS, and is scheduled around dialogue and critical sound. Static scenes are not repeated merely because another frame was sampled. | High | Frame timestamps, dialogue timing, silence/overlap checks, TTS duration estimate, duplicate window | High |
| Long-video completeness | Videos over 60 minutes can be processed without loading the entire media payload into one model call. The final script is ordered, timestamp-valid, and has no unexplained chunk gaps. | High | Persistent job/chunk records, bounded media memory, chunking, merge/finalization, resource limits | Medium-High |
| Cross-chunk continuity | The same visible person/object/location is referred to consistently when the evidence supports continuity. Chunk boundaries do not reset the story, repeat an introduction, change a referent arbitrarily, or lose a score/slide/scene state. | High | Overlap windows, ordered merge, compact continuity state, entity/state ledger, boundary dedupe | Medium |
| Progressive and recoverable generation | The user receives an immediate job acknowledgement, stage and chunk progress, and a clear ready-through time. Validated completed ranges can be played before the full job finishes. Reconnecting restores state; one failed chunk can retry or resume without discarding completed work. | High | Durable job state, chunk statuses, idempotent writes, SSE event IDs/reconnect handling, client reconciliation | Medium-High |
| Accessible playback controls | A screen-reader and keyboard user can find and operate play/pause, seek, speed, verbosity, subtitle-reading, original/description balance, repeat/skip, and generation status. Focus moves predictably and status/error changes are announced without stealing focus. | High | Semantic controls, focus management, live-region policy, media clock, player state model | High |
| Separate, controllable description audio | TTS does not unexpectedly talk over Korean original speech or duplicate enabled subtitle audio. Users can pause, replay, speed up, skip, or disable a description and resume the video without losing synchronization. | High | Cue scheduler, audio overlap policy, TTS cache, seek/interrupt handling, language tags | High |
| Quality gate before playback | Malformed tags/timestamps, duplicate lines, unsupported translations, overlong TTS lines, and obvious overlap are rejected or quarantined before being spoken. Partial results are playable only after the same checks as final results. | High | Deterministic parser/validator, safe fallback policy, observability, fixture tests | High |
| User-centered evaluation | A fixed representative set covers all five genres and language modes, with human review for visual accuracy, grounding, timing, genre fit, continuity, repetition, translation fidelity, and listening burden. Blind/low-vision users assess whether the result actually improves understanding. | Medium-High | Curated fixtures, annotation rubric, replayable runs, deterministic reports, accessibility test harness | High for need; Medium for exact rubric |

## Differentiators

Features that can make the service substantially better after the safety and playback contract is reliable.

| Feature | Value proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Adaptive genre profile, not just a label | Uses genre, information density, audio language, and selected verbosity to choose what to omit, how often to speak, and which visual changes matter. The user experiences a more useful description without configuring a complex taxonomy. | High | Keep the profile explainable and bounded to five groups plus fallback. |
| Seamless partial playback | A listener can start at the beginning while later chunks are still generating; the player clearly marks the ready-through boundary and appends new validated cues without restarting playback. | High | Strong differentiator for long videos; requires stable cue IDs and client reconciliation. |
| Continuity-aware scene or topic recaps | After a long gap, scene change, slide transition, or resumed session, the service gives a short state-preserving bridge instead of repeating the entire prior chunk. | High | Recaps must be generated only when the continuity state and visual evidence justify them. |
| Domain-specific state summaries | Sport/game outputs can preserve score, period/round, possession, or board state; lectures can preserve slide/topic changes; news can preserve headline/location/graphic changes. | High | Treat state as evidence-backed metadata, not an unconstrained narrative memory. |
| Evidence-linked transcript navigation | Each line can jump to its timestamp and, where appropriate, expose the source frame or a text transcript for review. This improves trust, correction, and accessibility for deaf-blind users using braille. | Medium-High | Expose evidence as an audit aid, not as a claim that model confidence equals truth. |
| Listener-adjustable interruption policy | Users can choose a conservative description mode, a denser mode, or “only essential changes,” while the scheduler still prevents unsafe overlap and preserves required translations. | Medium | Builds on existing verbosity; the safety floor must not be user-disableable. |
| Progress that explains waiting | Stage labels such as preparing media, detecting language, generating chunk 4 of 18, validating, and merging tell the user what is happening and whether action is needed. | Medium | Announce meaningful state changes to assistive technology without speaking every percentage update. |
| Failure-localized recovery | The service names the affected time range, keeps good chunks available, retries transient failures with bounded backoff, and offers resume/retry rather than a generic “generation failed.” | High | Requires persistent error taxonomy and idempotent chunk processing. |
| Accessible output alternatives | Offer a navigable text/descriptive transcript alongside synchronized TTS, so users can scan, replay, search, or use braille/speech technology. | Medium | W3C identifies text descriptions/transcripts as a useful accessible media alternative. |

## Anti-Features

Features or behaviors to explicitly avoid because they reduce trust, accessibility, or audio quality.

| Anti-feature | Why avoid | What to do instead |
|--------------|-----------|--------------------|
| Hallucinated identity, relationship, emotion, intent, cause, or genre facts | Plausible-sounding errors are especially harmful when the listener cannot visually verify them; temporal video hallucination remains an active model weakness. | Use observable descriptors, conservative referents, explicit unknown handling, and a validator/evaluation set that counts unsupported claims. |
| “Helpful” narration of every frame | Produces redundant speech, listener fatigue, and competition with dialogue, music, and sound effects. | Emit only meaningful visual changes, enforce a duplicate window, and let verbosity reduce nonessential detail. |
| Re-reading audible Korean dialogue or duplicate subtitles | Makes the soundtrack harder to understand and violates the product's core non-duplication promise. | Compare normalized source, subtitle, translation, and generated lines; keep only independent visual text or necessary foreign-language translation. |
| Translating when language is unknown or uncertain | A wrong translation can invert facts and falsely imply what was said. | `unknown` means no translation; mixed audio translates only confirmed foreign segments; preserve uncertainty. |
| Treating title or genre as visual evidence | Genre priors can cause stereotyped descriptions and invented context. | Use title/genre only to prioritize attention; require frame or reliable timed context for every claim. |
| Unbounded cross-chunk “memory” | A stale or incorrect memory can propagate an early hallucination through an hour-long video. | Keep a compact, typed continuity state with provenance, expiry, and revalidation at boundaries. |
| Fake progress or a single spinner for long jobs | A blind user cannot tell whether work is advancing, stalled, failed, or ready to use. | Persist stage/chunk state, expose ready-through time, announce actionable status, and support reconnect/resume. |
| Restarting the entire video after one chunk failure | Wastes time and cost and makes long videos feel unreliable. | Retry only the failed chunk, preserve successful outputs, and make merge/finalization idempotent. |
| Visual-only status, color-only errors, or unlabeled icon controls | Excludes screen-reader and keyboard users and makes recovery impossible to discover. | Use semantic controls, text status, live announcements, visible focus, and logical tab order. |
| Automatic TTS autoplay or forced audio ducking | Unexpected speech can be disorienting and can hide important original audio. | Respect user activation/preferences; offer explicit description volume/mix controls and interrupt/replay behavior. |
| Reading every OCR character from dense screens | Long code, chat, captions, or documents become unintelligible and OCR errors become spoken misinformation. | Read only clearly legible, decision-relevant text; summarize dense regions as screen state when exact text is not reliable. |
| Exposing raw model confidence as a truth indicator | Numeric confidence is easy to overtrust and does not replace evidence or user testing. | Use confidence internally for fallback and review priority; expose plain-language availability/limitations where useful. |

## Feature Dependencies

```text
Video/audio/frame profile
  -> genre + language classification with confidence
  -> bounded genre policy + safe fallback
  -> prompt routing and information-priority rules

Evidence and language policy
  -> generated tagged cues
  -> deterministic parser / timestamp / duplicate / overlap validation
  -> TTS selection and accessible playback

Persistent job + chunk state
  -> bounded long-video processing
  -> retries and resume
  -> SSE progress, reconnect, and ready-through playback

Chunk overlap + continuity state
  -> ordered merge
  -> boundary deduplication
  -> stable referents and domain state summaries

Representative genre fixtures + blind/low-vision review
  -> regression gates for grounding, translation, timing, repetition,
     continuity, genre fit, and listening burden
```

The ordering implication is important: progressive playback must depend on validation, and continuity must depend on durable chunk state. Do not stream raw model text directly to TTS merely because it arrives early.

## MVP Recommendation

Prioritize:

1. **One safe description contract across five genre profiles** — preserve the current v2 evidence, language, tag, timing, short-sentence, and non-duplication rules; add genre-specific priorities and a conservative fallback.
2. **Durable long-video chunks with continuity state** — process 60+ minute videos with bounded concurrency, overlap, ordered merge, boundary dedupe, and restart-safe chunk records.
3. **Validated progressive results** — acknowledge the job immediately, report stage/chunk progress, expose only validated ready ranges, reconnect from durable state, and retry failed chunks independently.
4. **Accessible playback completion** — make all status and controls keyboard/screen-reader usable; preserve user control of verbosity, subtitle reading, description audio, timing, replay, and seeking.
5. **Evaluation before optimization** — create representative fixtures for news/documentary, lecture, variety, film/drama, and sport/game across Korean, foreign, mixed, and unknown audio. Gate releases on unsupported-claim rate, duplicate rate, translation fidelity, cue timing/overlap, chunk continuity, genre fit, and user-rated comprehensibility.

The first differentiator to add after this foundation is seamless partial playback with a clear ready-through boundary. It directly reduces perceived waiting while exercising the same persistence, validation, SSE recovery, and player synchronization contracts needed for the full long-video experience.

Defer:

- An all-language or fine-grained autonomous genre taxonomy; it increases misrouting and evaluation scope before the five-group policy is proven.
- Fully personalized narrator personality, emotional performance, or unconstrained density controls; these can conflict with objectivity, timing, and original audio.
- Live-stream description, native mobile apps, offline downloads, and multi-server orchestration; they are outside the current milestone and add operational scope.
- Automated speaker identity, relationship graphs, or plot inference; only add bounded referent tracking when supported by visual/timed evidence.
- User editing, community correction, or model fine-tuning workflows; first establish deterministic quality gates and a trusted evaluation corpus.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Audio-description quality and accessibility | HIGH | Directly supported by WCAG/WAI and American Council of the Blind Audio Description Project guidance; aligned with the repository prompt and constraints. |
| Language and non-duplication behavior | HIGH | Project requirements and prompt are explicit; product policy is stronger than generic caption/transcript conventions. |
| Genre-specific feature priorities | MEDIUM | The five groups and policies come from project scope and established AD judgment, but there is no universal genre-to-feature standard. Validate with representative users and content. |
| Long-video continuity | MEDIUM | Strongly implied by long-video UX and current temporal-hallucination research, but exact state representation and thresholds are product decisions. |
| Progressive generation UX | MEDIUM-HIGH | Existing SSE flow plus the HTML/EventSource reconnection model support the direction; ready-through semantics and partial-playback policy remain product-specific. |
| Evaluation needs | HIGH | Grounding, timing, non-duplication, accessibility, and human comprehensibility are necessary release criteria; exact scoring thresholds need baseline data. |

## Gaps to Address

- Establish Korean-language audio-description review guidance, including acceptable honorific style, pronunciation, and terminology for lecture, sport, and game content.
- Measure real TTS duration and original-audio overlap before fixing cue-window thresholds; a three-second sentence rule is a useful heuristic, not a universal timing guarantee.
- Recruit blind/low-vision evaluators and decide whether “understanding improvement,” listening effort, and interruption annoyance are release-blocking metrics.
- Determine which continuity facts can be safely persisted as typed state and when they expire after a scene, speaker, topic, or location change.
- Define an accessibility browser matrix for keyboard, screen reader, mobile browser, and braille workflows; current repository tests do not yet provide this coverage.

## Sources

### Project sources [HIGH]

- `.planning/PROJECT.md` — milestone requirements, core value, constraints, and out-of-scope decisions.
- `.planning/codebase/ARCHITECTURE.md` — current React/Express pipeline, SQLite state, SSE flow, TTS path, and in-memory processing limitations.
- `.planning/codebase/TESTING.md` — current testing gaps and the need for deterministic parser, player, integration, and accessibility coverage.
- `backend/prompt_template_codex_v2.txt` — current evidence hierarchy, language policy, non-duplication rules, tags, timing, and safe-description constraints.

### External sources

- [W3C Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/) — synchronized audio description requirement and time-based-media criteria. [HIGH]
- [W3C Accessible Media Players](https://www.w3.org/WAI/media/av/player/) — keyboard support, focus, labels, contrast, speed, captions, and screen-reader expectations. [HIGH]
- [W3C Description of Visual Information](https://www.w3.org/WAI/media/av/description/) — audio description and descriptive-transcript alternatives. [HIGH]
- [American Council of the Blind Audio Description Project: Audio Description Standards](https://adp.acb.org/docs/ADP_Standards.pdf) — concise scripts, timing within pauses, speaker identification, and complementing the soundtrack. [HIGH]
- [American Council of the Blind Audio Description Project: Audio Description FAQs](https://adp.acb.org/ad-faqs) — concise/objective descriptions and quality expectations for TTS/AI use. [MEDIUM-HIGH]
- [FCC Disability Advisory Committee Recommendation on Audio Description Quality](https://adp.acb.org/docs/DAC%20Recommendation%20on%20Audo%20Description%20Quality%20Adopted%20October%2014%202020.pdf) — clarity, brevity, conversational language, tone, pronunciation, audibility, and noninterference. [HIGH]
- [VidHalluc: Evaluating Temporal Hallucinations in Multimodal Large Language Models](https://openaccess.thecvf.com/content/CVPR2025/html/Li_VidHalluc_Evaluating_Temporal_Hallucinations_in_Multimodal_Large_Language_Models_for_Video_Understanding.html) — evidence that temporal hallucination needs explicit evaluation in video models. [HIGH]
- [WHATWG HTML: Server-sent events](https://html.spec.whatwg.org/dev/server-sent-events.html) — event IDs and `Last-Event-ID` reconnection semantics relevant to resumable SSE progress. [HIGH]
- [MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — browser behavior for named events, retry, errors, and reconnect handling. [MEDIUM]
