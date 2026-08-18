# Codebase Concerns

**Analysis Date:** 2026-08-18

## Tech Debt

**Plain-Text Admin Password:**
- Issue: The administrator password (`admin_password`) is stored in the database's `settings` table as a plain-text string (with a default fallback of `momcenter!@#`) rather than a cryptographic hash.
- Files: `backend/database.js`, `backend/routes.js`
- Impact: If the database file is compromised or read, administrative privileges are fully exposed immediately.
- Fix approach: Hash the administrator password using `bcrypt` or a high-iteration PBKDF2 function before storing it, and verify logins via hash matching.

**Plain-Text User Recovery PINs:**
- Issue: The 4-to-6 digit recovery PIN is stored as raw text in the `users` table and returned as plain text in API responses (such as `/api/users/me`).
- Files: `backend/database.js`, `backend/routes.js`
- Impact: Exposed recovery credentials can be read by anyone with database access or by inspecting network payloads.
- Fix approach: Store the PIN as a secure hash in the database, verify it during recovery using hash comparison, and remove the `pin` field from client-facing API responses.

**Hardcoded Fallback JWT Secret:**
- Issue: If the `JWT_SECRET` environment variable is not defined in the `.env` configuration, the application silently falls back to a hardcoded string `'momcenter-jwt-secret-key-!!!'`.
- Files: `backend/routes.js`
- Impact: Attackers can forge valid JWT tokens locally and assume any user identity, compromising session security.
- Fix approach: Throw a startup error if `JWT_SECRET` is missing in production and require it to be configured securely.

**Obsolete Dependencies:**
- Issue: The package `ytdl-core` is still listed as a dependency in `package.json` but is unused in the application, which has transitioned to using `yt-dlp`.
- Files: `backend/package.json`
- Impact: Increased dependency bloat and unnecessary security scanner alerts.
- Fix approach: Uninstall `ytdl-core` and remove it from `package.json`.

**Orphaned Legacy Comments:**
- Issue: Legacy comments written before the user authentication requirement have a `NULL` `userId`. The current ownership verification checks `String(comment.userId) === String(user.id)`.
- Files: `backend/database.js`, `frontend/src/Comments.js`
- Impact: Authors of legacy comments cannot edit or delete their posts, leaving these entries orphaned.
- Fix approach: Implement a database migration to map legacy comments or drop legacy support.

## Known Bugs

**Broken Backend Financial Balance Check:**
- Symptoms: Video processing requests are permitted to run even if the system's operational balance is negative or depleted.
- Files: `backend/routes.js` (lines 363-368), `backend/database.js` (lines 704-717)
- Trigger: Initiate a video processing request (`/api/process`) when system expenses exceed total donations. The backend checks `financialSummary.balance <= 0` but `db.getAggregatedCosts()` does not return a `balance` field (returning only `totalDonations`, `totalApiCosts`, and `totalProxyCost`). As a result, the check evaluates `undefined <= 0` which is `false`, bypassing the budget lock.

**Disk Cleanup Crash on Non-Directory Files:**
- Symptoms: The background file cleanup routine crashes or stops execution, leaving older files in `tts_cache` indefinitely.
- Files: `backend/index.js` (lines 31-70)
- Trigger: A system or temporary file (such as `.DS_Store`) is placed directly inside `tts_cache` or a hash subdirectory. `fs.promises.readdir` is called on it, throwing an `ENOTDIR` error, which halts the cleanup loop.

## Security Considerations

**Unauthenticated Batch Processing Endpoint:**
- Risk: Exploitation of resources. Anyone can POST to `/api/batch-process` with any YouTube URL, triggering downloading, keyframe extraction, Gemini API calls, and TTS synthesis. This could deplete the Google API quota and billing balance.
- Files: `backend/routes.js`, `backend/videoProcessor.js`
- Current mitigation: None.
- Recommendations: Enforce authentication using `requireAuth` or `requireBlindAuth` on the batch processing API and check video duration limits.

**Unauthenticated TTS Synthesis Endpoint:**
- Risk: Anyone can POST to `/api/tts` with arbitrary text strings to run up synthesis costs.
- Files: `backend/routes.js`
- Current mitigation: The server caches synthesized audio files, but new strings will always trigger a new Google Cloud TTS API call.
- Recommendations: Restrict access to authenticated users and add rate-limiting.

