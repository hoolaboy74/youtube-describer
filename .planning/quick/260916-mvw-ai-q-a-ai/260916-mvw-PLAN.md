---
quick_task: 260916-mvw-ai-q-a-ai
type: execute
autonomous: true
requirements: [QA-04, QA-05, QA-08, QA-09]
files_modified:
  - backend/modules/qaMedia.js
  - backend/modules/qaRequestStore.js
  - backend/modules/qaGeneration.js
  - backend/modules/qaRoutes.js
  - backend/tests/qaMedia.test.js
  - backend/tests/qaIncremental.test.js
  - backend/tests/qaRoutes.test.js
  - frontend/src/services/qaClient.js
  - frontend/src/hooks/useQaConversation.js
  - frontend/src/hooks/useQaConversation.test.js
  - frontend/src/screens/PlayerScreenV2.js
  - frontend/src/screens/PlayerScreenV2.test.js
must_haves:
  truths:
    - "A user opening AI conversation on a video with a verified Q&A frame window at the paused timestamp sees a newly generated Korean current-scene summary as the first AI chat message."
    - "Opening the modal never waits for a download, FFmpeg extraction, subtitle fetch, cache warming job, or model request when the required Q&A visual cache is absent."
    - "A cache-hit opening summary uses the existing Q&A context builder, conservative Q&A prompt, frame evidence, sentence validation, streaming/TTS path, and timestamp captured when the modal opened."
    - "An absent cache or a cache race leaves the existing empty-chat, user-asks-first flow unchanged; normal later questions retain their current behavior."
    - "The generated summary does not invent identity, relationship, emotion, intent, cause, location, dialogue, or subtitle translation unsupported by the cached evidence."
  artifacts:
    - path: backend/modules/qaMedia.js
      provides: "Non-blocking, cache-only current-window eligibility and preparation path"
    - path: backend/modules/qaGeneration.js
      provides: "Opening-summary request mode that reuses QA context, PROMPT, validator, and synthesis"
    - path: backend/modules/qaRoutes.js
      provides: "Authenticated cache-eligibility endpoint plus guarded summary request dispatch"
    - path: frontend/src/hooks/useQaConversation.js
      provides: "Cancelable automatic opening-summary request and first-turn state"
    - path: frontend/src/screens/PlayerScreenV2.js
      provides: "Immediate modal opening, exact timestamp capture, and AI-only opening-summary bubble"
  key_links:
    - from: frontend/src/screens/PlayerScreenV2.js
      to: frontend/src/hooks/useQaConversation.js
      via: "handleOpenQaModal captures player.getCurrentTime() and starts a summary only for a new incremental-QA conversation"
      pattern: "startOpeningSummary"
    - from: frontend/src/hooks/useQaConversation.js
      to: /api/qa/opening-summary-eligibility
      via: "authenticated cache-only probe before submitting an opening summary"
      pattern: "openingSummaryEligibility"
    - from: backend/modules/qaRoutes.js
      to: backend/modules/qaMedia.js
      via: "same cache-only eligibility check at probe and request execution"
      pattern: "cacheOnly"
    - from: backend/modules/qaGeneration.js
      to: backend/modules/qaContext.js
      via: "unchanged createQaContext call after cache-only media preparation"
      pattern: "createQaContext"
---

<objective>
Show a current-scene summary as the first AI message when a user opens AI conversation on a video whose Q&A visual cache already has a valid window at that exact player timestamp, without making cold videos wait.

Purpose: The common first question ("현재 어떤 장면이 나오고 있어?") becomes an immediately useful, grounded opening message only when doing so cannot trigger the slow cache-miss path.
Output: A cache-only backend contract and an accessible modal opening flow that uses the established Q&A generation path rather than timed screen-description rows.
</objective>

<execution_context>
@/Users/chacha/.codex/get-shit-done/workflows/execute-plan.md
@/Users/chacha/.codex/get-shit-done/templates/summary.md
</execution_context>

<context>
@AGENTS.md
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md
@.planning/STATE.md
@.planning/features/ai-conversation/DESIGN.md
@.planning/features/ai-conversation/PLAN.md
@backend/modules/qaMedia.js
@backend/modules/qaContext.js
@backend/modules/qaGeneration.js
@backend/modules/qaRequestStore.js
@backend/modules/qaRoutes.js
@frontend/src/hooks/useQaConversation.js
@frontend/src/screens/PlayerScreenV2.js

