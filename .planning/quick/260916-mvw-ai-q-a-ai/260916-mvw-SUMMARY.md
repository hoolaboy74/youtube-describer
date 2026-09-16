---
phase: quick-260916-mvw-ai-q-a-ai
plan: 260916-mvw
status: complete
subsystem: qa-api-and-player
tags: [express, react, qa, cache, accessibility]
requires:
  - phase: ai-conversation
    provides: incremental Q&A media, policy, and event pipeline
provides:
  - cache-only current-scene opening summaries
  - immutable opening-summary requests and AI-only chat turns
affects: [qa-media, qa-generation, player]
tech-stack:
  added: []
  patterns: [cache-only eligibility rechecked before generation]
key-files:
  created: []
  modified: [backend/modules/qaMedia.js, backend/modules/qaGeneration.js, backend/modules/qaRequestStore.js, backend/modules/qaRoutes.js, frontend/src/hooks/useQaConversation.js, frontend/src/screens/PlayerScreenV2.js]
key-decisions:
  - "A usable verified frame window, rather than video age or request history, is the sole opening-summary eligibility signal."
  - "Opening summaries are server-owned request kind data and render without a synthetic user message."
requirements-completed: [QA-04, QA-05, QA-08, QA-09]
duration: 30min
completed: 2026-09-16
---

# Quick Task 260916-mvw: Current-scene opening summary

**Verified cached frame evidence now produces an AI-only current-scene summary when the Q&A modal opens, while cold videos retain the existing user-asks-first behavior.**

## Accomplishments

- Added a side-effect-free `prepareCacheOnly` Q&A media path that checksum-validates the current frame window and returns a stable cache-miss code without downloading, extracting, warming, or fetching captions.
- Added an authenticated cache eligibility endpoint and immutable `opening-summary` request kind, rechecked at generation time and routed through the existing context, prompt, sentence validation, and TTS pipeline.
- Limited opening summaries to two accepted sentences before event/TTS delivery, while retaining ordinary Q&A's 64-sentence limit.
- Captured the player timestamp before asynchronous work, probed after immediately opening the modal, and rendered the result as an AI-only first chat turn.

## Task Commits

1. **Task 1: cache-only media gate** - `9c1c5af`
2. **Task 2: guarded route and generation** - `d901269`
3. **Task 3: modal opening summary UI** - `8bc6af6`

## Verification

- `cd backend && node --test tests/qaMedia.test.js` — 23 passed.
- `cd frontend && CI=true npm test -- --watchAll=false src/hooks/useQaConversation.test.js` — 6 passed.
- `cd frontend && npm run build` — passed (existing exhaustive-deps and Browserslist warnings remain).
- `cd backend && node --test --test-name-pattern='opening' tests/qaIncremental.test.js tests/qaRoutes.test.js` — 4 passed (immutable request contract, cache-race no model/TTS, authenticated eligibility miss, two-sentence limit, and ordinary Q&A compatibility).
- `node --check` passed for all changed backend modules.

## Deviations from Plan

- The planned `PlayerScreenV2.test.js` does not exist in this repository; focused hook coverage verifies cache hit submission and AI-only turn metadata instead.
- The combined backend incremental/routes test command did not complete within the local 30-second command window after existing tests had begun; the isolated media suite and syntax checks completed successfully.

## Next Phase Readiness

Manual browser and screen-reader verification remains appropriate before release, especially close-during-probe and close-during-generation behavior.

## Self-Check: PASSED

- Task commits `9c1c5af`, `d901269`, and `8bc6af6` are present.
- All source files listed above exist and are committed.
