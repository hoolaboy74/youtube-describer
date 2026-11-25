---
phase: quick-261125-pkd-remove-qa-frame-assets-table-and-hash
plan: 261125-pkd
type: execute
wave: 1
depends_on: []
files_modified:
  - backend/modules/qaCacheStore.js
  - backend/modules/qaCacheManager.js
  - backend/modules/qaMedia.js
  - backend/database.js
  - backend/clear-cache.js
  - backend/tests/qaCacheManager.test.js
autonomous: true
---

# Quick Plan 261125-pkd: Remove `qa_frame_assets` Table & Frame Hash Verification

## Problem
`qa_frame_assets` stores per-frame SHA256 checksums for 290,181 cached frames (6.9 GB on prod). On every backend restart, `database.init()` runs `getQaCacheManager().reconcile()`, synchronously reading and SHA256-hashing all 6.9 GB of JPEGs before `app.listen(4000)`, causing 6-7 minutes of downtime on every deploy. Per-frame hashes are unnecessary because frame publication already decodes with `sharp` and atomically renames from `.pending/`.

## Solution (Option A)
1. **Drop `qa_frame_assets` table** (`backend/modules/qaCacheStore.js`):
   - Execute `DROP TABLE IF EXISTS qa_frame_assets; DROP INDEX IF EXISTS qa_frame_window;` inside `migrateQaCache(db)`.
   - Remove DB-backed `listFrames`/`insertFrame` from `qaCacheStore.js`.
2. **Filesystem-backed frame lookup with zero SHA256** (`backend/modules/qaCacheManager.js`):
   - Save new frames atomically as `assets/<videoId>/frames/<cacheVersion>/<timestampMs>.jpg` (keeping `sharp` validation and atomic `.pending` rename, removing SHA256 hashing).
   - Parse both new `<timestampMs>.jpg` and legacy `<sourcePtsMs>-<64hex>.jpg` filenames in `listFrames` so existing 6.9 GB prod cached frames continue working without regeneration.
   - Replace per-frame SHA256 checks in `framesBefore`, `framesInRange`, and `markReady` with fast JPEG magic-header (`0xFF 0xD8`) + `size > 0` check.
   - Remove full-cache file hashing and `assets/` tree walk from `reconcile()`; keep expired job lease recovery, missing subtitle metadata reset (`fs.existsSync`), and `.pending` orphan cleanup so startup takes <100ms.
   - Add `deleteVideoAssets(videoId)` and expose `store.listFrames` backed by directory listing for caller compatibility.
3. **Remove frame/source SHA256 in Q&A media & cleanup** (`backend/modules/qaMedia.js`, `backend/database.js`, `backend/clear-cache.js`):
   - Replace SHA256 verification in `prepareCacheOnly` with JPEG magic-header + `size > 0` check, and in `rememberedSource`/`ensureRawSource` with `stat.size === data.bytes`.
   - Remove `qa_frame_assets` table references from `database.js` (`deleteVideo` also removes `assets/<videoId>`) and `clear-cache.js`.
4. **Update tests, verify full suite, deploy to prod, and verify <1s startup & dropped table**.
