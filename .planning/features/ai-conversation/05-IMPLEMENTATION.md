# 05 — Quiet sentence-audio player

The player reads authenticated `/api/qa/config` and uses the new path only when enabled. Existing legacy conversations stay on their original path if configuration arrives late.

Implemented:

- A dedicated Q&A audio controller, separate from timed-description audio. The first MP3 sentence plays as soon as its asset arrives. The whole response is never assembled for synthesis.
- Full original history and statuses, fixed question timestamps, same-turn duplicate-submit guard, IME Enter protection, cancel button, close/unmount/video-change invalidation and per-video presence heartbeat.
- Quiet normal waiting: no automatic “잠시만요”, phase announcements or streamed-text live region on the incremental path. Actionable errors are announced once during a request.
- Canceled/partial answers remain visible; replay uses authenticated ticket renewal and already synthesized assets. Completed seq values are not automatically replayed on SSE reconnect.
- Playback gestures prepare audio, rate is applied, URLs are revoked, late callbacks are ignored, and autoplay rejection is not recorded as successful playback. Original video volume and focus are restored on closing. Seeking a question timestamp first cancels Q&A audio.
- Actual `playing` records use `implementation=incremental`. Generation completion and audio queue completion are distinct.

Validation: **13/13** focused frontend tests pass, including replay cursors/UTF-8 splitting, no reissued request on server error, playback order, late audio cancellation, autoplay failure, whole partial history after backward seek, silent normal updates and waiting for audio ended. Production build passes. Full frontend test invocation also runs the pre-existing App.test.js, which fails resolving react-router-dom through the current Jest setup; this is recorded rather than counted as a passing suite.

Browser default is per-sentence MP3. The server supports continuous OGG, with capability-based selection gated by `QA_OGG_STREAMING_ENABLED=true` for staging. Initial failure before any bytes falls back to MP3; partial streams never restart automatically. Actual browser release checks remain open. VoiceOver/iPhone, TalkBack/Android and NVDA/Chrome audible/keyboard verification remain required; mocked tests and a successful build do not substitute for those checks.
