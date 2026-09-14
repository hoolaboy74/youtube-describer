const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-pipeline-foundation-'));
process.env.YOUTUBE_DESCRIBER_DB_PATH = path.join(directory, 'isolated.db');
process.env.QA_CACHE_ROOT = path.join(directory, 'cache');
process.env.GOOGLE_API_KEY = 'offline-test-key';
process.env.WHISPER_BIN = '/no-such-qa-whisper';
const database = require('../database');
const { extractKeyframesHybrid } = require('../videoProcessor');
const { runMediaProcess } = require('../modules/mediaResourceLimiter');
test.after(() => { database.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('database startup reconciles expired cache jobs and deletion invalidates old worker claims', async () => {
    database.init();
    database.db.prepare("INSERT INTO videos(videoId,title) VALUES('cache-video','test')").run();
    const manager = database.getQaCacheManager();
    const lease = manager.store.claim('cache-video', 'pts-v1', 'worker');
    const file = path.join(directory, 'image.jpg');
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#123456' } }).jpeg().toFile(file);
    await manager.publishFrame(lease, { path: file, sourcePtsMs: 0, originPtsMs: 0, timestampMs: 0, sourceKind: 'keyframe' });
    database.db.prepare("UPDATE qa_cache_jobs SET leaseUntil=0 WHERE videoId='cache-video'").run();
    database.init();
    assert.equal(manager.store.job('cache-video', 'pts-v1').owner, null);
    assert.equal(manager.store.listFrames('cache-video', 'pts-v1').length, 1);
    const resumed = manager.store.claim('cache-video', 'pts-v1', 'worker-2');
    assert.ok(resumed.fencingToken > lease.fencingToken);
    database.deleteVideo('cache-video');
    assert.equal(manager.store.job('cache-video', 'pts-v1'), undefined);
    assert.equal(manager.store.listFrames('cache-video', 'pts-v1').length, 0);
    assert.throws(() => manager.store.renew(resumed), { code: 'STALE_CACHE_LEASE' });
});
test('legacy generator wrapper keeps ordered frame filenames and returns proven timeline seconds', async () => {
    const base = path.join(directory, 'pipeline'); fs.mkdirSync(base);
    const input = path.join(base, 'source.mp4');
    await runMediaProcess('ffmpeg', ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '40', '-sc_threshold', '0', '-bf', '0', '-output_ts_offset', '7', input], { needs: { ffmpeg: 1 } });
    const timestamps = await extractKeyframesHybrid({ tempVideoPath: input, tempVideoFilename: 'source.mp4', baseTempDir: base, totalDuration: 6, requestHash: 'offline-fixture' });
    assert.deepEqual(timestamps, [0, 1.5, 3, 4]);
    assert.deepEqual(fs.readdirSync(base).filter(name => /^frame-/.test(name)).sort(), ['frame-0001.jpg', 'frame-0002.jpg', 'frame-0003.jpg', 'frame-0004.jpg']);
});

test('audio language detector fails conservatively and cleans samples after a Whisper spawn failure', async () => {
    const input = path.join(directory, 'audio.wav');
    await runMediaProcess('ffmpeg', ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', input], { needs: { ffmpeg: 1 } });
    const { detectLanguage } = require('../modules/audioLanguageDetector');
    assert.equal(await detectLanguage(input, 12, 'offline-language-fixture'), 'unknown');
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('slice_')), false);
});
