#!/usr/bin/env node
'use strict';
// Explicit bounded integration probe: one continuous OGG RPC + two sentence
// MP3 RPCs (at most two additional MP3 calls if initial OGG falls back),
// no model/download/search calls and no retries. Uses production policy,
// request, generation and speech modules with controlled delayed model records.
const fs = require('node:fs/promises'), path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../backend'); const req = createRequire(path.join(root, 'package.json'));
async function main() {
    if (process.argv[2] !== '--live' || !process.argv[3]) throw new Error('Usage: --live <new-output-directory>');
    const directory = path.resolve(process.argv[3]); await fs.mkdir(directory);
    req('dotenv').config({ path: path.join(root, '.env'), quiet: true });
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(root, process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const { TextToSpeechClient } = req('@google-cloud/text-to-speech');
    const { createQaRequestStore } = req('./modules/qaRequestStore');
    const { createQaGeneration } = req('./modules/qaGeneration');
    const { createQaSpeech } = req('./modules/qaSpeech');
    const { UNKNOWN } = req('./modules/qaSentencePolicy');
    const client = new TextToSpeechClient(); const results = [];
    try {
        for (const audioMode of ['ogg', 'mp3']) {
            const store = createQaRequestStore();
            const { request } = store.accept('probe', { requestId: 'request-' + audioMode, sessionId: 'session-' + audioMode,
                videoId: 'abcdefghijk', timestamp: 12, question: '형식과 음성 시험입니다.', history: [], audioMode });
            const started = performance.now(); let firstAudioMs = null, secondInputMs = null, generationDoneMs = null;
            const chunks = [];
            request.emitter.on('audio', () => request.ogg.output.on('data', bytes => { firstAudioMs ??= performance.now() - started; chunks.push(bytes); }));
            request.emitter.on('event', event => { if (event.type === 'sentence_audio') firstAudioMs ??= performance.now() - started; if (event.type === 'generation_done') generationDoneMs = performance.now() - started; });
            const record = (seq, text) => JSON.stringify({ seq, text, kind: 'explanation', evidenceIds: [] }) + '\n';
            await createQaGeneration({ store, getVideo: () => ({ duration: 60 }), media: { prepare: async () => ({ frames: [], subtitles: { cues: [] } }) },
                model: { generateContentStream: async () => ({ stream: (async function* () {
                    yield { text: () => record(0, UNKNOWN) }; await new Promise(resolve => setTimeout(resolve, 3000));
                    secondInputMs = performance.now() - started; yield { text: () => record(1, '화면만으로는 알 수 없습니다.') };
                })(), response: Promise.resolve({}) }) }, speech: createQaSpeech({ client, streamingClient: client }), recordUsage: () => {} })(request);
            if (chunks.length) await fs.writeFile(path.join(directory, 'continuous.ogg'), Buffer.concat(chunks));
            for (const [seq, bytes] of request.audio) await fs.writeFile(path.join(directory, `${audioMode}-sentence-${seq}.mp3`), bytes);
            results.push({ audioMode, effectiveAudioMode: request.effectiveAudioMode, status: request.status, firstAudioMs, secondInputMs, generationDoneMs,
                firstAudioBeforeSecondInput: firstAudioMs !== null && firstAudioMs < secondInputMs, events: request.events.map(e => e.type),
                error: request.events.find(e => e.type === 'error')?.data.code || null });
        }
    } finally { await client.close(); }
    const report = { schemaVersion: 1, at: new Date().toISOString(), budget: { modelCalls: 0, downloadCalls: 0, expectedTtsCalls: 3, maxTtsCallsWithInitialFallback: 5, retries: 0 }, results,
        limitation: 'Controlled model, real TTS bytes; not a scene-factuality, end-to-end latency or audible mobile result.' };
    await fs.writeFile(path.join(directory, 'incremental-results.json'), JSON.stringify(report, null, 2) + '\n'); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (require.main === module) main().catch(error => { process.stderr.write(JSON.stringify({ name: error.name, code: error.code || null }) + '\n'); process.exitCode = 1; });
