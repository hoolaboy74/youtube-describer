# NKG_BmAPEdI live test/production comparison — 2026-10-01

Both runs completed; video duration 645 seconds; downloaded file size exactly 55,616,914 bytes. Read-only SSH log/SQLite inspection; no source/deployment/cache changes.

| Stage | Production | Test |
|---|---|---|
| Start | 17:26:18 | 17:24:23 |
| Download completed | 17:27:08 | 17:24:58 |
| Frames extracted | 17:27:49 | 17:25:20 |
| AI stage started | 17:27:49 | 17:25:21 |
| Completed | 17:28:21 | 17:25:52 |
| Download -> AI start (second-resolution log) | ~41s | ~23s |
| AI timer | 32.613s | 31.057s |
| Total timer | 122.849s | 88.299s |
| Frames | 445 | 500 |
| Keys / non-key samples | 181 / 264 | 181 / 319 |
| Largest adjacent frame gap | 2,069ms | 2,002ms |

Test extractor: strategy=single-pass, predictedBackfills=264, fallback=none, extractionMs=22553. This timer includes awaited QA publication; it is not FFmpeg-only time. Post-download delay includes parallel audio classification and downstream preparation. Download time differs, so the total reduction is not attributed entirely to extraction.

Test selected the intended one-pass full decode, replacing production's key pass + 264 individual seek processes. Its 319 non-key samples are selected during that one process, not 319 new FFmpeg processes.

Both QA frames-v1 jobs ready, no lastError. All 500 test and 445 production cached JPEGs exist and match stored SHA256 checksums. All frames have unique source PTS and timestamps in video range. Both runs retain exactly the same 181 key timestamps and image hashes. Test starts at 0ms and ends at 644010ms (990ms tail gap).

Separate input difference: test saved VTT has 128 cues without inline timing/class tags; production VTT has 457 cues with 518 inline timing/class tags and results in 425 parsed dialogue entries. Subtitle files have different SHA256 checksums. This is not evidence of frame loss. Parser/selection source comparison was checked independently; cookie files differ between downloads. The precise upstream reason for selecting/downloading different VTT content was not established.

Log sources: /app/test-youtube-describer/backend/logs/2026-10-01.log (request NKG_BmAP, lines 171785 onward); /app/youtube-describer/backend/logs/2026-10-01.log (lines 112 onward). SQLite: each backend/db/cache.db, videos + qa_cache_jobs + qa_frame_assets + qa_subtitle_assets.
