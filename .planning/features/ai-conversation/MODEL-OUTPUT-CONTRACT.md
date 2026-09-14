# Model-owned search and format-only Q&A output — 2026-09-14

The latest explicit user instructions supersede the earlier Q&A response-content gates and backend search classifier. This applies to the opt-in incremental conversation route; canonical video-description persistence/player policy is unchanged.

## Search

Every incremental request uses the same streaming model with Google Search available. There is no keyword classifier, LLM classification preflight, or separate search-answer model. The model receives the title, complete description script, complete conversation, timestamp and nearby images, and decides whether to search. The prompt directs it to actually use the tool when the user explicitly asks to search and avoid unnecessary searches for visual questions.

Provider search queries, source links and suggestions are collected only for display and accounting. They do not select which sentences can be heard. Final or streaming metadata is preserved even when SDK aggregation ends with empty grounding. No missing or fragmented grounding support can replace an answer with “외부 자료를 확인하지 못했습니다”. Returned metadata reports actual tool use; an enabled tool is not proof that it ran.

## Output

Model records use `{"seq":0,"text":"answer"}` JSONL. `kind` and `evidenceIds` are no longer required. The decoder handles UTF-8 chunk boundaries and an optional outer JSON code fence. It validates JSON structure, monotonic integer sequence, nonempty string text, and invalid control characters. Resource bounds remain: 16 KiB decoder buffer, 8 KiB per text record, 64 records, existing model/TTS timeouts, audio retention and queue limits. Invalid formatting is an explicit error, not a fabricated answer.

Text is kept as returned in each record. No content removal based on evidence IDs, scene timing, language, Korean endings, relationships, speculative words, grounding segments, semantic/lexical repetition or dialogue matching. No 200/240-character semantic gate, fixed three-claim search limit, attribution prefix, fallback content replacement or separate summarizing model. UI text and TTS receive the same record text. General accuracy/language guidance stays in the prompt as requested behavior, not backend answer filtering.

Source links are HTTPS-validated and the optional search widget is size-bounded and sandboxed; these presentation checks do not affect answer text. Frontend errors now distinguish unreadable answer format from empty/failed model responses. Sources delivered at generation completion do not truncate already received text.

## Verification

Backend regression suite: **118 passed**. Focused frontend suite: **20 passed**. Production frontend build: **passed**. Previous tests enforcing superseded content rejection were replaced with format-only and unchanged-output assertions.

Regression tests cover unchanged noun phrases, English text, relationship/causal terms, repeated text, missing evidence IDs, long text, control/size bounds, partial JSON, optional code fences, cancellation, first-sentence TTS before model completion, full context retention, one model call regardless of wording, source metadata independent from answer acceptance, and stream grounding retained for billing.

Two bounded real-model calls used RUY931euKn4, 92 complete description entries, eight checksum-verified local frames and “이찬원의 학력에 대해 검색해”. Both answered successfully without content deletion. Neither reported web search queries or sources, including after stronger explicit-search prompt guidance. Thus actual search execution and the returned education facts are **not verified** by these samples. The caller supplied empty history because the original three private turns were unavailable. No real TTS, cache deletion, downloads or production-ledger writes. [Raw results](results/model-search-format-20260914.json).

Restart the backend and reload the frontend. No push or environment changes accompany this implementation.
