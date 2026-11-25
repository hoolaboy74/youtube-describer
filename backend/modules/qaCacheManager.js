'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { createQaCacheStore } = require('./qaCacheStore');
const { findCoverageHoles } = require('./frameExtraction');
const { mediaDiskBudget } = require('./mediaDiskBudget');

function parseFrameFilename(name) {
    let match = String(name || '').match(/^(\d+)\.jpg$/);
    if (match) {
        const timestampMs = Number(match[1]);
        if (Number.isSafeInteger(timestampMs) && timestampMs >= 0) {
            return { timestampMs, sourcePtsMs: timestampMs, canonical: true };
        }
    }
    // Backward compatibility with existing <sourcePtsMs>-<sha256>.jpg cached files on disk.
    match = String(name || '').match(/^(\d+)-[a-f0-9]{64}\.jpg$/);
    if (match) {
        const timestampMs = Number(match[1]);
        if (Number.isSafeInteger(timestampMs) && timestampMs >= 0) {
            return { timestampMs, sourcePtsMs: timestampMs, canonical: false };
        }
    }
    return null;
}

function isValidJpegFileSync(filePath) {
    let fd;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size < 3) return false;
        fd = fs.openSync(filePath, 'r');
        const header = Buffer.allocUnsafe(2);
        const bytesRead = fs.readSync(fd, header, 0, 2, 0);
        return bytesRead === 2 && header[0] === 0xff && header[1] === 0xd8;
    } catch {
        return false;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch {}
        }
    }
}

