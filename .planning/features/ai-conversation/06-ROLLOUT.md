# 06 — Validation and rollout checkpoint

No deployment or push has been performed. All flags remain opt-in; no environment secrets or production configuration were changed.

## Local verification

- Isolated backend suite: 92 passed (node --test, single test concurrency, temporary SQLite).
- Focused frontend suites: 12 passed (qaClient, qaAudioController, qaLatencyTrace, useQaConversation).
- Frontend production build: passed.
- Full frontend suite: App.test.js fails on the existing react-router-dom/Jest resolution path. The Q&A suites pass.
- Earlier bounded live download/provider/desktop-audio evidence remains in RESULTS.md. No new P50/P95 or mobile first-audio claim is inferred from unit tests.

## Staging procedure

1. Back up SQLite using the project's existing procedure. Migrations are additive; do not remove existing video/script/canonical records.
2. Set `QA_CACHE_WARMING_ENABLED=true` to opt into generation cache sharing. Set `QA_INCREMENTAL_SPEECH_ENABLED=true` independently for authenticated incremental requests and the player. Restart the staging backend; reload the player to read configuration.
3. Confirm proxy streaming is not buffered and `/api/qa/audio/<capability>` is masked in access logs. The application API tracker already masks that path. Never paste capabilities/JWTs into reports.
4. Exercise cold/warming/warm questions at the same timestamps and with the same complete 1/10/50-turn histories. Record actual playing events, failed attempts and audio mode. Compare using the stage-01 benchmark protocol, without discarding failures.
5. Test cancel during media, model, TTS, fetch and playback; close/reopen; backward seek; five viewers sharing a video; server restart; resource/disk limits; expired tickets and SSE replay. No reconnect may issue a new model request automatically.
6. Verify VoiceOver+iPhone Safari, TalkBack+Android Chrome and NVDA+desktop Chrome with actual audio. Evaluate grounded scene descriptions, Korean semantic repetition, confirmed foreign translation and future-context leakage on fixed fixtures.

Rollback: disable `QA_INCREMENTAL_SPEECH_ENABLED` and reload the player to select the legacy route. Cache warming can remain enabled or be disabled separately. Preserve cache versions, source provenance, video/script tables and current conversation state; disabling a route is not permission to delete assets.

## Not yet release-complete

The live comparison matrix, physical-device checks and factuality/semantic-duplicate evaluation are outstanding. Continuous OGG automatic selection/fallback, explicit external-search grounding, reconciliation of unconfirmed canceled usage, and reverse-order Q&A-first/main-generator media ownership need follow-up before declaring the entire DESIGN complete. The existing pipeline-first ordering, bounded resources, sentence MP3 path and automated failure cases are implemented and tested. This checkpoint intentionally does not mark all QA-01–QA-10 acceptance criteria as complete.