**Weak Password Hashing:**
- Risk: Quick hash cracking in the event of database theft.
- Files: `backend/database.js`
- Current mitigation: PBKDF2 with SHA-512 is used, but it is configured with only 1,000 iterations.
- Recommendations: Increase the iteration count to at least 100,000, or migrate to `bcrypt` or `argon2`.

## Performance Bottlenecks

**Concurrent TTS Request Flooding:**
- Problem: Simultaneous requests containing unique text strings can trigger a flood of Google Cloud TTS API calls, causing budget spikes and local disk I/O contention.
- Files: `backend/routes.js`
- Cause: The `/api/tts` endpoint does not have rate-limiting, request grouping, or queues.
- Improvement path: Implement rate-limiting and a processing queue for TTS requests.

**In-Memory Lock Isolation:**
- Problem: The lock to prevent duplicate concurrent processing of the same video is kept in a local `Set` (`processingLocks`).
- Files: `backend/videoProcessor.js`
- Cause: If the app is run in a cluster (multiple PM2 processes) or horizontally scaled, the locks are isolated to each thread, allowing concurrent processing of the same video.
- Improvement path: Store the active lock status in the SQLite database or a shared Redis instance.

## Fragile Areas

**Mobile Playback Description Resumption:**
- Files: `frontend/src/screens/PlayerScreenV2.js`
- Why fragile: Resuming video playback on mobile in "Together" mode drops the currently playing description audio to prevent queue issues. Mobile users will miss portion descriptions when pausing and resuming.
- Safe modification: Synchronize playback states or queue the description to play from the segment's start on resume.
- Test coverage: No automated tests verify player playback state transitions.

**Hardcoded Server Paths in Cookie Refresher:**
- Files: `backend/bin/server-refresh-cookies.py`
- Why fragile: Paths for cookie storage and replication are hardcoded to `/home/chacha/...` and `/app/...`. Moving the codebase to a different directory or machine will break the update script.
- Safe modification: Use relative path resolution based on the script directory or load directory structures from environment variables.
- Test coverage: Lacks tests verifying the cookie validation or rotation process.

## Scaling Limits

**SQLite Write Serialization:**
- Current capacity: Excellent for read operations, but writes lock the database.
- Limit: Under high concurrency (real-time tracking logs, user postings, and comment additions), write locks will cause "database is locked" errors.
- Scaling path: Migrate to a client-server relational database (such as PostgreSQL) if write volume exceeds SQLite's threshold.

**Disk Cache Cleanup Threshold:**
- Current capacity: Cleans files older than 30 days when disk usage is above 70%.
- Limit: A high volume of new cache files generated in a single day can fill the disk completely, as the files do not meet the 30-day age requirement.
- Scaling path: Implement size-based LRU pruning to clear files regardless of age when the disk space threshold is breached.

## Dependencies at Risk

**Outdated `googleapis` SDK:**
- Risk: Version `60.0.1` is outdated and contains security flaws.
- Impact: Vulnerability alerts and deprecation warnings during communication with YouTube APIs.
- Migration plan: Upgrade `googleapis` to the latest major version (~140.x) in `package.json`.

**Hardcoded Model in OCR Utility:**
- Risk: Sunsetting of the `gemini-2.5-flash` model.
- Impact: If the model is deprecated by Google, the card OCR verification route will fail.
- Migration plan: Bind the OCR utility to the dynamic model environment variable (`GEMINI_MODEL` with fallback to `gemini-3.5-flash`).

## Missing Critical Features

**Admin Session Token Expiry:**
- Problem: The admin panel routes authenticate by passing the plain-text administrator password directly in the `Authorization` header on every request.
- Blocks: Secure session management and temporary admin access.

**Self-Service Password Recovery:**
- Problem: Users cannot recover lost passwords or PINs without administrative intervention.
- Blocks: Scalability of user account management.

## Test Coverage Gaps

**Backend API and Query Testing:**
- What's not tested: Endpoint authorization, SQLite query execution, video processors, and cost estimation helpers.
- Files: `backend/routes.js`, `backend/database.js`, `backend/videoProcessor.js`
- Risk: Regressions in logic or database structure can go unnoticed, resulting in downtime.
- Priority: High

**Frontend Player Screen and Accessibility Actions:**
- What's not tested: Audio ducking, player screen rendering, screen reader focus shifts, and playback state tracking.
- Files: `frontend/src/screens/PlayerScreenV2.js`, `frontend/src/screens/HomeScreen.js`
- Risk: Accessibility breakage for visually impaired users.
- Priority: High

---

*Concerns audit: 2026-08-18*
<!-- refreshed: 2026-08-18 -->
