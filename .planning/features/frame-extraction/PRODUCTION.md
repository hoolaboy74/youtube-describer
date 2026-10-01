# Production release and temporary-file cleanup — 2026-10-01

User authorized main integration, production deployment and benchmark-directory cleanup after the live NKG_BmAPEdI comparison.

## Release

- Selected the four tested frame extraction/cache compatibility commits from test and their validation archive; unrelated statistics work and uncommitted worktree edits were preserved.
- Main merge/deployed application revision: **6c9bda7**. Deployment used /home/chacha/deploy-app.sh and completed backend installation/PM2 restart plus frontend installation/build/sync.
- Final isolated main release tests: **158/158 passed**, 46.47s. GOOGLE_API_KEY=offline-test supplies the required SDK initialization setting in the clean checkout; fixtures make no external AI calls.
- Production focused tests: **51/51 passed**, 9.98s.
- Production PM2 backend online, PID 2532857. Home https://blindmom.org/ and featured-videos API returned HTTP 200.
- Deployed frame extractor SHA256 a438ebcebb59df0065135607ed391694cec3b3511a468c15a57683911a21c963 and QA media SHA256 4e70cc5cdadc94daf8c5866faa70d3c7c3d91e600dabc5d10b26be3685387dcf match the tested source.

## Existing cache verification

Read-only production cache check for NKG_BmAPEdI at 12.5s: frames-v1, fromCache=true, six returned frames, **zero media download/extraction calls**. All 445 existing stored frames remained unchanged, cache job ready. Canonical row hash before/after release: 6d8a9fc5569c152a1a075ce4262cc9e294ad20be264de447ca8de404bd69da4c. No cache purge, migration, mass rebuild or timestamp rewrite.

## Cleanup

Small reports and metric JSON were preserved in artifacts/ (19 files, about 220KB) before deleting downloaded videos, extracted JPEGs and disposable benchmark scripts.

Removed production-host benchmark directories:

- /home/chacha/frame-bench-20261001-wNoIzt
- /home/chacha/frame-bench-few-20261001-tCLL7H
- /home/chacha/frame-methods-20261001-uCtxnH
- /home/chacha/frame-implementation-20261001

Removed local /tmp/youtube-frame-bench, /tmp/youtube-frame-methods, /tmp/youtube-frame-implementation and the isolated /tmp/viewrator-frame-release-20261001 worktree. Removed the temporary release branch after merge. Deployment/test temporary logs were removed after recording their outcomes. Application directories, databases, stored QA frames and credentials were preserved.
