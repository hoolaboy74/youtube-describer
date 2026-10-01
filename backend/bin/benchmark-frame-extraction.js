'use strict';
// Uses downloaded fixtures only. No QA storage, AI calls or application DB.
// node bin/benchmark-frame-extraction.js FIXTURE_ROOT OUTPUT_ROOT [REPETITIONS]
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { extractFrames } = require('../modules/frameExtraction');
const { runMediaProcess } = require('../modules/mediaResourceLimiter');
const [fixtureRoot, outputRoot, repetitionArg = '3'] = process.argv.slice(2);
const repetitions = Number(repetitionArg);
const cases = ['orchestra', 'choir', 'music-video', 'long-talk', 'sparse-3', 'sparse-12', 'sparse-60', 'sparse-180'];
async function verify(input, output, result) {
    const targets = result.frames.map(f => f.sourcePtsMs);
    function member(lo, hi) {
        if (lo === hi) return `between(t*1000,${targets[lo] - .51},${targets[lo] + .51})`;
        const mid = Math.floor((lo + hi) / 2);
        return `if(lt(t*1000,${(targets[mid] + targets[mid + 1]) / 2}),${member(lo, mid)},${member(mid + 1, hi)})`;
    }
    await fs.mkdir(output, { recursive: true });
    const filter = path.join(output, 'filter.txt');
    await fs.writeFile(filter, `select='${member(0, targets.length - 1)}',scale=640:-1,showinfo`);
    const probe = await runMediaProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base', '-of', 'json', input], { needs: { ffmpeg: 1 } });
    const [num, den] = JSON.parse(probe.stdout).streams[0].time_base.split('/').map(Number);
    const raw = new Map();
    let pending = '';
    await runMediaProcess('ffmpeg', ['-hide_banner', '-nostdin', '-copyts', '-i', input, '-map', '0:v:0', '-filter_script:v', filter,
        '-fps_mode', 'passthrough', '-q:v', '5', path.join(output, 'ref-%08d.jpg')], {
        needs: { ffmpeg: 1, fullDecode: 1 }, timeoutMs: 240000, maxOutputBytes: 16 * 1024 * 1024,
        disk: { root: output, maxBytes: 1024 ** 3 },
        onStderr(chunk) {
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/); pending = lines.pop();
            for (const line of lines) {
                const match = line.match(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:/);
                if (match) raw.set(Number(match[1]), Math.round(Number(match[2]) * num * 1000 / den));
            }
        },
    });
    const hashes = new Map();
    for (const [index, pts] of raw) {
        const bytes = await fs.readFile(path.join(output, `ref-${String(index + 1).padStart(8, '0')}.jpg`));
        hashes.set(pts, crypto.createHash('sha256').update(bytes).digest('hex'));
    }
    await fs.writeFile(path.join(output, 'reference-map.json'), JSON.stringify([...hashes]));
    const matched = result.frames.filter(f => hashes.get(f.sourcePtsMs) === f.checksum).length;
    if (matched !== result.frames.length) console.error(JSON.stringify(result.frames.filter(f => hashes.get(f.sourcePtsMs) !== f.checksum)));
    if (matched !== result.frames.length) throw new Error(`Independent source verification failed: ${matched}/${result.frames.length}`);
    return { matched, total: result.frames.length, timestampErrorMs: 0 };
}
(async () => {
    if (!fixtureRoot || !outputRoot || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('Usage: benchmark-frame-extraction.js FIXTURE_ROOT OUTPUT_ROOT [1..10]');
    await fs.mkdir(outputRoot, { recursive: true });
    const summaries = [];
    const selectedCases = process.env.BENCH_CASES ? process.env.BENCH_CASES.split(',') : cases;
    for (const name of selectedCases) {
        const input = path.join(fixtureRoot, name, 'source.mp4');
        const probe = await runMediaProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input], { needs: { ffmpeg: 1 } });
        const durationMs = Math.round(Number(JSON.parse(probe.stdout).format.duration) * 1000);
        const runs = [];
        let first;
        for (let i = 0; i < repetitions; i++) {
            const out = path.join(outputRoot, name, `r${i + 1}`);
            let ffmpegCalls = 0;
            const result = await extractFrames({ inputPath: input, outputDir: out, durationMs,
                run: (file, args, opts) => { if (file === 'ffmpeg') ffmpegCalls++; return runMediaProcess(file, args, opts); } });
            if (!result.ready) throw new Error(`Incomplete coverage: ${name}`);
            const frames = result.frames.map(({ path: unused, ...frame }) => frame);
            if (first && JSON.stringify(first.frames.map(f => [f.sourcePtsMs, f.checksum])) !== JSON.stringify(frames.map(f => [f.sourcePtsMs, f.checksum]))) throw new Error(`Non-deterministic frames: ${name}`);
            const run = { ...result, frames, ffmpegCalls };
            await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(run, null, 2));
            first ||= run;
            runs.push({ elapsedMs: result.elapsedMs, strategy: result.strategy, predictedBackfills: result.predictedBackfills, fallbackReason: result.fallbackReason, frameCount: frames.length, ffmpegCalls });
        }
        const verified = await verify(input, path.join(outputRoot, name, 'reference'), first);
        const summary = { name, durationMs, runs, medianMs: runs.map(r => r.elapsedMs).sort((a, b) => a - b)[Math.floor(runs.length / 2)], verified };
        summaries.push(summary);
        await fs.writeFile(path.join(outputRoot, 'summary.json'), JSON.stringify(summaries, null, 2));
        console.log(JSON.stringify(summary));
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
