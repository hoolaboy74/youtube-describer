# Project Guide

This is the `test` worktree for 뷰래이터, an accessible Korean YouTube screen-description service.

## Working Context

- All source changes for this milestone belong on the `test` branch in `/Users/chacha/src/youtube-describer-test`.
- Preserve the existing React/Express/SQLite architecture and the legacy timed-script/player compatibility contract unless a plan explicitly changes it.
- The core value is accurate, natural Korean audio description without repeating the original soundtrack.

## Non-Negotiable Description Policy

- Treat `backend/prompt_template_codex_v2.txt` as the common safety and language-policy baseline for every genre prompt.
- Describe only evidence supported by frames and reliable timed context; do not invent identity, relationship, emotion, intent, cause, or location.
- Do not generate or synthesize Korean original dialogue or subtitles that duplicate audible speech.
- Translate only confirmed foreign speech when needed; mixed audio translates only confirmed foreign segments; unknown audio does not trigger translation.
- Preserve `[v1]`, `[v2]`, `[v3]`, `[txt]`, `[trans]` tags, in-range timestamps, short Korean honorific sentences, and duplicate suppression.
- Enforce these rules in the prompt, canonical parser/validator, persisted data, and player/TTS selection—not only in the model prompt.

## Milestone Direction

- Classify every video into news/documentary, lecture, variety, film/drama, sport/game, or a conservative fallback.
- Process every video through approximately 15-minute chunks with global memory, bounded parallel drafts, continuity state, and ordered merge.
- Use durable, restartable jobs and expose truthful progress and validated partial playback.
- Keep resource concurrency bounded for Gemini, FFmpeg/Whisper, downloads, TTS, memory, disk, and API cost.

## Planning and Verification

- Read `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, and the relevant phase plan before implementation.
- Keep commits focused and do not modify unrelated worktree changes.
- Add deterministic tests for language policy, provenance, duplicate suppression, timestamp/overlap validation, chunk boundaries, idempotency, and restart/recovery behavior.
- Verify keyboard and screen-reader behavior for user-facing changes.
