'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { createQaCacheStore } = require('./qaCacheStore');
const { findCoverageHoles } = require('./frameExtraction');
const { mediaDiskBudget } = require('./mediaDiskBudget');

function createQaCacheManager({ db, root, now = Date.now }) {
    const store = createQaCacheStore(db, { now });
    root = path.resolve(root);
    fs.mkdirSync(path.join(root, '.pending'), { recursive: true });
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    const folder = (videoId, version) => path.join('assets', digest(`${videoId}\0${version}`));
    const absolute = relative => {
        if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid cache asset path');
        const file = path.resolve(root, relative);
        if (!file.startsWith(root + path.sep)) throw new Error('Invalid cache asset path');
        return file;
    };
    async function stage(inputPath, maxBytes) {
        const input = await fs.promises.stat(inputPath);
        if (!input.isFile() || !input.size || input.size > maxBytes) throw new Error('Cache asset size limit');
        const reservation = mediaDiskBudget.reserve(root, input.size);
        const file = path.join(root, '.pending', crypto.randomUUID());
        try {
            await fs.promises.copyFile(inputPath, file);
            const stat = await fs.promises.stat(file);
            reservation.check(stat.size);
            const bytes = await fs.promises.readFile(file);
            return { file, bytes, checksum: digest(bytes), reservation };
        } catch (error) { reservation.release(); await fs.promises.rm(file, { force: true }); throw error; }
    }
    const references = new Map();
    return {
        store, root, assetPath: absolute,
        async indexLegacy(lease, { framesDirectory, subtitlePath }) {
            if (!lease.cacheVersion.startsWith('legacy-')) throw new Error('Legacy assets require a separate cache version');
            store.assertLease(lease);
            let count = 0;
            if (framesDirectory && fs.existsSync(framesDirectory)) {
                for (const entry of fs.readdirSync(framesDirectory, { withFileTypes: true })) {
                    const match = entry.name.match(/^frame-(\d+(?:\.\d+)?)\.jpg$/);
                    if (!entry.isFile() || !match) continue;
                    const timestampMs = Math.round(Number(match[1]) * 1000);
                    await this.publishFrame(lease, { path: path.join(framesDirectory, entry.name), sourcePtsMs: timestampMs,
                        originPtsMs: 0, timestampMs, sourceKind: 'legacy' });
                    count++;
                }
            }
            if (subtitlePath && fs.existsSync(subtitlePath)) await this.publishSubtitle(lease, subtitlePath, { provenance: 'legacy' });
            return { indexedFiles: count, provenance: 'legacy', verifiedCoverage: false };
        },
        async publishFrame(lease, frame, assetVersion = lease.cacheVersion) {
            store.assertLease(lease);
            if (![frame.sourcePtsMs, frame.originPtsMs, frame.timestampMs].every(Number.isSafeInteger)
                || frame.timestampMs < 0 || frame.timestampMs !== frame.sourcePtsMs - frame.originPtsMs
                || !['keyframe','backfill','window','legacy'].includes(frame.sourceKind)
                || (frame.sourceKind === 'legacy') !== assetVersion.startsWith('legacy-')) throw new Error('Invalid frame provenance');
            const staged = await stage(frame.path, 5 * 1024 * 1024);
            try {
                const { info } = await sharp(staged.bytes, { failOn: 'warning' }).raw().toBuffer({ resolveWithObject: true });
                if (info.width < 1 || info.height < 1 || (frame.sourceKind !== 'legacy' && info.width !== 640)) throw new Error('Invalid frame dimensions');
                const relativePath = path.join(folder(lease.videoId, assetVersion), `${frame.sourcePtsMs}-${staged.checksum}.jpg`);
                return store.fenced(lease, () => {
                    fs.mkdirSync(path.dirname(absolute(relativePath)), { recursive: true });
                    fs.renameSync(staged.file, absolute(relativePath));
                    return store.insertFrame(lease, { sourcePtsMs: frame.sourcePtsMs, originPtsMs: frame.originPtsMs, timestampMs: frame.timestampMs,
                        relativePath, sourceKind: frame.sourceKind, checksum: staged.checksum, width: info.width, height: info.height }, assetVersion);
                });
            } finally { staged.reservation.release(); await fs.promises.rm(staged.file, { force: true }); }
        },
        async publishSubtitle(lease, inputPath, metadata = {}) {
            store.assertLease(lease);
            const { originalLanguage = null, audioClassification = 'unknown', sourceType = 'unknown', provenance = 'unknown' } = metadata;
            if (!['unknown','korean','foreign','mixed'].includes(audioClassification)
                || !['unknown','manual','automatic','translated'].includes(sourceType)
                || !['unknown','legacy','verified'].includes(provenance)
                || (originalLanguage !== null && !/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(originalLanguage))) throw new Error('Invalid subtitle provenance');
            const staged = await stage(inputPath, 16 * 1024 * 1024);
            try {
                if (!/^\uFEFF?WEBVTT(?:[ \t].*)?\r?\n/.test(staged.bytes.toString('utf8'))) throw new Error('Invalid VTT asset');
                const relativePath = path.join(folder(lease.videoId, lease.cacheVersion), `${staged.checksum}.vtt`);
                store.fenced(lease, () => {
                    fs.mkdirSync(path.dirname(absolute(relativePath)), { recursive: true });
                    fs.renameSync(staged.file, absolute(relativePath));
                    store.putSubtitle(lease, { state: 'ready', relativePath, checksum: staged.checksum, originalLanguage, audioClassification, sourceType, provenance });
                });
                return store.subtitle(lease.videoId, lease.cacheVersion);
            } finally { staged.reservation.release(); await fs.promises.rm(staged.file, { force: true }); }
        },
        invalidateSubtitle(videoId, cacheVersion) {
            db.transaction(() => {
                if ((store.job(videoId, cacheVersion)?.leaseUntil || 0) > now()) return;
                db.prepare("UPDATE qa_subtitle_assets SET state='unknown',relativePath=NULL,checksum=NULL,retryAfter=0 WHERE videoId=? AND cacheVersion=?").run(videoId, cacheVersion);
                db.prepare("UPDATE qa_cache_jobs SET state='queued',retryAfter=0,fencingToken=fencingToken+1 WHERE videoId=? AND cacheVersion=?").run(videoId, cacheVersion);
            }).immediate();
        },
        subtitleUnavailable(lease, state) {
            if (!['absent','retryable_failed'].includes(state)) throw new Error('Invalid subtitle absence state');
            return store.fenced(lease, () => {
                const existing = store.subtitle(lease.videoId, lease.cacheVersion);
                if (existing?.state === 'ready' && fs.existsSync(absolute(existing.relativePath))
                    && digest(fs.readFileSync(absolute(existing.relativePath))) === existing.checksum) return existing;
                store.putSubtitle(lease, { state, retryAfter: now() + (state === 'absent' ? 86400000 : 60000) });
                return store.subtitle(lease.videoId, lease.cacheVersion);
            });
        },
        framesBefore(videoId, cacheVersion, timestampMs, count = 4) {
            if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || !Number.isInteger(count) || count < 1 || count > 100) throw new Error('Invalid frame window');
            const selected = [];
            for (const frame of store.listFrames(videoId, cacheVersion, timestampMs).reverse()) {
                let valid = false;
                try { valid = digest(fs.readFileSync(absolute(frame.relativePath))) === frame.checksum; } catch {}
                if (valid) selected.push(frame);
                else db.transaction(() => {
                    db.prepare('DELETE FROM qa_frame_assets WHERE videoId=? AND cacheVersion=? AND sourcePtsMs=? AND checksum=?').run(videoId, cacheVersion, frame.sourcePtsMs, frame.checksum);
                    db.prepare("UPDATE qa_cache_jobs SET state='queued',retryAfter=0,fencingToken=fencingToken+1 WHERE videoId=? AND cacheVersion=? AND leaseUntil<=?").run(videoId, cacheVersion, now());
                }).immediate();
                if (selected.length === count) break;
            }
            return selected.reverse();
        },
        framesInRange(videoId, cacheVersion, startMs, endMs, timestampMs, count = 8) {
            if (![startMs, endMs, timestampMs].every(Number.isSafeInteger) || startMs < 0 || endMs < startMs
                || !Number.isInteger(count) || count < 3 || count > 100) throw new Error('Invalid frame range');
            let candidates = db.prepare('SELECT * FROM qa_frame_assets WHERE videoId=? AND cacheVersion=? AND timestampMs BETWEEN ? AND ? ORDER BY timestampMs')
                .all(videoId, cacheVersion, startMs, endMs);
            // Select metadata first: dense caches must not require reading every JPEG.
            while (candidates.length) {
                const selected = new Set([0, candidates.length - 1]);
                const anchor = candidates.findLastIndex(frame => frame.timestampMs <= timestampMs);
                if (anchor >= 0) selected.add(anchor);
                while (selected.size < Math.min(count, candidates.length)) {
                    let best = -1, distance = -1;
                    for (let i = 0; i < candidates.length; i++) {
                        if (selected.has(i)) continue;
                        const nearest = Math.min(...[...selected].map(j => Math.abs(candidates[i].timestampMs - candidates[j].timestampMs)));
                        if (nearest > distance) { best = i; distance = nearest; }
                    }
                    selected.add(best);
                }
                const frames = [...selected].sort((a,b) => a-b).map(i => candidates[i]);
                const invalid = frames.filter(frame => {
                    try { return digest(fs.readFileSync(absolute(frame.relativePath))) !== frame.checksum; } catch { return true; }
                });
                if (!invalid.length) return frames;
                const bad = new Set(invalid.map(frame => frame.sourcePtsMs));
                candidates = candidates.filter(frame => !bad.has(frame.sourcePtsMs));
            }
            return [];
        },
        markReady(lease, durationMs) {
            return store.fenced(lease, () => {
                const frames = store.listFrames(lease.videoId, lease.cacheVersion);
                if (!frames.length || frames.some(f => f.sourceKind === 'legacy' || !fs.existsSync(absolute(f.relativePath))
                    || digest(fs.readFileSync(absolute(f.relativePath))) !== f.checksum)) throw new Error('Cache contains missing or unverified frames');
                const holes = findCoverageHoles(frames, durationMs);
                if (holes.length) throw Object.assign(new Error('Frame coverage is incomplete'), { code: 'FRAME_COVERAGE_INCOMPLETE', coverageHoles: holes });
                store.transition(lease, 'ready');
            });
        },
        // A presence reference outlives an individual answer and is refreshed by
        // the session heartbeat. Jobs and completed assets never live only here.
        touchReference(videoId, cacheVersion, referenceId) {
            if (typeof referenceId !== 'string' || !referenceId || referenceId.length > 256) throw new Error('Invalid cache reference');
            const key = `${videoId}\0${cacheVersion}`;
            if (!references.has(key)) references.set(key, new Map());
            references.get(key).set(referenceId, now());
        },
        releaseReference(videoId, cacheVersion, referenceId) { references.get(`${videoId}\0${cacheVersion}`)?.delete(referenceId); },
        referenceCount(videoId, cacheVersion) {
            const key = `${videoId}\0${cacheVersion}`;
            const refs = references.get(key);
            if (!refs) return 0;
            for (const [id, at] of refs) if (at + 300000 <= now()) refs.delete(id);
            if (!refs.size) references.delete(key);
            return refs.size;
        },
        reconcile({ orphanTtlMs = 3600000 } = {}) {
            const report = { removedFrames: 0, resetSubtitles: 0, recoveredJobs: 0, removedOrphans: 0 };
            const validFile = asset => {
                try { return digest(fs.readFileSync(absolute(asset.relativePath))) === asset.checksum; } catch { return false; }
            };
            const activeFolders = new Set();
            const active = (videoId, cacheVersion) => (store.job(videoId, cacheVersion)?.leaseUntil || 0) > now();
            db.transaction(() => {
                const damaged = new Map();
                for (const asset of db.prepare('SELECT * FROM qa_frame_assets').all()) {
                    if (active(asset.videoId, asset.cacheVersion) || validFile(asset)) continue;
                    db.prepare('DELETE FROM qa_frame_assets WHERE videoId=? AND cacheVersion=? AND sourcePtsMs=?').run(asset.videoId, asset.cacheVersion, asset.sourcePtsMs);
                    damaged.set(`${asset.videoId}\0${asset.cacheVersion}`, asset); report.removedFrames++;
                }
                for (const asset of db.prepare("SELECT * FROM qa_subtitle_assets WHERE state='ready'").all()) {
                    if (active(asset.videoId, asset.cacheVersion) || validFile(asset)) continue;
                    db.prepare("UPDATE qa_subtitle_assets SET state='unknown',relativePath=NULL,checksum=NULL,retryAfter=0 WHERE videoId=? AND cacheVersion=?").run(asset.videoId, asset.cacheVersion);
                    report.resetSubtitles++;
                }
                for (const job of db.prepare('SELECT * FROM qa_cache_jobs').all()) {
                    if (job.leaseUntil > now()) { activeFolders.add(folder(job.videoId, job.cacheVersion)); continue; }
                    if (job.owner || damaged.has(`${job.videoId}\0${job.cacheVersion}`)) {
                        db.prepare("UPDATE qa_cache_jobs SET state='queued',owner=NULL,leaseUntil=0,fencingToken=fencingToken+1,retryAfter=0 WHERE videoId=? AND cacheVersion=?").run(job.videoId, job.cacheVersion);
                        report.recoveredJobs++;
                    }
                }
            }).immediate();
            const known = new Set([...db.prepare('SELECT relativePath FROM qa_frame_assets').all(), ...db.prepare('SELECT relativePath FROM qa_subtitle_assets WHERE relativePath IS NOT NULL').all()].map(r => r.relativePath));
            function walk(directory) {
                if (!fs.existsSync(directory)) return;
                for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                    const file = path.join(directory, entry.name);
                    const relative = path.relative(root, file);
                    if ([...activeFolders].some(active => relative === active || relative.startsWith(active + path.sep))) continue;
                    if (entry.isDirectory()) walk(file);
                    else if (entry.isFile() && !known.has(relative) && fs.statSync(file).mtimeMs + orphanTtlMs <= now()) { fs.unlinkSync(file); report.removedOrphans++; }
                }
            }
            walk(path.join(root, 'assets'));
            // .pending may contain an in-flight copy, so only reap it when no
            // live worker owns a lease. Fencing protects late completion anyway.
            if (!activeFolders.size) walk(path.join(root, '.pending'));
            return report;
        },
    };
}
module.exports = { createQaCacheManager };