<interfaces>
From `backend/modules/qaMedia.js`:
```js
async prepare(videoId, timestampMs, durationMs, { signal, warm = true, referenceId } = {})
// Produces { fromCache, frames, subtitles }; its ordinary path may start VTT,
// window extraction, download, and warming work.
```

From `backend/modules/qaContext.js`:
```js
async createQaContext({ request, media, video })
// Builds the trusted Q&A prompt data and image parts, marks currentFrameId as
// the closest cached frame at or before request.timestamp.
```

From `backend/modules/qaGeneration.js`:
```js
createQaGeneration({ store, media, model, speech, getVideo, recordUsage })
// Runs one validated JSONL Q&A request and streams accepted sentences/TTS.
```

From `frontend/src/hooks/useQaConversation.js`:
```js
useQaConversation(...) // currently exposes { enabled, turns, busy, ask, cancel, replay, resume }
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add a side-effect-free current-timestamp Q&amp;A cache gate</name>
  <files>backend/modules/qaMedia.js, backend/tests/qaMedia.test.js</files>
  <behavior>
    - A verified cached frame set satisfying the existing around-timestamp window rule can be returned for a supplied video ID, duration, and timestamp without calling `adapter.section`, `adapter.full`, `windowExtract`, `ensureSubtitles`, or `ensureFullCache`.
    - A video with no `frames-v1` assets, an insufficient/invalid cached window, an out-of-range timestamp, or corrupted assets reports a typed opening-summary cache miss and creates no download, FFmpeg, subtitle, or warming work.
    - Cached subtitle data is included when already durable and valid; a missing/unknown subtitle asset is represented by the existing empty/unknown subtitle shape and must not initiate a subtitle fetch.
    - The returned frame list remains limited to the established ±4-second Q&amp;A evidence window and includes a closest frame at or before T, so `createQaContext` continues to identify the real question/current frame.
  </behavior>
  <action>
Implement a `cacheOnly` media preparation/eligibility path in `backend/modules/qaMedia.js` (or a narrowly named exported service method used by it). It must query and checksum-validate only existing `frames-v1` assets through the cache manager, apply the same `current(..., around: true)`/window-sufficiency rules as ordinary Q&amp;A, and read subtitles with the existing subtitle reader only. Do not infer eligibility from video creation date, script rows, a legacy frame directory, a cache-job row alone, or a prior request receipt: the authoritative condition is usable, verified Q&amp;A visual evidence at the captured timestamp. This covers both post-feature generated videos and older videos previously warmed by Q&amp;A while safely declining partial caches at another point in the video.

For a miss, throw one stable `QA_OPENING_SUMMARY_CACHE_MISS` code before any method that can create a lease, schedule extraction, download media, fetch VTT, or warm the full cache. Preserve the normal `prepare()` behavior byte-for-byte for ordinary questions. Add deterministic temp-SQLite/media tests before implementation for cache hit, no-cache, insufficient current window, cached/no-cached subtitles, and the assertion that all adapter/extraction spies remain uncalled on this path.
  </action>
  <verify>
    <automated>cd backend &amp;&amp; node --test tests/qaMedia.test.js</automated>
  </verify>
  <done>A cache-only call can supply the existing Q&amp;A context builder with valid timestamped frames immediately, while every cache-miss case exits with `QA_OPENING_SUMMARY_CACHE_MISS` and demonstrably starts no media work.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Route and generate the opening summary through the existing Q&amp;A policy path</name>
  <files>backend/modules/qaRequestStore.js, backend/modules/qaGeneration.js, backend/modules/qaRoutes.js, backend/tests/qaIncremental.test.js, backend/tests/qaRoutes.test.js</files>
  <behavior>
    - An authenticated eligibility request validates `videoId` and the finite non-negative player timestamp, returns available only for the cache-only evidence gate, and never starts model/media work.
    - An opening-summary request has an explicit immutable request kind and server-owned summary instruction; it cannot be used to smuggle a different user question or a nonempty synthetic history.
    - Its generation invokes the same `createQaContext`, `PROMPT`, JSONL parser, `validateSentence`, conservative language policy, provider limiter, and TTS/event delivery used by an ordinary incremental Q&amp;A request.
    - The trusted mode suffix asks for one or two short Korean honorific sentences describing only the screen at the captured timestamp/current frame, forbids search and unsupported dialogue/translation/inferences, and does not replace or weaken any existing prompt safety rule.
    - A cache miss rechecked at request execution produces the typed miss without model, TTS, or cache work; ordinary question request validation and generation remain compatible.
  </behavior>
  <action>
Extend the incremental Q&amp;A request contract with a tightly validated `opening-summary` kind while retaining the existing question contract unchanged. Use a server-defined internal question/task marker for the context data, reject client-supplied content/history that would make the synthetic first message look like a real user question, and retain the kind on the request/turn event data so the client can render it as an AI-only opening turn. Do not persist it to canonical screen-description tables or reuse a timed script event.

Add an authenticated `/api/qa` eligibility route and wire its dependencies from `backend/routes.js` only as needed to use the existing Q&amp;A media/video accessors. The route must use the cache-only gate from Task 1, return a plain available/unavailable result for expected misses, and treat malformed/unauthorized requests as normal API errors. Recheck the gate when `createQaGeneration` receives an opening-summary request (`cacheOnly: true`, no warming) to close the probe-to-submit race. Build the model input from the unchanged context builder and base `PROMPT`, appending only a trusted, mode-specific task instruction outside untrusted data. Do not issue Google search in this mode; all output still passes the existing sentence policy and synthesis flow.

Add backend tests first: eligibility's ownership/input checks and zero-work miss; cache race rejection with no model/TTS call; cache-hit context using the closest at-or-before frame; one/two-sentence task instruction retaining the existing grounding/no-dialogue rules; and ordinary Q&amp;A request compatibility/idempotency. Keep tests isolated with temp SQLite/fake media and never call Gemini, TTS, yt-dlp, or FFmpeg.
  </action>
  <verify>
    <automated>cd backend &amp;&amp; node --test tests/qaMedia.test.js tests/qaIncremental.test.js tests/qaRoutes.test.js</automated>
  </verify>
  <done>The only automatic summary generation path is authenticated, cache-gated twice, grounded in current timestamp frames through the existing Q&amp;A policy stack, and cannot turn a cache miss into a slow background operation.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Open the modal immediately and render a cache-hit summary as its first AI turn</name>
  <files>frontend/src/services/qaClient.js, frontend/src/hooks/useQaConversation.js, frontend/src/hooks/useQaConversation.test.js, frontend/src/screens/PlayerScreenV2.js, frontend/src/screens/PlayerScreenV2.test.js</files>
  <behavior>
    - Clicking AI conversation still pauses/restores playback, opens and focuses the modal immediately, and captures the player timestamp synchronously before any asynchronous cache probe.
    - With incremental Q&amp;A enabled, an empty conversation, and an available cache response, the hook submits exactly one opening-summary request at that captured timestamp and displays its streamed answer as an AI-only first turn.
    - The summary request is cancelled/ignored on modal close, unmount, video change, or a stale async probe; a `QA_OPENING_SUMMARY_CACHE_MISS` race removes/no-ops the synthetic turn without an error announcement.
    - When the cache probe says unavailable, incremental Q&amp;A is disabled, or the conversation already contains turns, no automatic request is made and the existing empty chat, prompt, input, question submission, legacy fallback, playback, and focus behavior stay unchanged.
    - Keyboard users can reach the close button/input in the existing focus trap; screen readers encounter the summary as the first AI response without an extra fake user-question bubble or normal-progress announcement.
  </behavior>
  <action>
Add the eligibility client method and refactor `useQaConversation` around a shared request starter so normal `ask()` retains its payload, history, cancellation, audio, and error behavior. Expose a purpose-specific `startOpeningSummary({ timestamp })` method that probes first, sends the explicit backend request kind only on `available`, and records a first turn with an `openingSummary`/role marker. Keep the actual generated summary in the same turn history so later user questions receive it as conversational history, but do not render a synthetic user utterance. Suppress only the automatic summary's waiting speech/progress behavior; do not change the no-cache user-asks-first flow.

In `PlayerScreenV2`, invoke that method only after the modal has been made visible and only for a fresh incremental conversation. Capture `player.getCurrentTime()` once inside `handleOpenQaModal`; do not use a later state update or a timed screen-description line. Render the marked turn as the first AI bubble and preserve the current timestamp label, input focus, Escape/Tab behavior, cancel button semantics, close restoration, and ordinary/legacy question UI. Add focused React tests with mocked client/audio/player for cache hit, unavailable cache, close-before-probe, cache-race miss, pre-existing-turn reopen, exact timestamp capture, and AI-only bubble/focus behavior. Add an accessibility assertion for dialog naming and absence of a synthetic user bubble.
  </action>
  <verify>
    <automated>cd frontend &amp;&amp; CI=true npm test -- --watchAll=false src/hooks/useQaConversation.test.js src/screens/PlayerScreenV2.test.js &amp;&amp; npm run build</automated>
  </verify>
  <done>The modal is never held behind cold-cache work; eligible openings show a grounded first AI summary and accept follow-up questions, while ineligible openings are observably identical to the prior user-asks-first experience.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Browser → `/api/qa` | Client controls video ID, timestamp, request IDs, and whether it attempts the summary mode. |
| Cached asset store → model | Locally stored images/VTT and historic Q&amp;A data are evidence, not instructions. |
| Model → chat/TTS | Generated text can be inaccurate, duplicate dialogue, or contain unsafe inference unless the existing policy path remains in force. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|----------|----------|-----------|-------------|-----------------|
| T-quick-01 | S/E | opening-summary API | mitigate | Keep `requireAuth`, session/request ownership, strict video/timestamp validation, and server-owned summary task text. |
| T-quick-02 | T | cache-only eligibility | mitigate | Recheck verified cache evidence at generation time; never trust client cache claims, video age, or a bare DB job state. |
| T-quick-03 | I | cache/media logs | mitigate | Return only availability/code; do not log questions, frame bytes, paths, tickets, URLs, or provider data. |
| T-quick-04 | D | cold-cache modal opening | mitigate | Cache-only probe performs no lease/download/FFmpeg/VTT/warming work and expected misses resolve to the old UI flow. |
| T-quick-05 | T | model evidence/output | mitigate | Reuse `createQaContext`, existing conservative `PROMPT`, sentence parser/validator, language rules, and TTS selection; the trusted summary suffix disallows search and unsupported inference. |
| T-quick-06 | R | automatic request lifecycle | mitigate | Keep immutable request IDs/events, mark synthetic turns explicitly, and abort/ignore stale close/unmount/video-change callbacks. |
</threat_model>

<verification>
Run the isolated backend Node tests and focused frontend tests/build named above. Then manually verify with a browser and a screen reader/keyboard:

1. Open a known warmed video at several timestamps; the modal appears immediately, the first visible/chat message is an AI summary grounded in the paused scene, and the input remains usable after it finishes.
2. Open a known cold video; no network-triggered media preparation occurs from opening alone, no loading/failure pseudo-answer appears, and the existing empty conversation and first-question behavior remain.
3. Close during the cache probe and during generation; confirm no late text/audio appears, Escape restores trigger focus, and playback/volume restoration is unchanged.
4. Reopen after an existing Q&amp;A turn; confirm no duplicate opening summary is added and follow-up context remains intact.
</verification>

<success_criteria>
- The automatic first message is newly generated from current cached frame evidence, not a lookup of timed description events.
- Cache absence, incomplete/corrupt current windows, and cache races never make modal opening wait or create media/cache work.
- Existing Q&amp;A context/prompt/policy and audio/event pipeline are reused without weakening the Korean dialogue, translation, provenance, or grounding rules.
- A deterministic test suite proves cache/no-cache, timestamp, cancellation/race, ordinary-flow regression, and accessible first-turn rendering behavior.
</success_criteria>

<output>
After completion, create `.planning/quick/260916-mvw-ai-q-a-ai/SUMMARY.md`, update the `Quick Tasks Completed` table in `.planning/STATE.md`, and commit only this quick task's implementation, tests, plan artifacts, and state update.
</output>
