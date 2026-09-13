'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { StringDecoder } = require('node:string_decoder');
const { runMediaProcess } = require('./mediaResourceLimiter');

// Buffer lines across arbitrary stderr chunks; never derive PTS from file order.
function createShowinfoParser() {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const frames = new Map();
    function consume(line) {
        const match = line.match(/\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.eE+-]+)/);
        if (!match) return;
        const index = Number(match[1]);
        const sourcePtsMs = Math.round(Number(match[2]) * 1000);
        if (!Number.isSafeInteger(sourcePtsMs) || frames.has(index)) throw new Error('Invalid or duplicate frame PTS');
        frames.set(index, sourcePtsMs);
    }
    return {
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
    let i = 0;
    for (let t = 0; t < durationMs; t += 2000) {
        while (i < points.length && points[i] < t - 1000) i++;
        if (i === points.length || points[i] > t + 1000) holes.push(t);
    }
    return holes;
}

async function extractFrames({ inputPath, outputDir, durationMs, signal, onFrame, priorityTimestampMs = 0, run = runMediaProcess }) {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 24 * 3600 * 1000) throw new Error('Invalid media duration');
    await fs.mkdir(outputDir, { recursive: true });
    const staging = await fs.mkdtemp(path.join(outputDir, '.extract-'));
    const frames = new Map();
    try {
        const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time', '-of', 'json', inputPath],
            { needs: { ffmpeg: 1 }, signal, timeoutMs: 15000 });
        const startTime = JSON.parse(probe.stdout).streams?.[0]?.start_time;
        if (startTime === undefined || !Number.isFinite(Number(startTime))) throw new Error('Missing source stream origin');
        const originPtsMs = Math.round(Number(startTime) * 1000);
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
        const parser = createShowinfoParser();
        await run('ffmpeg', ['-hide_banner', '-nostdin', '-copyts', '-skip_frame', 'nokey', '-i', inputPath,
            '-map', '0:v:0', '-vf', 'scale=640:-1,showinfo', '-fps_mode', 'passthrough', '-q:v', '5', path.join(staging, 'key-%08d.jpg')],
            { needs: { ffmpeg: 1 }, signal, timeoutMs: 180000, maxOutputBytes: 16 * 1024 * 1024, disk: { root: outputDir, maxBytes: 1024 ** 3 }, onStderr: chunk => parser.push(chunk) });
        const pts = parser.end();
        const files = (await fs.readdir(staging)).filter(name => /^key-\d{8}\.jpg$/.test(name)).sort();
        if (files.length !== pts.size) throw new Error('Frame file/PTS count mismatch');
        for (const file of files) {
            const index = Number(file.slice(4, 12)) - 1;
            if (!pts.has(index)) throw new Error('Frame PTS missing');
            await publish(path.join(staging, file), pts.get(index), 'keyframe');
        }
        const holes = findCoverageHoles([...frames.values()], durationMs)
            .sort((a, b) => Math.abs(a - priorityTimestampMs) - Math.abs(b - priorityTimestampMs) || a - b);
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
        return { frames: sorted, coverageHoles, failedTargets, ready: coverageHoles.length === 0 && failedTargets.length === 0 };
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
module.exports = { createShowinfoParser, findCoverageHoles, extractFrames };
