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
    // 30fps source PTS can quantize a 2s boundary to 2033ms after seek.
    assert.equal(findCoverageHoles([{ timestampMs: 4100 }, { timestampMs: 6133 }], 7000).includes(5600), false);
    assert.equal(findCoverageHoles([{ timestampMs: 4100 }, { timestampMs: 6201 }], 7000).includes(5600), true);
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

const { chooseExtractionStrategy, inspectKeyTimeline } = require('../modules/frameExtraction');
test('adaptive cost scales with duration and unsafe clocks always use full decoding', () => {
    assert.equal(chooseExtractionStrategy(600000, 3, true), 'key-seek');
    assert.equal(chooseExtractionStrategy(600000, 12, true), 'key-seek');
    assert.equal(chooseExtractionStrategy(600000, 60, true), 'single-pass');
    assert.equal(chooseExtractionStrategy(600000, 180, true), 'single-pass');
    assert.equal(chooseExtractionStrategy(10000, 12, true), 'single-pass');
    assert.equal(chooseExtractionStrategy(600000, 0, false), 'single-pass');
});
test('key preflight rejects substituted DTS, reordered PTS, missing metadata and codec warnings', () => {
    const metadata = { streams: [{ time_base: '1/1000' }], frames: [7000, 7500, 9000].map(pts => ({ key_frame: 1, pts, best_effort_timestamp: pts })) };
    assert.deepEqual(inspectKeyTimeline(metadata, '', 7000, 4000), { safe: true, points: [{ sourcePtsMs: 7000, timestampMs: 0 }, { sourcePtsMs: 9000, timestampMs: 2000 }] });
    for (const frames of [
        [{ key_frame: 1, pts: 23023, best_effort_timestamp: 26485 }],
        [metadata.frames[2], metadata.frames[0]],
        [{ key_frame: 1, best_effort_timestamp: 0 }], [],
    ]) assert.equal(inspectKeyTimeline({ ...metadata, frames }, '', 7000, 4000).safe, false);
    assert.equal(inspectKeyTimeline(metadata, 'illegal short term buffer state detected', 7000, 4000).safe, false);
});
test('showinfo integer PTS avoids precision loss in long-video printed timestamps', () => {
    const parser = createShowinfoParser();
    parser.push(Buffer.from('config in time_base: 1/90000, frame_rate: 30/1\nn: 0 pts: 900003000 pts_time:10000 iskey:1\n'));
    assert.equal(parser.end().get(0), 10000033);
    assert.equal(parser.keyframes.has(0), true);
});
test('static B-frame video keeps real two-second evidence and keys in one full decode', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-static-'));
    try {
        const input = path.join(dir, 'source.mp4');
        await runMediaProcess('ffmpeg', ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:size=160x90:rate=30:duration=12',
            '-c:v', 'libx264', '-g', '90', '-sc_threshold', '0', '-bf', '3', '-output_ts_offset', '7', input], { needs: { ffmpeg: 1 } });
        let decodes = 0;
        const result = await extractFrames({ inputPath: input, outputDir: path.join(dir, 'frames'), durationMs: 12000, strategy: 'single-pass',
            run: (file, args, opts) => { if (file === 'ffmpeg') { decodes++; assert.deepEqual(opts.needs, { ffmpeg: 1, fullDecode: 1 }); } return runMediaProcess(file, args, opts); } });
        assert.equal(decodes, 1);
        assert.equal(result.strategy, 'single-pass');
        assert.equal(result.ready, true);
        assert.deepEqual(result.frames.map(f => f.timestampMs), [0, 2000, 3000, 4000, 6000, 8000, 9000, 10000]);
        assert.deepEqual(result.frames.filter(f => f.sourceKind === 'keyframe').map(f => f.timestampMs), [0, 3000, 6000, 9000]);
        assert.equal(new Set(result.frames.map(f => f.sourcePtsMs)).size, result.frames.length);
        assert.equal(new Set(result.frames.map(f => f.checksum)).size, 1); // Repeated pixels still need distinct source timestamps.
        const repeated = await extractFrames({ inputPath: input, outputDir: path.join(dir, 'frames'), durationMs: 12000, strategy: 'single-pass' });
        assert.deepEqual(repeated.frames, result.frames);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('unsafe metadata falls back before publishing keys; cancellation cleans staging and permits', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-fallback-'));
    try {
        const input = path.join(dir, 'source.mp4');
        await runMediaProcess('ffmpeg', ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=6',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-bf', '0', input], { needs: { ffmpeg: 1 } });
        let keysDecoded = 0;
        const result = await extractFrames({ inputPath: input, outputDir: path.join(dir, 'fallback'), durationMs: 6000, strategy: 'key-seek',
            run: (file, args, opts) => {
                if (file === 'ffprobe' && args.includes('-show_frames')) return Promise.resolve({ stdout: '{"frames":[]}', stderr: '' });
                if (file === 'ffmpeg' && args.includes('-skip_frame')) keysDecoded++;
                return runMediaProcess(file, args, opts);
            } });
        assert.equal(keysDecoded, 0);
        assert.equal(result.strategy, 'single-pass');
        assert.equal(result.fallbackReason, 'unsafe-key-timeline');
        assert.equal(result.ready, true);
        const controller = new AbortController();
        await assert.rejects(extractFrames({ inputPath: input, outputDir: path.join(dir, 'aborted'), durationMs: 6000, signal: controller.signal,
            run: (file, args, opts) => { if (file === 'ffmpeg') controller.abort(); return runMediaProcess(file, args, opts); } }), { name: 'AbortError' });
        assert.deepEqual(await fs.readdir(path.join(dir, 'aborted')), []);
        const { mediaResourceLimiter } = require('../modules/mediaResourceLimiter');
        assert.ok(Object.values(mediaResourceLimiter.snapshot().used).every(value => value === 0));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('key decoder/preflight mismatch falls back without publishing the mismatched timeline', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-key-mismatch-'));
    try {
        const input = path.join(dir, 'source.mp4');
        await runMediaProcess('ffmpeg', ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=6',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-bf', '0', input], { needs: { ffmpeg: 1 } });
        let fullDecodes = 0;
        const published = [];
        const result = await extractFrames({ inputPath: input, outputDir: path.join(dir, 'frames'), durationMs: 6000, strategy: 'key-seek', onFrame: frame => published.push(frame),
            run: async (file, args, opts) => {
                if (opts.needs.fullDecode) fullDecodes++;
                const output = await runMediaProcess(file, args, opts);
                if (file === 'ffprobe' && args.includes('-show_frames')) {
                    const metadata = JSON.parse(output.stdout);
                    metadata.frames[0].pts += 100;
                    metadata.frames[0].best_effort_timestamp = metadata.frames[0].pts;
                    output.stdout = JSON.stringify(metadata);
                }
                return output;
            } });
        assert.equal(fullDecodes, 1);
        assert.equal(result.fallbackReason, 'key-output-mismatch');
        assert.equal(result.ready, true);
        assert.deepEqual(published.map(f => f.timestampMs), [0, 2000, 4000]);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('rational rounding preserves exact half-millisecond PTS, including negative origins', () => {
    const { ptsToMilliseconds } = require('../modules/frameExtraction');
    assert.equal(ptsToMilliseconds(612612, 1, 24000), 25526);
    assert.equal(ptsToMilliseconds(-12, 1, 24000), 0);
    assert.equal(ptsToMilliseconds(-36, 1, 24000), -1);
    const parser = createShowinfoParser();
    parser.push(Buffer.from('config in time_base: 1/24000, frame_rate: 24000/1001\nn: 0 pts: 612612 pts_time:25.5255 iskey:1\n'));
    assert.equal(parser.end().get(0), 25526);
});
