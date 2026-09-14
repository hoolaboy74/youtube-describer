const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createShowinfoParser, findCoverageHoles, extractFrames } = require('../modules/frameExtraction');
const { runMediaProcess } = require('../modules/mediaResourceLimiter');

test('showinfo parser preserves PTS across byte boundaries and rejects duplicate indices', () => {
    const parser = createShowinfoParser();
    for (const byte of Buffer.from('[showinfo] n: 0 pts: 7000 pts_time:7\n[showinfo] n: 1 pts: 7200 pts_time:7.2')) parser.push(Buffer.from([byte]));
    assert.deepEqual([...parser.end()], [[0, 7000], [1, 7200]]);
    const invalid = createShowinfoParser();
    assert.throws(() => invalid.push(Buffer.from('n: 0 pts: 0 pts_time:0\nn: 0 pts: 1 pts_time:1\n')));
});
test('coverage measures adjacent gaps and video boundaries', () => {
    assert.deepEqual(findCoverageHoles([{ timestampMs: 0 }, { timestampMs: 8000 }], 10000), [1500, 3000, 4500, 6000]);
    assert.deepEqual(findCoverageHoles([{ timestampMs: 1000 }, { timestampMs: 3000 }], 4000), []);
    assert.deepEqual(findCoverageHoles([{ timestampMs: 1000 }, { timestampMs: 4000 }], 5000), [2500]);
    assert.deepEqual(findCoverageHoles([{ timestampMs: 1500 }], 5000), [0, 3000]);
    assert.deepEqual(findCoverageHoles([{ timestampMs: 5000 }], 6000), [0, 1500, 3000]);
});

test('real VFR media: keyframes published before exact backfill, PTS remains proven and replayable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-frame-test-'));
    try {
        const input = path.join(dir, 'source.mp4');
        await runMediaProcess('ffmpeg', ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=12',
            '-vf', "select='if(lt(t,6),not(mod(n,2)),not(mod(n,5)))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast',
            '-g', '40', '-sc_threshold', '0', '-bf', '0', '-output_ts_offset', '7', input], { needs: { ffmpeg: 1 } });
        const probe = await runMediaProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', input], { needs: { ffmpeg: 1 } });
        const original = JSON.parse(probe.stdout).frames.map(f => Math.round(Number(f.best_effort_timestamp_time) * 1000));
        const published = [];
        const result = await extractFrames({ inputPath: input, outputDir: path.join(dir, 'frames'), durationMs: 12000, onFrame: f => published.push(f.sourceKind) });
        assert.equal(result.ready, true);
        assert.deepEqual(result.coverageHoles, []);
        assert.ok(result.frames.some(f => f.sourceKind === 'backfill'));
        assert.equal(published[0], 'keyframe');
        for (const frame of result.frames) {
            assert.ok(original.includes(frame.sourcePtsMs), `invented timestamp ${frame.sourcePtsMs}`);
            assert.equal(frame.timestampMs, frame.sourcePtsMs - 7000);
            assert.equal(frame.width, 640);
            assert.match(frame.checksum, /^[a-f0-9]{64}$/);
        }
        const repeated = await extractFrames({ inputPath: input, outputDir: path.join(dir, 'frames'), durationMs: 12000 });
        assert.deepEqual(repeated.frames, result.frames);
        assert.equal((await fs.readdir(path.join(dir, 'frames'))).some(f => f.startsWith('.extract-')), false);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('failed backfills retain usable keys without marking complete; publication failures propagate', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-frame-failure-'));
    try {
        const input = path.join(dir, 'source.mp4');
        await runMediaProcess('ffmpeg', ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=6',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '80', '-sc_threshold', '0', '-bf', '0', input], { needs: { ffmpeg: 1 } });
        const partial = await extractFrames({ inputPath: input, outputDir: path.join(dir, 'partial'), durationMs: 6000,
            run: (file, args, opts) => opts.needs.backfill ? Promise.reject(new Error('injected FFmpeg failure')) : runMediaProcess(file, args, opts) });
        assert.equal(partial.ready, false);
        assert.ok(partial.frames.length > 0);
        assert.ok(partial.failedTargets.length > 0);
        await assert.rejects(extractFrames({ inputPath: input, outputDir: path.join(dir, 'stale'), durationMs: 6000,
            onFrame: frame => { if (frame.sourceKind === 'backfill') throw Object.assign(new Error('stale worker'), { code: 'STALE_CACHE_LEASE' }); } }), { code: 'STALE_CACHE_LEASE' });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


test('all-intra 30fps source is thinned before JPEG output while preserving source PTS', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-dense-'));
    try {
        const input = path.join(dir, 'dense.mp4');
        await runMediaProcess('ffmpeg', ['-hide_banner','-nostdin','-f','lavfi','-i','testsrc2=size=160x90:rate=30:duration=6',
            '-c:v','libx264','-preset','ultrafast','-g','1','-bf','0',input], {needs:{ffmpeg:1}});
        const result = await extractFrames({inputPath:input,outputDir:path.join(dir,'frames'),durationMs:6000});
        assert.equal(result.ready,true);
        assert.equal(result.frames.length,6);
        assert.deepEqual(result.frames.map(f=>f.timestampMs),[0,1000,2000,3000,4000,5000]);
        assert.equal((await fs.readdir(path.join(dir,'frames'))).length,6);
    } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
