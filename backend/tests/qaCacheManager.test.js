const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { createQaCacheManager } = require('../modules/qaCacheManager');
const { migrateQaCache, createQaCacheStore } = require('../modules/qaCacheStore');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cache-test-'));
    const db = new Database(path.join(dir, 'test.db'));
    const root = path.join(dir, 'cache');
    let clock = Date.now();
    const now = () => clock;
    const manager = createQaCacheManager({ db, root, now });
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { manager, db, dir, root, now, advance: ms => { clock += ms; } };
}
async function image(dir, timestampMs = 0) {
    const file = path.join(dir, `input-${timestampMs}.jpg`);
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#123456' } }).jpeg().toFile(file);
    return { path: file, sourcePtsMs: timestampMs + 7000, originPtsMs: 7000, timestampMs, sourceKind: 'keyframe' };
}

test('additive migration is idempotent and preserves existing script rows', t => {
    const { db } = fixture(t);
    db.exec("CREATE TABLE scripts(id TEXT, text TEXT); INSERT INTO scripts VALUES('1','existing')");
    migrateQaCache(db); migrateQaCache(db);
    assert.deepEqual(db.prepare('SELECT * FROM scripts').all(), [{ id: '1', text: 'existing' }]);
});
test('two SQLite connections share one claim; expired worker cannot publish or renew', async t => {
    const { manager, dir, advance, now } = fixture(t);
    const otherDb = new Database(path.join(dir, 'test.db'));
    t.after(() => otherDb.close());
    const other = createQaCacheStore(otherDb, { now });
    const old = manager.store.claim('video', 'pts-v1', 'worker-a');
    assert.equal(other.claim('video', 'pts-v1', 'worker-b'), null);
    const frame = await image(dir);
    advance(60001);
    const current = other.claim('video', 'pts-v1', 'worker-b');
    assert.ok(current.fencingToken > old.fencingToken);
    await assert.rejects(manager.publishFrame(old, frame), { code: 'STALE_CACHE_LEASE' });
    assert.throws(() => manager.store.renew(old), { code: 'STALE_CACHE_LEASE' });
    assert.equal(manager.store.listFrames('video', 'pts-v1').length, 0);
});
test('publication validates bytes and PTS, deduplicates, and limits current context to the past', async t => {
    const { manager, dir, root } = fixture(t);
    const lease = manager.store.claim('video', 'pts-v1', 'worker');
    const first = await image(dir);
    await manager.publishFrame(lease, first);
    await manager.publishFrame(lease, first);
    await manager.publishFrame(lease, await image(dir, 2000));
    assert.equal(manager.store.listFrames('video', 'pts-v1').length, 2);
    const selected = manager.framesBefore('video', 'pts-v1', 1999);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].sourcePtsMs, 7000);
    assert.ok(fs.existsSync(path.join(root, selected[0].relativePath)));
    await assert.rejects(manager.publishFrame(lease, { ...first, timestampMs: 1 }), /provenance/);
    fs.writeFileSync(first.path, 'invalid JPEG');
    await assert.rejects(manager.publishFrame(lease, first));
    assert.deepEqual(fs.readdirSync(path.join(root, '.pending')), []);
});
test('a frame hole prevents ready, then completed coverage releases the lease', async t => {
    const { manager, dir } = fixture(t);
    const lease = manager.store.claim('video', 'pts-v1', 'worker');
    manager.store.transition(lease, 'extracting');
    await manager.publishFrame(lease, await image(dir));
    assert.throws(() => manager.markReady(lease, 4000), { code: 'FRAME_COVERAGE_INCOMPLETE' });
    await manager.publishFrame(lease, await image(dir, 2000));
    manager.markReady(lease, 4000);
    assert.equal(manager.store.job('video', 'pts-v1').state, 'ready');
    assert.equal(manager.store.claim('video', 'pts-v1', 'other'), null);
});
test('legacy frames cannot be promoted to verified coverage', async t => {
    const { manager, dir } = fixture(t);
    const legacy = manager.store.claim('video', 'legacy-v0', 'worker');
    manager.store.transition(legacy, 'extracting');
    await manager.publishFrame(legacy, { ...await image(dir), sourceKind: 'legacy' });
    assert.throws(() => manager.markReady(legacy, 2000), /unverified/);
    const verified = manager.store.claim('video', 'pts-v1', 'worker');
    await assert.rejects(manager.publishFrame(verified, { ...await image(dir), sourceKind: 'legacy' }), /provenance/);
});
test('valid VTT takes precedence over absent/error and never infers original language from ko filename', async t => {
    const { manager, dir } = fixture(t);
    const lease = manager.store.claim('video', 'pts-v1', 'worker');
    const file = path.join(dir, 'video.ko.vtt');
    fs.writeFileSync(file, 'WEBVTT\n\n00:00.000 --> 00:01.000\n확인된 글자\n');
    const asset = await manager.publishSubtitle(lease, file);
    assert.equal(asset.originalLanguage, null);
    assert.equal(asset.audioClassification, 'unknown');
    assert.equal(manager.subtitleUnavailable(lease, 'absent').state, 'ready');
    assert.equal(manager.subtitleUnavailable(lease, 'retryable_failed').state, 'ready');
});
test('subtitle absence and transient failures have separate retry lifetimes', t => {
    const { manager, now } = fixture(t);
    const lease = manager.store.claim('video', 'pts-v1', 'worker');
    assert.equal(manager.subtitleUnavailable(lease, 'absent').retryAfter, now() + 86400000);
    assert.equal(manager.subtitleUnavailable(lease, 'retryable_failed').retryAfter, now() + 60000);
});
test('restart reconciles corrupt/missing assets, expired owners and orphans without discarding valid assets', async t => {
    const { manager, db, dir, root, advance, now } = fixture(t);
    const lease = manager.store.claim('video', 'pts-v1', 'worker');
    const first = await manager.publishFrame(lease, await image(dir));
    const second = await manager.publishFrame(lease, await image(dir, 2000));
    fs.unlinkSync(path.join(root, first.relativePath));
    fs.writeFileSync(path.join(root, '.pending', 'abandoned'), 'partial');
    fs.utimesSync(path.join(root, '.pending', 'abandoned'), new Date(now()), new Date(now()));
    advance(3600001);
    const restarted = createQaCacheManager({ db, root, now });
    const report = restarted.reconcile();
    assert.equal(report.removedFrames, 1);
    assert.equal(report.recoveredJobs, 1);
    assert.equal(report.removedOrphans, 1);
    assert.equal(restarted.framesBefore('video', 'pts-v1', 3000)[0].checksum, second.checksum);
    assert.throws(() => restarted.store.renew(lease), { code: 'STALE_CACHE_LEASE' });
    assert.ok(restarted.store.claim('video', 'pts-v1', 'new-worker'));
});
test('reconciliation leaves active workers and their pending assets alone', t => {
    const { manager, root } = fixture(t);
    manager.store.claim('video', 'pts-v1', 'worker');
    const pending = path.join(root, '.pending', 'in-flight');
    fs.writeFileSync(pending, 'partial'); fs.utimesSync(pending, new Date(0), new Date(0));
    assert.equal(manager.reconcile().removedOrphans, 0);
    assert.ok(fs.existsSync(pending));
});
test('canceling one reference does not release another user; heartbeat expiry is bounded', t => {
    const { manager, advance } = fixture(t);
    manager.touchReference('video', 'pts-v1', 'user-a');
    manager.touchReference('video', 'pts-v1', 'user-b');
    manager.releaseReference('video', 'pts-v1', 'user-a');
    assert.equal(manager.referenceCount('video', 'pts-v1'), 1);
    advance(300000);
    assert.equal(manager.referenceCount('video', 'pts-v1'), 0);
});

