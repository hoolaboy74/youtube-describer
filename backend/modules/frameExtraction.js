'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { StringDecoder } = require('node:string_decoder');
const { runMediaProcess } = require('./mediaResourceLimiter');

// Source PTS is rounded to milliseconds.  A 30fps source can therefore turn
// an intended 2s boundary into 2033ms after a seek/backfill, which is still
// fully covered at the selected sampling cadence.
const COVERAGE_GAP_MS = 2000;
const PTS_ROUNDING_HEADROOM_MS = 100;

// Round rational source ticks once. Floating-point multiplication can move an
// exact half-millisecond boundary down by 1ms (observed in a 1/24000 stream).
function ptsToMilliseconds(pts, num, den) {
    if (![pts, num, den].every(Number.isSafeInteger) || num <= 0 || den <= 0) throw new Error('Invalid source time base');
    const shifted = BigInt(pts) * BigInt(num) * 2000n + BigInt(den);
    const divisor = BigInt(den) * 2n;
    let rounded = shifted / divisor;
    if (shifted < 0 && shifted % divisor !== 0n) rounded--;
    const value = Number(rounded);
    if (!Number.isSafeInteger(value)) throw new Error('Invalid source timestamp');
    return value;
}

// Buffer lines across arbitrary stderr chunks; never derive PTS from file order.
function createShowinfoParser() {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const frames = new Map();
    const keyframes = new Set();
    let timeBase;
    function consume(line) {
        const config = line.match(/config in time_base:\s*(\d+)\/(\d+)/);
        if (config) timeBase = [Number(config[1]), Number(config[2])];
        const match = line.match(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.eE+-]+)/);
        if (!match) return;
        const index = Number(match[1]);
        const sourcePtsMs = timeBase ? ptsToMilliseconds(Number(match[2]), ...timeBase) : Math.round(Number(match[3]) * 1000);
        if (!Number.isSafeInteger(sourcePtsMs) || frames.has(index)) throw new Error('Invalid or duplicate frame PTS');
        frames.set(index, sourcePtsMs);
        if (/\biskey:\s*1\b/.test(line)) keyframes.add(index);
    }
    return {
        keyframes,
        push(chunk) {
            pending += decoder.write(chunk);
            const lines = pending.split(/\r?\n/); pending = lines.pop();
            if (pending.length > 65536) throw new Error('FFmpeg line limit exceeded');
            for (const line of lines) consume(line);
        },
        end() { consume(pending + decoder.end()); return frames; },
    };
}
function findCoverageHoles(frames, durationMs) {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error('Invalid media duration');
    if (!Array.isArray(frames) || frames.some(f => !Number.isSafeInteger(f.timestampMs) || f.timestampMs < 0)) throw new Error('Invalid frame timestamp');
    const points = frames.map(f => f.timestampMs).sort((a, b) => a - b);
    const holes = [];
    if (!points.length) {
        for (let t = 0; t < durationMs; t += 1500) holes.push(t);
        return holes;
    }
    if (points[0] > 1000) {
        holes.push(0);
        for (let t = 1500; points[0] - (t - 1500) > COVERAGE_GAP_MS + PTS_ROUNDING_HEADROOM_MS; t += 1500) holes.push(t);
    }
    // Leave seek/PTS rounding headroom while enforcing actual adjacent gaps.
    for (let i = 0; i < points.length; i++) {
        const end = i + 1 < points.length ? points[i + 1] : durationMs;
        for (let t = points[i]; end - t > COVERAGE_GAP_MS + PTS_ROUNDING_HEADROOM_MS;) {
            t += 1500;
            holes.push(t);
        }
    }
    return holes;
}

// Conservative cost estimate from the 600s sparse-GOP benchmark. The crossover
// scales with duration, rather than assuming one backfill count fits all videos.
function chooseExtractionStrategy(durationMs, backfillCount, safeKeyTimeline) {
    if (!safeKeyTimeline) return 'single-pass';
    const seconds = durationMs / 1000;
    return backfillCount * 0.11 <= seconds * 0.01 + 0.3 ? 'key-seek' : 'single-pass';
}

