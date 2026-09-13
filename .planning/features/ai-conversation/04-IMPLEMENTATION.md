# 04 — Incremental request, validation and speech API

Implemented behind `QA_INCREMENTAL_SPEECH_ENABLED=true`; default remains the legacy route.

- Authenticated request acceptance, owner/session isolation, body-fingerprint idempotency, monotonic SSE replay, cancellation, presence, and authenticated MP3 ticket renewal.
- Opaque 60-second media capabilities, terminal retention for ten minutes, no regeneration on event reconnect. API tracking masks new audio capabilities. Reverse-proxy access logs require the same masking before rollout.
- Full question/answer/time/status history is retained verbatim. Oversized input is rejected, never silently truncated. Only frames at/before T and cues ending at/before T enter new video evidence.
- UTF-8-safe closed JSONL sentence records pass a separate immutable Q&A policy gate before events or TTS. Canonical script tables/tags remain unchanged. The gate checks sentence form, evidence type/time, confirmed foreign translation, inference patterns and lexical near-duplicates of audible Korean/accepted answers. This does not prove visual factuality or all semantic paraphrases.
- Initial OGG failure before any bytes now falls back to sentence MP3. After any bytes, failure never triggers automatic rereading. Explicit replay can synthesize cached validated OGG sentences as deduplicated MP3.
- First accepted sentence enters a bounded TTS queue while the model continues. Both per-sentence MP3 and continuous Chirp OGG server paths exist. Model/TTS limits are two each, first sentence deadline 45 s, idle 20 s, total 120 s, unary synthesis 15 s, stream buffer 1 MiB. MP3 retention is capped at 2 MiB/request and 64 MiB/store.
- Final provider usage uses the existing QA ledger once per request execution. Minimal SQLite request receipts fence replay after restart and atomically deduplicate ledger writes. Missing/canceled usage stays `unconfirmed` durably; conversation text is not stored in the receipt. No invented zero charge is recorded.
- Periodic maintenance expires request assets and fences orphan-job directory removal; runtime frame/VTT corruption can be repaired without a restart. Full backfill receives the current-question priority.

Verification: isolated backend suite **95/95 passed**. Tests cover HTTP auth/replay, duplicate acceptance, cross-user audio issuance, expiry, complete history/backward seek, UTF-8 fragmentation, rejected candidates, first sentence before delayed second sentence, cancellation of late unary audio, and continuous first-byte-before-end with a controlled provider.

Open release checks: live factuality/semantic-duplicate evaluation, full latency matrix, mobile playback, explicit-search grounding, provider reconciliation of unavailable usage, and the reverse-order main-generator/Q&A download race described in 03. External search is currently disabled; external facts are not fabricated. These limitations mean this is an opt-in implementation checkpoint, not a declaration that all DESIGN acceptance criteria passed.