test('legacy filenames are indexed separately without inventing verified timing or Korean source audio', async t => {
    const { manager, dir } = fixture(t);
    const legacyDir = path.join(dir, 'legacy'); fs.mkdirSync(legacyDir);
    fs.copyFileSync((await image(dir)).path, path.join(legacyDir, 'frame-12.5.jpg'));
    const subtitlePath = path.join(legacyDir, 'video.ko.vtt'); fs.writeFileSync(subtitlePath, 'WEBVTT\n\n');
    const lease = manager.store.claim('video', 'legacy-v0', 'worker');
    const result = await manager.indexLegacy(lease, { framesDirectory: legacyDir, subtitlePath });
    assert.equal(result.verifiedCoverage, false);
    assert.equal(manager.framesBefore('video', 'legacy-v0', 12500)[0].sourceKind, 'legacy');
    assert.equal(manager.framesBefore('video', 'pts-v1', 12500).length, 0);
    assert.equal(manager.store.subtitle('video', 'legacy-v0').audioClassification, 'unknown');
});

test('corrupt persisted frames are not returned as current-question evidence', async t => {
    const { manager, dir, root } = fixture(t);
    const lease = manager.store.claim('video', 'pts-v1', 'worker');
    const asset = await manager.publishFrame(lease, await image(dir));
    fs.writeFileSync(path.join(root, asset.relativePath), 'damaged');
    assert.deepEqual(manager.framesBefore('video', 'pts-v1', 1000), []);
});
