#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { runMediaProcess } = require('../backend/modules/mediaResourceLimiter');

// Count actual inbound TLS tunnel bytes, including TLS/HTTP overhead. No traffic
// decryption, URLs, headers, cookies or request bodies are logged.
async function createCountingProxy() {
    const sockets = new Set();
    const counts = { mediaInboundBytes: 0, otherInboundBytes: 0, mediaConnections: 0 };
    const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('connect', (req, client, head) => {
        const [host, port] = req.url.split(':');
        if (port !== '443' || !/(^|\.)(youtube\.com|googlevideo\.com|ytimg\.com|google\.com|ggpht\.com)$/.test(host)) {
            client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
        }
        const media = /(^|\.)googlevideo\.com$/.test(host);
        const upstream = net.connect(443, host);
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        upstream.on('connect', () => {
            if (media) counts.mediaConnections++;
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            client.pipe(upstream);
            upstream.on('data', data => { counts[media ? 'mediaInboundBytes' : 'otherInboundBytes'] += data.length; });
            upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        client.on('close', () => upstream.destroy());
        upstream.setTimeout(20000, () => upstream.destroy());
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { url: `http://127.0.0.1:${server.address().port}`, counts,
        async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
function classifyError(error) {
    const text = error.stderr || '';
    if (/certificate/i.test(text)) return 'certificate';
    if (/confirm.*bot|sign in|login required/i.test(text)) return 'authentication';
    if (/403/.test(text)) return 'http-403';
    return error.code || 'download-failed';
}
function parseFrameHashes(text) {
    const timebase = text.match(/#tb 0:\s*(\d+)\/(\d+)/);
    if (!timebase) throw new Error('Missing frame timebase');
    const scale = Number(timebase[1]) / Number(timebase[2]);
    return text.split('\n').filter(line => /^0,/.test(line)).map(line => {
        const fields = line.split(',').map(f => f.trim());
        return { ptsSeconds: Number(fields[2]) * scale, hash: fields[5] };
    });
}
async function compareFrames(full, section, timestamp) {
    async function hashes(file, seek) {
        const result = await runMediaProcess('ffmpeg', ['-hide_banner', '-nostdin', '-copyts', ...(seek === null ? [] : ['-ss', String(seek)]),
            '-i', file, '-to', String((seek || 0) + 24), '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-f', 'framemd5', '-'],
            { needs: { ffmpeg: 1 }, timeoutMs: 30000, maxOutputBytes: 2 * 1024 * 1024 });
        return parseFrameHashes(result.stdout);
    }
    const original = await hashes(full, Math.max(0, timestamp - 12));
    const clip = await hashes(section, null);
    if (!original.length || !clip.length) throw new Error('No comparable decoded frames');
    const matches = clip.map(frame => ({ sectionPtsSeconds: frame.ptsSeconds,
        sourceCandidates: original.filter(source => source.hash === frame.hash).map(source => source.ptsSeconds) }));
    return { comparedFrames: matches.length, matchedFrames: matches.filter(m => m.sourceCandidates.length).length,
        uniquelyMappedFrames: matches.filter(m => m.sourceCandidates.length === 1).length, matches,
        limitation: 'Identical repeated frames may map to multiple source PTS; never substitute section start + frame index.' };
}
async function main([flag, videoId, time, output]) {
    if (flag !== '--live' || !/^[A-Za-z0-9_-]{11}$/.test(videoId || '') || !Number.isFinite(Number(time)) || Number(time) < 4 || !output) {
        throw new Error('Usage: node test_scripts/qa_download_benchmark.js --live <videoId> <timestamp>=4 <new-output-directory>');
    }
    const timestamp = Number(time);
    const directory = path.resolve(output);
    await fs.mkdir(directory);
    const report = { schemaVersion: 1, videoId, timestamp, startedAt: new Date().toISOString(),
        networkMeasurement: 'Inbound TLS tunnel bytes incl. protocol overhead; metadata separate from googlevideo media. Does not measure unique payload overlap.',
        conditions: { cookies: false, proxy: 'local-counting-connect', format: 'bestvideo[height<=480][ext=mp4]', attemptsPerMode: 1 },
        budget: { downloads: 2, timeoutMsPerDownload: 60000, maxKnownFileBytes: 100 * 1024 * 1024 }, attempts: [] };
    // Override PATH for this process only when the local yt-dlp wrapper needs a newer Python.
    const env = { ...process.env, ...(process.env.QA_BENCHMARK_PATH ? { PATH: process.env.QA_BENCHMARK_PATH } : {}) };
    const version = await runMediaProcess('yt-dlp', ['--version'], { needs: { download: 1 }, timeoutMs: 10000, env });
    report.ytdlpVersion = version.stdout.trim();
    for (const mode of ['full', 'section']) {
        const proxy = await createCountingProxy();
        const start = performance.now();
        const file = path.join(directory, `${mode}.mp4`);
        const args = ['--ignore-config', '--no-playlist', '--no-cache-dir', '--no-progress', '--socket-timeout', '10', '--retries', '0', '--fragment-retries', '0',
            '--extractor-retries', '0', '--max-filesize', '100M', '--proxy', proxy.url, '-f', report.conditions.format,
            '--print', 'before_dl:QA_FORMAT %(format_id)s %(protocol)s', '--no-simulate', '-o', file,
            ...(mode === 'section' ? ['--download-sections', `*${timestamp - 4}-${timestamp + 2}`] : []), `https://www.youtube.com/watch?v=${videoId}`];
        const attempt = { mode, status: 'failed', elapsedMs: null };
        try {
            const result = await runMediaProcess('yt-dlp', args, { needs: { download: 1, fullDownload: 1, ffmpeg: 1 }, timeoutMs: 60000, env, disk: { root: directory, maxBytes: 200 * 1024 * 1024 } });
            const stat = await fs.stat(file);
            attempt.status = stat.size > 0 ? 'passed' : 'empty';
            attempt.fileBytes = stat.size;
            const format = result.stdout.match(/QA_FORMAT (\S+) (\S+)/);
            attempt.formatId = format?.[1] || null; attempt.protocol = format?.[2] || null;
        } catch (error) { attempt.reason = classifyError(error); }
        finally { attempt.elapsedMs = performance.now() - start; await proxy.close(); }
        Object.assign(attempt, proxy.counts);
        report.attempts.push(attempt);
        await fs.writeFile(path.join(directory, 'download-results.json'), JSON.stringify(report, null, 2));
    }
    if (report.attempts.every(a => a.status === 'passed') && report.attempts[0].formatId === report.attempts[1].formatId) {
        try { report.frameComparison = await compareFrames(path.join(directory, 'full.mp4'), path.join(directory, 'section.mp4'), timestamp); }
        catch (error) { report.frameComparison = { status: 'failed', reason: classifyError(error) }; }
    }
    report.decision = report.attempts.every(a => a.status === 'passed') && report.frameComparison?.comparedFrames > 0 && report.frameComparison.matchedFrames === report.frameComparison.comparedFrames && report.attempts[1].elapsedMs < report.attempts[0].elapsedMs
        ? 'section-faster-in-this-single-sample' : 'retain-shared-full-download-fallback';
    await fs.writeFile(path.join(directory, 'download-results.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
}
if (require.main === module) main(process.argv.slice(2)).then(report => console.log(JSON.stringify({ attempts: report.attempts, decision: report.decision }, null, 2))).catch(error => {
    console.error(JSON.stringify({ name: error.name, code: error.code || 'probe-failed' })); process.exitCode = 1;
});
module.exports = { parseFrameHashes, classifyError, createCountingProxy, compareFrames };