function inspectKeyTimeline(metadata, stderr, originPtsMs, durationMs) {
    const stream = metadata.streams?.[0];
    const [num, den] = String(stream?.time_base).split('/').map(Number);
    if (!(num > 0 && den > 0) || !metadata.frames?.length || /illegal short term buffer|error|invalid/i.test(stderr || '')) return { safe: false, points: [] };
    const points = [];
    let previous = -Infinity, selected = -Infinity;
    for (const frame of metadata.frames) {
        if (frame.key_frame !== 1 || !Number.isSafeInteger(frame.pts) || frame.pts !== frame.best_effort_timestamp || frame.pts <= previous) return { safe: false, points: [] };
        previous = frame.pts;
        const sourcePtsMs = ptsToMilliseconds(frame.pts, num, den);
        const timestampMs = sourcePtsMs - originPtsMs;
        if (timestampMs < 0 || timestampMs >= durationMs || sourcePtsMs - selected < 1000) continue;
        selected = sourcePtsMs;
        points.push({ sourcePtsMs, timestampMs });
    }
    return { safe: points.length > 0, points };
}

async function extractFrames({ inputPath, outputDir, durationMs, signal, onFrame, priorityTimestampMs = 0, strategy = 'auto', run = runMediaProcess }) {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 24 * 3600 * 1000) throw new Error('Invalid media duration');
    if (!['auto', 'key-seek', 'single-pass'].includes(strategy)) throw new Error('Invalid extraction strategy');
    const started = performance.now();
    await fs.mkdir(outputDir, { recursive: true });
    const staging = await fs.mkdtemp(path.join(outputDir, '.extract-'));
    const frames = new Map();
    try {
        const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time,start_pts,time_base', '-of', 'json', inputPath],
            { needs: { ffmpeg: 1 }, signal, timeoutMs: 15000 });
        const startTime = JSON.parse(probe.stdout).streams?.[0]?.start_time;
        if (startTime === undefined || !Number.isFinite(Number(startTime))) throw new Error('Missing source stream origin');
        const stream = JSON.parse(probe.stdout).streams[0];
        const originTimeBase = String(stream.time_base).split('/').map(Number);
        const originPtsMs = Number.isSafeInteger(stream.start_pts) && originTimeBase.length === 2
            ? ptsToMilliseconds(stream.start_pts, ...originTimeBase) : Math.round(Number(startTime) * 1000);
        const publish = async (file, sourcePtsMs, sourceKind) => {
            if (signal?.aborted) throw Object.assign(new Error('Frame extraction aborted'), { name: 'AbortError' });
            const timestampMs = sourcePtsMs - originPtsMs;
            if (timestampMs < 0 || timestampMs >= durationMs) return;
            if (frames.has(sourcePtsMs)) return;
            const stat = await fs.stat(file);
            if (!stat.isFile() || stat.size <= 0 || stat.size > 5 * 1024 * 1024) throw new Error('Invalid frame file size');
            const buffer = await fs.readFile(file);
            // Decode, rather than trusting an image header or extension.
            const { info } = await sharp(buffer, { failOn: 'warning' }).raw().toBuffer({ resolveWithObject: true });
            if (info.width !== 640 || info.height < 1) throw new Error('Invalid frame dimensions');
            const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
            const finalPath = path.join(outputDir, `pts-${sourcePtsMs}-${checksum}.jpg`);
            await fs.rename(file, finalPath);
            const frame = { path: finalPath, sourcePtsMs, originPtsMs, timestampMs, sourceKind, checksum, width: info.width, height: info.height };
            frames.set(sourcePtsMs, frame);
            await onFrame?.(frame);
        };
        let timeline = { safe: false, points: [] };
        try {
            const metadata = await run('ffprobe', ['-v', 'warning', '-skip_frame', 'nokey', '-select_streams', 'v:0',
                '-show_frames', '-show_entries', 'frame=pts,best_effort_timestamp,key_frame:stream=time_base', '-of', 'json', inputPath],
                { needs: { ffmpeg: 1 }, signal, timeoutMs: 180000, maxOutputBytes: 16 * 1024 * 1024 });
            timeline = inspectKeyTimeline(JSON.parse(metadata.stdout), metadata.stderr, originPtsMs, durationMs);
        } catch (error) {
            if (error.name === 'AbortError' || signal?.aborted) throw error;
            // Unsupported/missing original key PTS must never reach publication.
        }
        const predictedHoles = timeline.safe ? findCoverageHoles(timeline.points, durationMs) : [];
        let selectedStrategy = strategy === 'auto' ? chooseExtractionStrategy(durationMs, predictedHoles.length, timeline.safe) : strategy;
        if (!timeline.safe) selectedStrategy = 'single-pass';
        let fallbackReason = timeline.safe ? null : 'unsafe-key-timeline';
        if (selectedStrategy === 'key-seek') {
            const parser = createShowinfoParser();
            const decoded = await run('ffmpeg', ['-hide_banner', '-nostdin', '-copyts', '-skip_frame', 'nokey', '-i', inputPath,
                '-map', '0:v:0', '-vf', "select='isnan(prev_selected_t)+gte(t-prev_selected_t,1)',scale=640:-1,showinfo", '-fps_mode', 'passthrough', '-q:v', '5', path.join(staging, 'key-%08d.jpg')],
                { needs: { ffmpeg: 1 }, signal, timeoutMs: 180000, maxOutputBytes: 16 * 1024 * 1024, disk: { root: outputDir, maxBytes: 1024 ** 3 }, onStderr: chunk => parser.push(chunk) });
            const pts = parser.end();
            const files = (await fs.readdir(staging)).filter(name => /^key-\d{8}\.jpg$/.test(name)).sort();
            // Independently prove the entire key timeline before publishing any JPEG.
            if (files.length !== pts.size || pts.size !== timeline.points.length ||
                timeline.points.some((point, index) => pts.get(index) !== point.sourcePtsMs) ||
                /illegal short term buffer|error|invalid/i.test(decoded.stderr || '')) {
                selectedStrategy = 'single-pass';
                fallbackReason = 'key-output-mismatch';
            } else {
                for (const [index, file] of files.entries()) await publish(path.join(staging, file), pts.get(index), 'keyframe');
            }
        }
        if (selectedStrategy === 'single-pass') {
            const parser = createShowinfoParser();
            const origin = Number(startTime);
            const grid = `if(gte(t-(${origin}),ld(0)*2),st(0,ld(0)+1)*0+1,0)`;
            const expression = `if(eq(key,1)*gte(t-(${origin}),ld(1)),st(1,t-(${origin})+1)*0+if(gte(t-(${origin}),ld(0)*2),st(0,ld(0)+1)*0+1,1),${grid})`;
            await run('ffmpeg', ['-hide_banner', '-nostdin', '-copyts', '-i', inputPath,
                '-map', '0:v:0', '-vf', `select='${expression}',scale=640:-1,showinfo`, '-fps_mode', 'passthrough', '-q:v', '5', path.join(staging, 'sample-%08d.jpg')],
                { needs: { ffmpeg: 1, fullDecode: 1 }, signal, timeoutMs: 240000, maxOutputBytes: 16 * 1024 * 1024,
                    disk: { root: outputDir, maxBytes: 1024 ** 3 }, onStderr: chunk => parser.push(chunk) });
            const pts = parser.end();
            const files = (await fs.readdir(staging)).filter(name => /^sample-\d{8}\.jpg$/.test(name)).sort();
            if (files.length !== pts.size) throw new Error('Frame file/PTS count mismatch');
            let previous = -Infinity;
            for (const [index, file] of files.entries()) {
                const sourcePtsMs = pts.get(index);
                if (!Number.isSafeInteger(sourcePtsMs) || sourcePtsMs <= previous) throw new Error('Invalid full decode timeline');
                previous = sourcePtsMs;
                await publish(path.join(staging, file), sourcePtsMs, parser.keyframes.has(index) ? 'keyframe' : 'backfill');
            }
        }
        const holes = selectedStrategy === 'key-seek' ? findCoverageHoles([...frames.values()], durationMs)
            .sort((a, b) => Math.abs(a - priorityTimestampMs) - Math.abs(b - priorityTimestampMs) || a - b) : [];
        const failedTargets = [];
        // Reserve FFmpeg + backfill atomically; other videos share the same limit.
        for (let i = 0; i < holes.length; i += 2) {
            const outcomes = await Promise.allSettled(holes.slice(i, i + 2).map(async targetMs => {
                const file = path.join(staging, `backfill-${targetMs}.jpg`);
                const parser = createShowinfoParser();
                let sourcePtsMs;
                try {
                    await run('ffmpeg', ['-hide_banner', '-nostdin', '-copyts', '-ss', String(targetMs / 1000), '-i', inputPath,
                        '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=640:-1,showinfo', '-fps_mode', 'passthrough', '-q:v', '5', file],
                        { needs: { ffmpeg: 1, backfill: 1 }, signal, priority: 10, timeoutMs: 30000, disk: { root: staging, maxBytes: 16 * 1024 * 1024 }, onStderr: chunk => parser.push(chunk) });
                    const pts = parser.end();
                    if (!pts.has(0)) throw new Error('Backfill frame PTS missing');
                    sourcePtsMs = pts.get(0);
                } catch (error) {
                    if (error.name === 'AbortError' || signal?.aborted) throw error;
                    failedTargets.push(targetMs);
                    return;
                }
                await publish(file, sourcePtsMs, 'backfill');
            }));
            const rejected = outcomes.find(outcome => outcome.status === 'rejected');
            if (rejected) throw rejected.reason;
        }
        const sorted = [...frames.values()].sort((a, b) => a.timestampMs - b.timestampMs);
        const coverageHoles = findCoverageHoles(sorted, durationMs);
        return { frames: sorted, coverageHoles, failedTargets, ready: coverageHoles.length === 0 && failedTargets.length === 0,
            strategy: selectedStrategy, predictedBackfills: timeline.safe ? predictedHoles.length : null, fallbackReason, elapsedMs: Math.round(performance.now() - started) };
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
module.exports = { createShowinfoParser, findCoverageHoles, chooseExtractionStrategy, inspectKeyTimeline, ptsToMilliseconds, extractFrames };

