# 06 — Validation and rollout checkpoint

No deployment or push has been performed. All flags remain opt-in; no environment secrets or production configuration were changed.

## Local verification

- Isolated backend suite: 118 passed (node --test, single test concurrency, temporary SQLite).
- Focused frontend suites: 13 passed (qaClient, qaAudioController, qaLatencyTrace, useQaConversation).
- Frontend production build: passed.
- Full frontend suite: App.test.js fails on the existing react-router-dom/Jest resolution path. The Q&A suites pass.
- Earlier bounded live download/provider/desktop-audio evidence remains in RESULTS.md. No new P50/P95 or mobile first-audio claim is inferred from unit tests.

## Staging procedure

1. Back up SQLite using the project's existing procedure. Migrations are additive; do not remove existing video/script/canonical records.
2. Set `QA_INCREMENTAL_SPEECH_ENABLED=true` for authenticated incremental requests and the player; full-cache warming now defaults on with this flag. `QA_CACHE_WARMING_ENABLED=false` explicitly disables speculative warming, while `true` can enable warming independently for the legacy route. OGG capability selection requires the additional staging-only `QA_OGG_STREAMING_ENABLED=true`; default playback is sentence MP3. Restart the staging backend; reload the player to read configuration.
3. Confirm proxy streaming is not buffered and `/api/qa/audio/<capability>` is masked in access logs. The application API tracker already masks that path. Never paste capabilities/JWTs into reports.
4. Exercise cold/warming/warm questions at the same timestamps and with the same complete 1/10/50-turn histories. Record actual playing events, failed attempts and audio mode. Compare using the stage-01 benchmark protocol, without discarding failures.
5. Test cancel during media, model, TTS, fetch and playback; close/reopen; backward seek; five viewers sharing a video; server restart; resource/disk limits; expired tickets and SSE replay. No reconnect may issue a new model request automatically.
6. Verify VoiceOver+iPhone Safari, TalkBack+Android Chrome and NVDA+desktop Chrome with actual audio. Evaluate grounded scene descriptions, Korean semantic repetition, confirmed foreign translation and future-context leakage on fixed fixtures.

Rollback: disable `QA_INCREMENTAL_SPEECH_ENABLED` and reload the player to select the legacy route. Cache warming can remain enabled or be disabled separately. Preserve cache versions, source provenance, video/script tables and current conversation state; disabling a route is not permission to delete assets.

## Request/accounting recovery

`qa_request_receipts` retains request ID, owner, body fingerprint, lifecycle status and usage status without conversation text. Reusing an existing ID after process restart returns 410 rather than automatically calling the model again. Recorded usage and both existing QA cost ledgers commit in one transaction. A crash/cancel without provider usage leaves `usageStatus='unconfirmed'`; it is not a zero-cost result. Reconcile those entries against available provider records before making total-cost claims.

## Not yet release-complete

The live comparison matrix, physical-device checks and factuality/semantic-duplicate evaluation are outstanding. Explicit external-search grounding is implemented and deterministically tested; live provider and search-widget accessibility checks remain before declaring the entire DESIGN complete. Both main-generator/Q&A download orderings, bounded resources, sentence MP3 path and automated failure cases are implemented and tested. This checkpoint intentionally does not mark all QA-01–QA-10 acceptance criteria as complete.

## Existing-video cache report: KFjlKrrZpqc (2026-09-14)

The local user test had 44 current-window JPEGs and one ready VTT; all referenced files existed. The new assets live under `backend/cache/qa/assets/` (or `QA_CACHE_ROOT`), not the legacy `public/frames` and `public/subtitles` directories. Full warming had not run because the incremental flag alone previously did not enable it. No media-stage logging exposed this distinction.

Changes: incremental Q&A now defaults to full warming unless explicitly disabled. `[QA-MEDIA]` logs report cache root, hits/misses, worker lifecycle, subtitle absence/failure and prepared counts. `[QA-GENERATION]` reports the actual frame times, subtitle state, validation rejection reasons and failures without logging questions, answers or signed URLs. With no past visual evidence, scene generation skips the model and returns the fixed unknown sentence; the legacy route also refuses a frame-free model call. Usage remains `not_started` until an actual model invocation.

An isolated, initially empty cache reproduced current-window/VTT readiness at 2,396 ms and full-cache readiness at 9,114 ms: 210 verified asset files and 59 VTT cues. This is one sample, not a percentile claim. The existing user cache was not deleted. See [raw cache result](results/kf-cache-20260914.json).

One bounded model-only probe at 33 seconds accepted five sentences with existing frame references. Visual inspection supported the person/laptop, caption and typing details, but the final three sentences redundantly described typing. This probe does not reproduce or clear the user's specific hallucinated answer: the original question, answer and timestamp are still needed. Frame ID validity alone is not proof of factuality, and semantic repetition remains an open release check.

## Context correction (2026-09-14)

The user's clarified context contract supersedes the earlier historical-frame-only restriction: include the video title, entire generated description script, complete conversation history, and T ± 4-second frames. The incremental route previously omitted both title and script, and its sentence gate could not accept script-based contextual explanations. These omissions are now corrected; the full details and live limitations are in [CONTEXT-UPDATE.md](CONTEXT-UPDATE.md). No-evidence refusal now applies when there are neither images nor usable title/script context; existing script context does not become verified visual evidence.
