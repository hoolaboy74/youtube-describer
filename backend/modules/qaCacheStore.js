'use strict';

function migrateQaCache(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS qa_cache_jobs (
            videoId TEXT NOT NULL, cacheVersion TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','downloading','extracting','ready','retryable_failed')),
            owner TEXT, leaseUntil INTEGER NOT NULL DEFAULT 0, fencingToken INTEGER NOT NULL DEFAULT 0,
            retryAfter INTEGER NOT NULL DEFAULT 0, lastError TEXT, lastAccessAt INTEGER NOT NULL,
            PRIMARY KEY(videoId, cacheVersion)
        );
        CREATE TABLE IF NOT EXISTS qa_frame_assets (
            videoId TEXT NOT NULL, cacheVersion TEXT NOT NULL, sourcePtsMs INTEGER NOT NULL,
            originPtsMs INTEGER NOT NULL, timestampMs INTEGER NOT NULL CHECK(timestampMs >= 0),
            relativePath TEXT NOT NULL, sourceKind TEXT NOT NULL CHECK(sourceKind IN ('keyframe','backfill','window','legacy')),
            checksum TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
            PRIMARY KEY(videoId, cacheVersion, sourcePtsMs)
        );
        CREATE INDEX IF NOT EXISTS qa_frame_window ON qa_frame_assets(videoId, cacheVersion, timestampMs);
        CREATE TABLE IF NOT EXISTS qa_subtitle_assets (
            videoId TEXT NOT NULL, cacheVersion TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('unknown','fetching','ready','absent','retryable_failed')),
            relativePath TEXT, checksum TEXT, originalLanguage TEXT,
            audioClassification TEXT NOT NULL DEFAULT 'unknown', sourceType TEXT NOT NULL DEFAULT 'unknown',
            provenance TEXT NOT NULL DEFAULT 'unknown', checkedAt INTEGER NOT NULL, retryAfter INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(videoId, cacheVersion)
        );
    `);
}
function createQaCacheStore(db, { now = Date.now } = {}) {
    migrateQaCache(db);
    const job = (videoId, cacheVersion) => db.prepare('SELECT * FROM qa_cache_jobs WHERE videoId=? AND cacheVersion=?').get(videoId, cacheVersion);
    const assertLease = lease => {
        const current = job(lease.videoId, lease.cacheVersion);
        if (!current || current.owner !== lease.owner || current.fencingToken !== lease.fencingToken || current.leaseUntil <= now()) {
            throw Object.assign(new Error('Cache worker lease is stale'), { code: 'STALE_CACHE_LEASE' });
        }
        return current;
    };
    const fenced = (lease, operation) => db.transaction(() => { assertLease(lease); return operation(); }).immediate();
    return {
        db, now, job, assertLease, fenced,
        claim(videoId, cacheVersion, owner, leaseMs = 60000) {
            if (![videoId, cacheVersion].every(v => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(v))
                || typeof owner !== 'string' || !owner.length || owner.length > 128 || owner.includes('\0')
                || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('Invalid cache claim');
            return db.transaction(() => {
                const at = now();
                db.prepare('INSERT OR IGNORE INTO qa_cache_jobs(videoId,cacheVersion,lastAccessAt) VALUES(?,?,?)').run(videoId, cacheVersion, at);
                const current = job(videoId, cacheVersion);
                if (current.state === 'ready' || current.leaseUntil > at || current.retryAfter > at) return null;
                db.prepare("UPDATE qa_cache_jobs SET owner=?,leaseUntil=?,fencingToken=fencingToken+1,state='queued',lastAccessAt=? WHERE videoId=? AND cacheVersion=?")
                    .run(owner, at + leaseMs, at, videoId, cacheVersion);
                return job(videoId, cacheVersion);
            }).immediate();
        },
        renew(lease, leaseMs = 60000) {
            if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('Invalid cache lease duration');
            return fenced(lease, () => {
                db.prepare('UPDATE qa_cache_jobs SET leaseUntil=? WHERE videoId=? AND cacheVersion=?').run(now() + leaseMs, lease.videoId, lease.cacheVersion);
                return job(lease.videoId, lease.cacheVersion);
            });
        },
        transition(lease, state, { retryAfter = 0, lastError = null } = {}) {
            if (!Number.isSafeInteger(retryAfter) || retryAfter < 0 || (lastError !== null && (typeof lastError !== 'string' || lastError.length > 512))) throw new Error('Invalid cache retry state');
            return fenced(lease, () => {
                const current = job(lease.videoId, lease.cacheVersion);
                const allowed = { queued: ['downloading','extracting','retryable_failed'], downloading: ['extracting','retryable_failed'], extracting: ['ready','retryable_failed'] };
                if (!allowed[current.state]?.includes(state)) throw new Error('Invalid cache state transition');
                const terminal = state === 'ready' || state === 'retryable_failed';
                db.prepare('UPDATE qa_cache_jobs SET state=?,retryAfter=?,lastError=?,leaseUntil=?,owner=? WHERE videoId=? AND cacheVersion=?')
                    .run(state, retryAfter, lastError, terminal ? 0 : current.leaseUntil, terminal ? null : current.owner, lease.videoId, lease.cacheVersion);
            });
        },
        listFrames(videoId, cacheVersion, beforeMs = Number.MAX_SAFE_INTEGER) {
            return db.prepare('SELECT * FROM qa_frame_assets WHERE videoId=? AND cacheVersion=? AND timestampMs<=? ORDER BY timestampMs')
                .all(videoId, cacheVersion, beforeMs);
        },
        insertFrame(lease, frame) {
            assertLease(lease); // Caller owns a fenced transaction across rename + registration.
            db.prepare(`INSERT OR IGNORE INTO qa_frame_assets(videoId,cacheVersion,sourcePtsMs,originPtsMs,timestampMs,relativePath,sourceKind,checksum,width,height)
                VALUES(@videoId,@cacheVersion,@sourcePtsMs,@originPtsMs,@timestampMs,@relativePath,@sourceKind,@checksum,@width,@height)`)
                .run({ ...frame, videoId: lease.videoId, cacheVersion: lease.cacheVersion });
            return db.prepare('SELECT * FROM qa_frame_assets WHERE videoId=? AND cacheVersion=? AND sourcePtsMs=?')
                .get(lease.videoId, lease.cacheVersion, frame.sourcePtsMs);
        },
        subtitle(videoId, cacheVersion) {
            return db.prepare('SELECT * FROM qa_subtitle_assets WHERE videoId=? AND cacheVersion=?').get(videoId, cacheVersion);
        },
        putSubtitle(lease, asset) {
            assertLease(lease);
            db.prepare(`INSERT INTO qa_subtitle_assets(videoId,cacheVersion,state,relativePath,checksum,originalLanguage,audioClassification,sourceType,provenance,checkedAt,retryAfter)
                VALUES(@videoId,@cacheVersion,@state,@relativePath,@checksum,@originalLanguage,@audioClassification,@sourceType,@provenance,@checkedAt,@retryAfter)
                ON CONFLICT(videoId,cacheVersion) DO UPDATE SET state=excluded.state,relativePath=excluded.relativePath,checksum=excluded.checksum,
                originalLanguage=excluded.originalLanguage,audioClassification=excluded.audioClassification,sourceType=excluded.sourceType,
                provenance=excluded.provenance,checkedAt=excluded.checkedAt,retryAfter=excluded.retryAfter`)
                .run({ state: 'unknown', relativePath: null, checksum: null, originalLanguage: null, audioClassification: 'unknown', sourceType: 'unknown',
                    provenance: 'unknown', checkedAt: now(), retryAfter: 0, ...asset, videoId: lease.videoId, cacheVersion: lease.cacheVersion });
        },
    };
}
module.exports = { migrateQaCache, createQaCacheStore };
