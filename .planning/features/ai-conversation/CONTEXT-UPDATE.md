# Q&A context correction — 2026-09-14

The user explicitly requires video title, entire generated screen-description script, complete question history, and frames around the question timestamp. This instruction supersedes the older PLAN/DESIGN restriction that only pre-question frames enter the model. Original planning files are preserved.

## Corrected behavior

- `qaGeneration` supplies the actual database video record to `qaContext`.
- `videoTitle`, `screenDescriptionScript`, `history` and timestamped images reach the same model request. No outline sampling, script slicing, history summarization or text normalization occurs.
- Frame range is T ± 4 seconds, clipped to video duration. At most eight images retain range endpoints and the closest image. Window extraction spans bucket boundaries, with a new fenced `window-v2` lane; existing JPEG/cache versions remain usable.
- Eligible screen-description entries receive `script-N` references matching original array indices. Rejected entries and translated dialogue cannot serve as description evidence. Full original records remain in context with their status/type.
- `context` sentences may cite script/title evidence and supporting frames. Frame-only visual claims still require actual image IDs. Grounded explanations no longer collapse into the fixed unknown templates. Relationship terms explicitly present in cited descriptions are usable; an unrelated frame ID does not justify them.
- Prompt directs the model to answer the question first, connect relevant context, distinguish existing generated description from actual frames, avoid invented connecting actions/facts, and avoid volunteering unrequested later plot details. Historical AI replies are not promoted to factual evidence.
- JSON/JSONL code fences are tolerated only as an outer wrapper; record sequence, schema and sentence policy remain enforced. The SDK's parallel aggregate-response rejection is observed immediately so a parse/stream failure cannot become an unhandled process rejection.
- Evidence logs expose title presence, script count, history count and selected frame timestamps without logging private conversation text.

## Verification

Deterministic tests cover complete original script/history transfer (including future entries and 50 history turns), ±4-second filtering, warm/cold bucket edges, evidence typing, rejected/translated script exclusion, supported relationship terms, actual generation-to-TTS flow, code-fenced JSON and simultaneous SDK stream failure.

A bounded live probe used `KFjlKrrZpqc` at 33 seconds with all 60 description entries, title and eight surrounding frames. Question: “노트북을 쓰는 사람은 앞에서 무엇을 하다가 지금 이 행동을 하는 거야?”

Four model invocations were made while diagnosing format handling; no real TTS calls. Three failed attempts remain recorded with unconfirmed usage. The diagnostic third attempt exposed a leading ` ```json ` wrapper. After parser correction, the fourth returned two contextual sentences in 1,819 ms, linking the earlier conversation to subsequent laptop use. Actual usage was 17,362 tokens, including 8,800 image tokens; full context increases input cost compared with the previous incomplete prompt. This is not a percentile or playback latency claim.

The answer also added “노트북을 켜고”, which the cited description did not establish. Thus context transport and the contextual-answer path are verified, but this sample does not establish complete factuality. Existing generated scripts may themselves contain inference; representative semantic/factuality evaluation remains necessary. Raw successful and failed results: [kf-context-20260914.json](results/kf-context-20260914.json).

Restart the local backend to load the corrected prompt/context/parser. No push, deployment, user-cache deletion or environment modification accompanies this change.
