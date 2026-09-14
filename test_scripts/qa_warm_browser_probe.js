#!/usr/bin/env node
'use strict';
// One explicitly authorized live model request, max 4096 output tokens and
// 12 validated sentence TTS calls. No downloads/search/retries. Local MP4 only.
const fs = require('node:fs/promises'), path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../backend'), req = createRequire(path.join(root, 'package.json'));
async function main() {
    const [, , live, directoryArg, sourceArg] = process.argv;
    if (live !== '--live' || !directoryArg || !sourceArg) throw new Error('Usage: --live <new-output-directory> <local-fixture-mp4>');
    const directory = path.resolve(directoryArg); await fs.mkdir(directory);
    req('dotenv').config({ path: path.join(root, '.env'), quiet: true }); process.env.QA_CACHE_WARMING_ENABLED = 'false';
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(root, process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const { createQaCacheManager } = req('./modules/qaCacheManager'), { createQaMedia } = req('./modules/qaMedia');
    const { extractFrameWindow } = req('./modules/frameExtraction');
    const { createQaRequestStore } = req('./modules/qaRequestStore'), { createQaGeneration } = req('./modules/qaGeneration');
    const { createQaRouter } = req('./modules/qaRoutes'), { createQaSpeech } = req('./modules/qaSpeech');
    const { TextToSpeechClient } = req('@google-cloud/text-to-speech'), { GoogleGenerativeAI } = req('@google/generative-ai');
    const db = new (req('better-sqlite3'))(path.join(directory, 'fixture.db')), client = new TextToSpeechClient();
    let browser, server, running, activeRequest, usage, phase = 'frames'; const pageErrors = [];
    try {
        const manager = createQaCacheManager({ db, root: path.join(directory, 'cache') });
        const frames = await extractFrameWindow({ inputPath: path.resolve(sourceArg), outputDir: path.join(directory, 'frames'), startMs: 116000, endMs: 120000 });
        const lease = manager.store.claim('OT0wMk7yIEo', 'frames-v1', 'probe'); for (const frame of frames) await manager.publishFrame(lease, frame); manager.store.release(lease);
        const subtitles = manager.store.claim('OT0wMk7yIEo', 'subtitles-v1', 'probe'); manager.subtitleUnavailable(subtitles, 'absent'); manager.store.release(subtitles);
        const unexpected = () => { throw new Error('Unexpected cold media work'); };
        const media = createQaMedia({ manager, adapter: { section: unexpected, full: unexpected, subtitles: unexpected } });
        const store = createQaRequestStore(); const modelName = process.env.QA_MODEL_NAME || 'gemini-3.5-flash-lite';
        const run = createQaGeneration({ store, media, getVideo: () => ({ duration: 1040 }),
            model: new GoogleGenerativeAI(process.env.GOOGLE_API_KEY).getGenerativeModel({ model: modelName, generationConfig: { maxOutputTokens: 4096 } }),
            speech: createQaSpeech({ client, streamingClient: client }), recordUsage: (request, response) => { usage = response.usageMetadata; } });
        const express = req('express'), app = express(); app.use(express.json());
        app.use('/api/qa', createQaRouter({ enabled: () => true, store, manager: () => manager,
            auth: (request, response, next) => { request.user = { id: 'local-probe' }; next(); },
            run: request => { activeRequest = request; running = run(request); return running; } }));
        for (const name of ['qaClient', 'qaAudioController']) app.get(`/${name}.js`, async (request, response) => response.type('application/javascript').send(await fs.readFile(path.resolve(root, `../frontend/src/services/${name}.js`), 'utf8')));
        app.get('/', (request, response) => response.send(`<!doctype html><html lang="ko"><title>문장 음성 통합 시험</title><button id="ask">질문 전송</button><script type="module">
import {createQaClient} from '/qaClient.js'; import {createQaAudioController} from '/qaAudioController.js';
window.ready = true;
document.querySelector('button').onclick = async () => {
 const started = performance.now(); const timing = {}; const sentences = []; const client = createQaClient({apiBase:'',token:'local-probe'});
 const id = crypto.randomUUID(); const controller = new AbortController();
 const audio = createQaAudioController({onPlaying:()=>{timing.firstPlayingMs ??= performance.now()-started;}, onError:message=>{window.probeError=message;}, onDone:()=>{window.result={timing,sentences};}}); audio.prepare(1.2);
 try { const accepted = await client.submit({requestId:id,sessionId:crypto.randomUUID(),videoId:'OT0wMk7yIEo',timestamp:120,question:'화면의 사람들과 물건이 어떻게 배치되어 있나요?',history:[],audioMode:'mp3'},controller.signal);
 await client.events(accepted.eventsPath,{signal:controller.signal,onEvent:event=>{
  if(event.type==='sentence'){timing.firstSentenceMs ??= performance.now()-started;sentences.push(event.data);}
  if(event.type==='sentence_audio'){timing.firstAssetMs ??= performance.now()-started;audio.enqueue(event.data.seq,event.data.path);}
  if(event.type==='generation_done')timing.generationDoneMs=performance.now()-started;
  if(event.type==='audio_done'){timing.audioDoneMs=performance.now()-started;audio.complete();}
  if(event.type==='error')throw new Error(event.data.code);
 }}); } catch(error) {window.probeError=error.message; await client.cancel(id).catch(()=>{});}
};</script></html>`));
        server = app.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
        phase = 'browser'; browser = await req('puppeteer').launch({ headless: true }); const page = await browser.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`); phase = 'module-ready'; await page.waitForFunction(() => window.ready, { timeout: 5000 }); await page.focus('#ask'); phase = 'request'; await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.result || window.probeError, { timeout: 130000 });
        const result = await page.evaluate(() => ({ result: window.result || null, error: window.probeError || null }));
        const report = { schemaVersion: 1, at: new Date().toISOString(), modelName, browser: await browser.version(), ...result, usage,
            frameTimestamps: frames.map(frame => frame.timestampMs), firstPlayingBeforeGenerationDone: result.result ? result.result.timing.firstPlayingMs < result.result.timing.generationDoneMs : false,
            limitation: 'One warm local-frame request, real model/TTS and headless playing. No mobile audible, P50/P95 or full subtitle context claim.' };
        await fs.writeFile(path.join(directory, 'warm-browser-results.json'), JSON.stringify(report, null, 2) + '\n'); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } catch (error) {
        const report = { schemaVersion: 1, at: new Date().toISOString(), status: 'failed', phase, error: { name: error.name, code: error.code || null }, pageErrors, requestStatus: activeRequest?.status || 'not-started', events: activeRequest?.events.map(e=>({type:e.type, ...(e.type==='error'?{code:e.data.code}:{})})) || [], usage: usage || null };
        await fs.writeFile(path.join(directory, 'warm-browser-results.json'), JSON.stringify(report, null, 2) + '\n'); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        throw error;
    } finally { activeRequest?.controller.abort(); await running?.catch(()=>{}); if (browser) await browser.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await client.close(); db.close(); }
}
if (require.main === module) main().catch(error => { process.stderr.write(JSON.stringify({ name: error.name, code: error.code || null }) + '\n'); process.exitCode = 1; });