// A section's first PTS is NOT the original timeline origin. The downloader
// supplies the independently probed source origin when passing a section.
async function extractFrameWindow({ inputPath, outputDir, startMs, endMs, sourceOriginPtsMs, section = false, signal, run = runMediaProcess }) {
    if (![startMs, endMs].every(Number.isSafeInteger) || startMs < 0 || endMs < startMs || endMs - startMs > 20000) throw new Error('Invalid current window');
    let originPtsMs = sourceOriginPtsMs;
    if (!section) {
        const probe = await run('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=start_time','-of','json',inputPath], { needs: { ffmpeg: 1 }, signal, timeoutMs: 15000 });
        const origin = JSON.parse(probe.stdout).streams?.[0]?.start_time;
        if (origin === undefined || !Number.isFinite(Number(origin))) throw new Error('Missing source origin');
        originPtsMs = Math.round(Number(origin) * 1000);
    }
    if (!Number.isSafeInteger(originPtsMs)) throw new Error('Missing proven section origin');
    await fs.mkdir(outputDir, { recursive: true });
    const parser = createShowinfoParser();
    const from = (startMs + originPtsMs) / 1000, to = (endMs + originPtsMs) / 1000;
    await run('ffmpeg', ['-hide_banner','-nostdin','-copyts', ...(!section ? ['-ss',String(startMs / 1000)] : []), '-i',inputPath,
        '-map','0:v:0','-to',String(to + .001),'-vf',`select='between(t,${from},${to})*(isnan(prev_selected_t)+gte(t-prev_selected_t,0.9))',scale=640:-1,showinfo`,
        '-fps_mode','passthrough','-q:v','5',path.join(outputDir,'window-%08d.jpg')],
        { needs: { ffmpeg: 1 }, signal, priority: 20, timeoutMs: 30000, disk: { root: outputDir, maxBytes: 32 * 1024 * 1024 }, onStderr: b => parser.push(b) });
    const pts = parser.end();
    const result = [];
    for (const [index, sourcePtsMs] of pts) {
        const timestampMs = sourcePtsMs - originPtsMs;
        if (timestampMs < startMs || timestampMs > endMs) continue;
        const file = path.join(outputDir, `window-${String(index + 1).padStart(8,'0')}.jpg`);
        const bytes = await fs.readFile(file);
        const { info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
        result.push({ path: file, sourcePtsMs, originPtsMs, timestampMs, sourceKind: 'window', checksum: crypto.createHash('sha256').update(bytes).digest('hex'), width: info.width, height: info.height });
    }
    if (!result.length) throw new Error('No past frame in current window');
    return result;
}
module.exports.extractFrameWindow = extractFrameWindow;
