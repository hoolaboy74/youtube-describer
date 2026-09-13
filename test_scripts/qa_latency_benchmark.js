#!/usr/bin/env node
'use strict';
// Offline by default. No application/DB imports, credentials, cache deletion or paid calls.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const fixtures = require('../backend/tests/fixtures/qa/benchmark.json');

async function command(file, args) {
    const start = performance.now();
    try {
        const result = await execute(file, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
        return { status: 'passed', elapsedMs: performance.now() - start, ...result };
    } catch (error) {
        return { status: 'failed', elapsedMs: performance.now() - start, code: error.code ?? null,
            stdout: error.stdout || '', stderr: error.stderr || error.message };
    }
}

function ptsFromShowinfo(log) {
    return [...log.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.eE+-]+)/g)].map(match => Number(match[1]));
}
function coverageHoles(pts, start, duration) {
    const holes = [];
    for (let t = start; t < start + duration; t += 2) {
        if (!pts.some(p => Math.abs(p - t) <= 1 + 1e-6)) holes.push(t);
    }
    return holes;
}
function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function summarize(records) {
    if (!Array.isArray(records)) throw new Error('Expected an array of browser records');
    const groups = new Map();
    for (const r of records) {
        if (r.schemaVersion !== 1 || !r.requestId || !r.timings || typeof r.status !== 'string'
            || !Number.isInteger(r.historyTurns) || r.historyTurns < 0 || !Number.isFinite(r.timestamp)) {
            throw new Error('Invalid benchmark record');
        }
        for (const value of Object.values(r.timings)) {
            if (!Number.isFinite(value) || value < 0) throw new Error('Invalid monotonic timing');
        }
        if (r.status === 'played' && !Number.isFinite(r.timings.firstPlaying)) throw new Error('played requires firstPlaying');
        const key = JSON.stringify([r.implementation, r.run, r.fixture, r.cacheState, r.device, r.audioMode, r.historyTurns, r.timestamp]);
        if (!groups.has(key)) groups.set(key, { dimensions: JSON.parse(key), samples: 0, statuses: {}, firstPlaying: [], firstText: [], seen: new Set() });
        const g = groups.get(key);
        if (g.seen.has(r.requestId)) throw new Error('Duplicate request sample');
        g.seen.add(r.requestId);
        g.samples++;
        g.statuses[r.status] = (g.statuses[r.status] || 0) + 1;
        if (r.status === 'played') g.firstPlaying.push(r.timings.firstPlaying);
        if (Number.isFinite(r.timings.firstText)) g.firstText.push(r.timings.firstText);
    }
    return [...groups.values()].map(g => ({
        dimensions: g.dimensions, samples: g.samples, statuses: g.statuses,
        playedSamples: g.firstPlaying.length, unplayedSamples: g.samples - g.firstPlaying.length,
        firstPlayingMs: { p50: percentile(g.firstPlaying, .5), p95: percentile(g.firstPlaying, .95) },
        firstTextMs: { p50: percentile(g.firstText, .5), p95: percentile(g.firstText, .95) },
    }));
}

async function environment() {
    const versions = { node: process.version, platform: `${process.platform}/${process.arch}` };
    for (const [name, args] of [['ffmpeg', ['-version']], ['ffprobe', ['-version']], ['yt-dlp', ['--version']]]) {
        const result = await command(name, args);
        versions[name] = { status: result.status, version: result.status === 'passed' ? result.stdout.split('\n')[0] : null,
            error: result.status === 'failed' ? result.stderr.trim().split('\n').slice(-1)[0] : null };
    }
    for (const name of ['@google/generative-ai', '@google-cloud/text-to-speech']) {
        try { versions[name] = JSON.parse(await fs.readFile(path.join(root, 'backend/node_modules', name, 'package.json'), 'utf8')).version; }
        catch { versions[name] = 'not-installed'; }
    }
    return versions;
}

async function mediaBenchmark() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-pts-benchmark-'));
    const results = [];
    try {
        for (const fixture of fixtures.media) {
            const input = path.join(directory, `${fixture.id}.mp4`);
            const filter = fixture.vfr ? "select='if(lt(t,8),not(mod(n,2)),not(mod(n,5)))'" : 'null';
            const generated = await command('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=10:duration=${fixture.duration}`,
                '-vf', filter, '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(fixture.gop), '-keyint_min', String(fixture.gop),
                '-sc_threshold', '0', '-bf', '0', '-output_ts_offset', String(fixture.offset), input]);
            if (generated.status !== 'passed') {
                results.push({ fixture: fixture.id, status: 'failed', stage: 'generate', error: generated.stderr });
                continue;
            }
            const probe = await command('ffprobe', ['-v', 'error', '-skip_frame', 'nokey', '-select_streams', 'v:0', '-show_frames',
                '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', input]);
            if (probe.status !== 'passed') {
                results.push({ fixture: fixture.id, status: 'failed', stage: 'probe', error: probe.stderr });
                continue;
            }
            const sourcePts = JSON.parse(probe.stdout).frames.map(f => Number(f.best_effort_timestamp_time));
            for (const mode of ['legacy-fps', 'source-pts']) {
                const vf = mode === 'legacy-fps' ? 'fps=1/2,scale=160:-2,showinfo' : 'scale=160:-2,showinfo';
                const extraction = await command('ffmpeg', ['-hide_banner', '-copyts', '-skip_frame', 'nokey', '-i', input,
                    '-vf', vf, '-fps_mode', 'passthrough', '-an', '-f', 'null', '-']);
                const pts = ptsFromShowinfo(extraction.stderr);
                const inventedPts = pts.filter(t => !sourcePts.some(p => Math.abs(p - t) < .001));
                results.push({ fixture: fixture.id, mode, status: extraction.status, elapsedMs: extraction.elapsedMs,
                    sourcePts, outputPts: pts, inventedPts,
                    coverageHoles: coverageHoles(pts, fixture.offset, fixture.duration),
                    sourceCoverageHoles: coverageHoles(sourcePts, fixture.offset, fixture.duration),
                    exactSourceMatch: JSON.stringify(pts) === JSON.stringify(sourcePts),
                    ...(extraction.status === 'failed' ? { error: extraction.stderr } : {}) });
            }
        }
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
    return { schemaVersion: 1, kind: 'local-synthetic-media', environment: await environment(), results,
        limitations: ['Extraction to null sink measures PTS, not JPEG disk throughput or YouTube download latency.',
            'No browser playback, provider latency or production performance claim.'] };
}

async function main(args) {
    const [mode, input] = args;
    if (mode === 'environment') return environment();
    if (mode === 'media') return mediaBenchmark();
    if (mode === 'summarize' && input) return { dimensionOrder: ['implementation', 'run', 'fixture', 'cacheState', 'device', 'audioMode', 'historyTurns', 'timestamp'],
        percentileMethod: 'nearest-rank, played samples only; all failures counted separately', groups: summarize(JSON.parse(await fs.readFile(input, 'utf8'))) };
    if (mode === 'matrix') return fixtures;
    throw new Error('Usage: node test_scripts/qa_latency_benchmark.js environment|media|matrix|summarize <records.json>');
}
if (require.main === module) main(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
});
module.exports = { ptsFromShowinfo, coverageHoles, percentile, summarize, mediaBenchmark };
