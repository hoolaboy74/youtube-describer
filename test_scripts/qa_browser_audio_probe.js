#!/usr/bin/env node
'use strict';
// Verifies measurement wiring with saved provider audio in headless Chromium.
// This is NOT an iPhone/Android, live streaming, or audible-output benchmark.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('../backend/node_modules/puppeteer');

async function main(directory) {
    if (!directory) throw new Error('Usage: node test_scripts/qa_browser_audio_probe.js <provider-output-directory>');
    const assets = new Map([
        ['/trace.js', { type: 'application/javascript', body: await fs.readFile(path.join(__dirname, '../frontend/src/services/qaLatencyTrace.js')) }],
        ['/sentence.mp3', { type: 'audio/mpeg', body: await fs.readFile(path.join(directory, 'sentence-0.mp3')) }],
        ['/continuous.ogg', { type: 'audio/ogg', body: await fs.readFile(path.join(directory, 'continuous.ogg')) }],
        ['/', { type: 'text/html', body: `<!doctype html><html lang="ko"><title>Q&A 측정 시험</title>
<button id="start">시험 음성 재생</button><audio controls></audio><script type="module">
import { createQaLatencyTrace } from '/trace.js';
window.runProbe = (mode) => {
 sessionStorage.setItem('qaLatencyBenchmark', JSON.stringify({enabled:true, fixture:'saved-provider-audio', device:'headless-chromium', cacheState:'warm',run:'instrumentation-only'}));
 document.querySelector('button').onclick = async () => {
  const trace = createQaLatencyTrace({ requestId: crypto.randomUUID(), historyTurns:0, timestamp:0 });
  const audio = document.querySelector('audio');
  audio.src = mode === 'mp3' ? '/sentence.mp3' : '/continuous.ogg';
  trace.audio(audio, mode);
  try { await audio.play(); } catch(error) { trace.finish(error.name === 'NotAllowedError' ? 'autoplay-blocked' : 'audio-error'); }
 };
};
</script></html>` }],
    ]);
    const server = http.createServer((req, res) => {
        const asset = assets.get(req.url);
        if (!asset) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' }); res.end(asset.body);
    });
    let browser;
    try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(() => typeof window.runProbe === 'function');
        for (const [index, mode] of ['mp3', 'ogg'].entries()) {
            await page.evaluate(mode => window.runProbe(mode), mode);
            await page.focus('#start');
            await page.keyboard.press('Enter');
            await page.waitForFunction(count => window.__qaLatencyRecords?.length === count, { timeout: 15000 }, index + 1);
        }
        return { kind: 'headless-saved-audio-instrumentation', browser: await browser.version(),
            records: await page.evaluate(() => window.__qaLatencyRecords),
            limitation: 'Keyboard activation and real playing events with saved audio only; no production latency, mobile, screen reader or audible-output claim.' };
    } finally {
        if (browser) await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}
if (require.main === module) main(process.argv[2]).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    process.stderr.write(`${error.name}: browser probe failed\n`); process.exitCode = 1;
});
