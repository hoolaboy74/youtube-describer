# 04 — Incremental request, validation and speech API

**Current contract (2026-09-14, latest user instruction):** Search selection belongs to the model. Q&A answer postprocessing validates transport format only. See [MODEL-OUTPUT-CONTRACT.md](MODEL-OUTPUT-CONTRACT.md); it supersedes the historical sentence-policy/search-routing descriptions below.

Implemented behind `QA_INCREMENTAL_SPEECH_ENABLED=true`; default remains the legacy route.

- Authenticated request acceptance, owner/session isolation, body-fingerprint idempotency, monotonic SSE replay, cancellation, presence, and authenticated MP3 ticket renewal.
- Opaque 60-second media capabilities, terminal retention for ten minutes, no regeneration on event reconnect. API tracking masks new audio capabilities. Reverse-proxy access logs require the same masking before rollout.
- Full question/answer/time/status history is retained verbatim. Oversized input is rejected, never silently truncated. The prompt also includes the video title and entire generated screen-description script without sampling or shortening. Per the 2026-09-14 user correction, nearby image evidence covers T ± 4 seconds (up to eight frames), and full-script contextual answers can cite eligible script entries or the title. Rejected and translation script entries remain visible as original context but cannot be promoted to description evidence. See [context correction](CONTEXT-UPDATE.md).
- UTF-8-safe closed JSONL sentence records pass a separate immutable Q&A policy gate before events or TTS. Canonical script tables/tags remain unchanged. The gate checks sentence form, evidence type/time, confirmed foreign translation, inference patterns and lexical near-duplicates of audible Korean/accepted answers. This does not prove visual factuality or all semantic paraphrases.
- Initial OGG failure before any bytes now falls back to sentence MP3. After any bytes, failure never triggers automatic rereading. Explicit replay can synthesize cached validated OGG sentences as deduplicated MP3.
- First accepted sentence enters a bounded TTS queue while the model continues. Both per-sentence MP3 and continuous Chirp OGG server paths exist. Model/TTS limits are two each, first sentence deadline 45 s, idle 20 s, total 120 s, unary synthesis 15 s, stream buffer 1 MiB. MP3 retention is capped at 2 MiB/request and 64 MiB/store.
- Final provider usage uses the existing QA ledger once per request execution. Minimal SQLite request receipts fence replay after restart and atomically deduplicate ledger writes. Missing/canceled usage stays `unconfirmed` durably; conversation text is not stored in the receipt. No invented zero charge is recorded.
- Periodic maintenance expires request assets and fences orphan-job directory removal; runtime frame/VTT corruption can be repaired without a restart. Full backfill receives the current-question priority.

Verification: isolated backend suite **124/124 passed**. Tests cover HTTP auth/replay, duplicate acceptance, cross-user audio issuance, expiry, complete history/backward seek, UTF-8 fragmentation, rejected candidates, first sentence before delayed second sentence, cancellation of late unary audio, and continuous first-byte-before-end with a controlled provider.

Explicit internet-search requests now use one separate search-enabled call instead of the core scene call. Only completed provider grounding segments with actual search queries and HTTPS sources become attributed external explanations; unsupported claims are omitted. Full history remains intact. Source links and sandboxed provider search suggestions appear with the answer. Complete final JSON sentence records are accepted at EOF even without a trailing newline; incomplete records remain unpublished.

The grounding parser follows the [official grounding metadata contract](https://ai.google.dev/api/generate-content#GroundingMetadata), including UTF-8 byte offsets. Search accounting counts unique nonempty queries as documented in [Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search). Deterministic tests cover routing, provenance, attribution, full history, one-call execution and accounting; actual search-provider and search-widget accessibility verification remain outstanding.

Open release checks: live factuality/semantic-duplicate evaluation, full latency matrix, mobile playback, live external-search grounding, provider reconciliation of unavailable usage. These limitations mean this is an opt-in implementation checkpoint, not a declaration that all DESIGN acceptance criteria passed.


## Search routing and postprocessing correction (2026-09-14)

The prior router required 인터넷/웹/구글 as well as a search verb. Thus “유튜버의 약력에 대해 검색해 주세요” incorrectly entered the ordinary scene/context model, which could return the screen-unknown template. Bare search requests and explicit biography lookup requests now select the search model; negative search requests and search-box/search-term questions do not. Route selection is logged without question text.

Sentence policy `qa-sentence-v3` exempts exact source-grounded external claims from the visual-inference word blacklist. Previously, even source-backed statements containing 아버지/부부/때문에 could be rejected. External text still must exactly match the supported provider claim (plus the attribution prefix) and have sources; invented additions and conversion into visual evidence remain rejected. Search prompts explicitly permit named public-person biography lookup without identifying faces.

Current postprocessing remains: completed JSON/JSONL parsing (optional outer code fence), trim, schema/sequence validation, 240-character Korean polite-sentence limit, control/markup/URL rejection, evidence type and frame-window checks, confirmed foreign-translation checks, and lexical duplicate suppression. Search additionally requires actual web queries and supported HTTPS grounding, allows up to three supported claims of at most 200 characters each, and adds “외부 자료에 따르면”. Accepted sentence text is shared by UI and TTS; there is no separate summarizing model. Rejected sentences are omitted. No accepted search claim yields the external-source-unavailable template, not the screen-unknown template. Evidence IDs and lexical rules do not establish semantic factuality.

Verification: deterministic generation tests prove the user's bare search wording invokes only the search model, supported biographical terms survive validation, invented additions remain blocked, and absent search evidence yields the correct external-search fallback. No live biography search was performed for this correction.


## Evidence-link and current-frame correction (2026-09-14)

For `KGXW6nSyYDA` at 23.479 seconds, the user log showed eight prepared frames and 98 script entries but two `evidence` rejections. Original supplied IDs were not logged, so their exact spelling cannot be recovered. Frame references now use request-local ordinals (`frame-0`…`frame-7`) with a complete `frameEvidence` catalog and `allowedEvidenceIds`. Original source PTS remain metadata and cache keys; unknown IDs are never silently mapped to a guessed frame. Logs include sanitized supplied IDs on rejection.

The request also identifies `currentFrameId`: the closest frame at or before the question time. The actual 23.223-second comments graphic is thus primary for “현재 화면”, while nearby presenter shots remain temporal context. Visual/screen-text sentences require at least one actual frame, but can cite eligible description-script entries as additional support (`qa-sentence-v4`). Script-only or external-as-visual claims remain rejected.

If every generated candidate is rejected, the server emits `QA_ANSWER_VALIDATION_FAILED` and synthesizes no replacement unknown sentence. An empty model response is likewise an explicit error. The frontend announces the validation failure once without misrepresenting it as absent video evidence. Genuine no-context or explicitly generated unknown answers remain possible.

Verification: 124 backend tests; 19 focused frontend tests; production build passes. After the final current-frame prompt change, affected backend suites were rerun successfully. Three bounded real-model probes used the original video/title/script and the same eight checksum-verified cached images; no cache deletion, downloads, production ledger writes or real TTS calls. The final probe returned a description of the comments graphic referencing `frame-4`. Earlier mixed-evidence and wrong-shot results remain in [raw probe results](results/kgx-evidence-20260914.json); this is not a blanket factuality claim.