function createQaCacheManager({ db, root, now = Date.now }) {
    const store = createQaCacheStore(db, { now });
    root = path.resolve(root);
    fs.mkdirSync(path.join(root, '.pending'), { recursive: true });
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    const folder = (videoId, version, kind) => {
        if (![videoId, version].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value))) throw new Error('Invalid cache path component');
        return path.join('assets', videoId, kind, version);
    };
    const absolute = relative => {
        if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid cache asset path');
        const file = path.resolve(root, relative);
        if (!file.startsWith(root + path.sep)) throw new Error('Invalid cache asset path');
        return file;
    };
    async function stage(inputPath, maxBytes, { computeChecksum = false } = {}) {
        const input = await fs.promises.stat(inputPath);
        if (!input.isFile() || !input.size || input.size > maxBytes) throw new Error('Cache asset size limit');
        const reservation = mediaDiskBudget.reserve(root, input.size);
        const file = path.join(root, '.pending', crypto.randomUUID());
        try {
            await fs.promises.copyFile(inputPath, file);
            const stat = await fs.promises.stat(file);
            reservation.check(stat.size);
            const bytes = await fs.promises.readFile(file);
            return { file, bytes, ...(computeChecksum ? { checksum: digest(bytes) } : {}), reservation };
        } catch (error) { reservation.release(); await fs.promises.rm(file, { force: true }); throw error; }
    }
    function listFramesFromDisk(videoId, cacheVersion, beforeMs = Number.MAX_SAFE_INTEGER) {
        let relativeDir;
        try { relativeDir = folder(videoId, cacheVersion, 'frames'); } catch { return []; }
        const dir = absolute(relativeDir);
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
        const sourceKind = cacheVersion.startsWith('legacy-') ? 'legacy' : 'keyframe';
        const byTimestamp = new Map();
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const parsed = parseFrameFilename(entry.name);
            if (!parsed || parsed.timestampMs > beforeMs) continue;
            const existing = byTimestamp.get(parsed.timestampMs);
            if (existing && existing._canonical && !parsed.canonical) continue;
            byTimestamp.set(parsed.timestampMs, {
                videoId,
                cacheVersion,
                sourcePtsMs: parsed.sourcePtsMs,
                originPtsMs: 0,
                timestampMs: parsed.timestampMs,
                relativePath: path.join(relativeDir, entry.name),
                sourceKind,
                _canonical: parsed.canonical
            });
        }
        return [...byTimestamp.values()]
            .sort((a, b) => a.timestampMs - b.timestampMs)
            .map(({ _canonical, ...frame }) => frame);
    }
    store.listFrames = listFramesFromDisk;

    const references = new Map();
    return {
        store, root, assetPath: absolute,
        listFrames: listFramesFromDisk,
        deleteVideoAssets(videoId) {
            if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(videoId)) return;
            const target = absolute(path.join('assets', videoId));
            try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
        },
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
                const relativePath = path.join(folder(lease.videoId, assetVersion, 'frames'), `${frame.timestampMs}.jpg`);
                return store.fenced(lease, () => {
                    fs.mkdirSync(path.dirname(absolute(relativePath)), { recursive: true });
                    fs.renameSync(staged.file, absolute(relativePath));
                    return {
                        videoId: lease.videoId,
                        cacheVersion: assetVersion,
                        sourcePtsMs: frame.timestampMs,
                        originPtsMs: 0,
                        timestampMs: frame.timestampMs,
                        relativePath,
                        sourceKind: assetVersion.startsWith('legacy-') ? 'legacy' : 'keyframe'
                    };
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
            const staged = await stage(inputPath, 16 * 1024 * 1024, { computeChecksum: true });
            try {
                if (!/^\uFEFF?WEBVTT(?:[ \t].*)?\r?\n/.test(staged.bytes.toString('utf8'))) throw new Error('Invalid VTT asset');
                const relativePath = path.join(folder(lease.videoId, lease.cacheVersion, 'subtitles'), `${staged.checksum}.vtt`);
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
            for (const frame of listFramesFromDisk(videoId, cacheVersion, timestampMs).reverse()) {
                if (isValidJpegFileSync(absolute(frame.relativePath))) {
                    selected.push(frame);
                } else {
                    try { fs.unlinkSync(absolute(frame.relativePath)); } catch {}
                    db.transaction(() => {
                        db.prepare("UPDATE qa_cache_jobs SET state='queued',retryAfter=0,fencingToken=fencingToken+1 WHERE videoId=? AND cacheVersion=? AND leaseUntil<=?").run(videoId, cacheVersion, now());
                    }).immediate();
                }
                if (selected.length === count) break;
            }
            return selected.reverse();
        },
        framesInRange(videoId, cacheVersion, startMs, endMs, timestampMs, count = 8) {
            if (![startMs, endMs, timestampMs].every(Number.isSafeInteger) || startMs < 0 || endMs < startMs
                || !Number.isInteger(count) || count < 3 || count > 100) throw new Error('Invalid frame range');
            let candidates = listFramesFromDisk(videoId, cacheVersion, endMs).filter(frame => frame.timestampMs >= startMs);
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
                const frames = [...selected].sort((a, b) => a - b).map(i => candidates[i]);
                const invalid = frames.filter(frame => !isValidJpegFileSync(absolute(frame.relativePath)));
                if (!invalid.length) return frames;
                for (const badFrame of invalid) {
                    try { fs.unlinkSync(absolute(badFrame.relativePath)); } catch {}
                }
                const bad = new Set(invalid.map(frame => frame.timestampMs));
                candidates = candidates.filter(frame => !bad.has(frame.timestampMs));
            }
            return [];
        },
        markReady(lease, durationMs) {
            return store.fenced(lease, () => {
                const frames = listFramesFromDisk(lease.videoId, lease.cacheVersion);
                if (!frames.length || lease.cacheVersion.startsWith('legacy-')
                    || frames.some(f => f.sourceKind === 'legacy' || !isValidJpegFileSync(absolute(f.relativePath)))) {
                    throw new Error('Cache contains missing or unverified frames');
                }
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
            const report = { resetSubtitles: 0, recoveredJobs: 0, removedOrphans: 0 };
            let hasActiveLease = false;
            const active = (videoId, cacheVersion) => (store.job(videoId, cacheVersion)?.leaseUntil || 0) > now();
            db.transaction(() => {
                for (const asset of db.prepare("SELECT * FROM qa_subtitle_assets WHERE state='ready'").all()) {
                    if (active(asset.videoId, asset.cacheVersion)) continue;
                    let exists = false;
                    try {
                        const stat = fs.statSync(absolute(asset.relativePath));
                        exists = stat.isFile() && stat.size > 0;
                    } catch {}
                    if (exists) continue;
                    db.prepare("UPDATE qa_subtitle_assets SET state='unknown',relativePath=NULL,checksum=NULL,retryAfter=0 WHERE videoId=? AND cacheVersion=?").run(asset.videoId, asset.cacheVersion);
                    report.resetSubtitles++;
                }
                for (const job of db.prepare('SELECT * FROM qa_cache_jobs').all()) {
                    if (job.leaseUntil > now()) { hasActiveLease = true; continue; }
                    if (job.owner) {
                        db.prepare("UPDATE qa_cache_jobs SET state='queued',owner=NULL,leaseUntil=0,fencingToken=fencingToken+1,retryAfter=0 WHERE videoId=? AND cacheVersion=?").run(job.videoId, job.cacheVersion);
                        report.recoveredJobs++;
                    }
                }
            }).immediate();
            // .pending may contain an in-flight copy, so only reap it when no live worker owns a lease.
            if (!hasActiveLease) {
                const pendingDir = path.join(root, '.pending');
                if (fs.existsSync(pendingDir)) {
                    for (const entry of fs.readdirSync(pendingDir, { withFileTypes: true })) {
                        const file = path.join(pendingDir, entry.name);
                        try {
                            if (entry.isFile() && fs.statSync(file).mtimeMs + orphanTtlMs <= now()) {
                                fs.unlinkSync(file);
                                report.removedOrphans++;
                            }
                        } catch {}
                    }
                }
            }
            return report;
        },
    };
}
module.exports = { createQaCacheManager, parseFrameFilename, isValidJpegFileSync };
