---
phase: quick-261125-pkd-remove-qa-frame-assets-table-and-hash
plan: 261125-pkd
status: complete
subsystem: qa-cache
tags: [sqlite, qa-cache, startup-performance, filesystem]
provides:
  - automatic DROP TABLE qa_frame_assets and DROP INDEX qa_frame_window migration
  - zero-hash filesystem-backed Q&A frame lookup supporting both <timestampMs>.jpg and legacy <pts>-<sha256>.jpg
  - sub-second backend startup reconciliation without full-cache SHA256 hashing
affects: [qaCacheStore, qaCacheManager, qaMedia, database, clear-cache]
tech-stack:
  added: []
  patterns: [directory-backed timestampMs frame lookup with 2-byte JPEG header check]
key-files:
  created: []
  modified:
    - backend/modules/qaCacheStore.js
    - backend/modules/qaCacheManager.js
    - backend/modules/qaMedia.js
    - backend/database.js
    - backend/clear-cache.js
    - backend/tests/qaCacheManager.test.js
key-decisions:
  - "Store new Q&A frames as <timestampMs>.jpg after sharp verification and atomic rename; retain read compatibility for existing <sourcePtsMs>-<64hex>.jpg files on disk."
  - "Replace all frame and raw-source SHA256 checks with 2-byte JPEG magic-header / stat.size checks and remove full assets/ tree scan from startup reconcile()."
  - "Delete assets/<videoId> directory on database.deleteVideo(videoId) since frame metadata no longer resides in SQLite."
completed: 2026-11-25
---

# Quick Task 261125-pkd: Remove `qa_frame_assets` Table & Frame Hash Verification

**Dropped the 290k-row `qa_frame_assets` SQLite table and eliminated all per-frame SHA256 hashing, reducing backend restart downtime from ~6-7 minutes to under 1 second while preserving read compatibility with existing cached frames.**

## Accomplishments

- Updated `backend/modules/qaCacheStore.js` so `migrateQaCache(db)` drops `qa_frame_window` and `qa_frame_assets` automatically and removes DB-backed frame queries.
- Rewrote frame storage/lookup in `backend/modules/qaCacheManager.js` to list `assets/<videoId>/frames/<cacheVersion>/` directly, parse both `<timestampMs>.jpg` and legacy `<pts>-<sha256>.jpg`, validate JPEGs with a fast 2-byte `0xFF 0xD8` header check, remove full-cache file hashing and `assets/` tree walking from `reconcile()`, and add `deleteVideoAssets(videoId)`.
- Updated `backend/modules/qaMedia.js` to replace frame/source SHA256 verification with JPEG magic-header and byte-size checks.
- Removed `qa_frame_assets` references from `backend/database.js` (also cleaning up disk assets on `deleteVideo`) and `backend/clear-cache.js`.
- Updated `backend/tests/qaCacheManager.test.js` for the filesystem contract, legacy hashed-filename compatibility, and table-drop verification.

## Task Commits

1. **Drop `qa_frame_assets` table and frame SHA256 logic** - `48b9f55`

## Verification

- Local syntax checks & core suite: 56/56 passed.
- Isolated Linux sandbox Q&A suite (`tests/qaCacheManager.test.js`, `tests/qaMedia.test.js`, `tests/qaPipelineFoundation.test.js`, `tests/qaContext.test.js`): 52/52 passed in 4.9s.

## Self-Check: PASSED

- Commit `48b9f55` verified on `main`.
