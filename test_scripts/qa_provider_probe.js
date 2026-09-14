#!/usr/bin/env node
'use strict';
// Bounded capability experiment, not the production sentence policy validator.
// Explicit --live: at most 2 model calls (512 output tokens each), 1 search-enabled
// call, 1 OGG stream and 2 MP3 calls (fixed text only), no automatic retries.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const backendRoot = path.resolve(__dirname, '../backend');
const backendRequire = createRequire(path.join(backendRoot, 'package.json'));
const sentences = ['음성 재생 시험입니다.', '두 번째 시험 문장입니다.'];
const voice = { languageCode: 'ko-KR', name: 'ko-KR-Chirp3-HD-Sulafat' };
const safeError = error => ({ name: error.name || 'Error', code: error.status || error.code || null });

function createRecordParser(onRecord) {
    let pending = '';
    let count = 0;
    return {
        push(text) {
            pending += text;
            if (pending.length > 16384) throw new Error('Record size limit');
            let boundary;
            while ((boundary = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, boundary).trim();
                pending = pending.slice(boundary + 1);
                if (!line) continue;
                const record = JSON.parse(line);
                if (record.seq !== count || typeof record.text !== 'string' || !record.text.endsWith('.')
                    || record.kind !== 'explanation' || !Array.isArray(record.evidenceIds) || record.evidenceIds.length) throw new Error('Invalid experiment record');
                onRecord(record);
                count++;
            }
        },
        end() { return { count, unfinishedTail: pending.trim().length > 0 }; },
    };
}

async function modelProbe(apiKey, modelName, structuredSearch) {
    const { GoogleGenerativeAI } = backendRequire('@google/generative-ai');
    const started = performance.now();
    let firstRecordMs = null;
    const parser = createRecordParser(() => { firstRecordMs ??= performance.now() - started; });
    const schema = { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        seq: { type: 'INTEGER' }, text: { type: 'STRING' }, kind: { type: 'STRING', enum: ['explanation'] },
        evidenceIds: { type: 'ARRAY', items: { type: 'STRING' } },
    }, required: ['seq', 'text', 'kind', 'evidenceIds'] } };
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName,
        ...(structuredSearch ? { tools: [{ googleSearch: {} }] } : {}),
        generationConfig: { maxOutputTokens: 512, ...(structuredSearch ? { responseMimeType: 'application/json', responseSchema: schema } : {}) },
    });
    try {
        const prompt = `This is a format-only experiment. Return exactly two records with seq 0 and 1, kind explanation, evidenceIds []. Texts must be exactly ${JSON.stringify(sentences)}. ${structuredSearch ? 'Return a JSON array. Search tool need not be invoked.' : 'Return newline-delimited JSON objects, one complete object per line, including a final newline. No markdown or surrounding array.'}`;
        const result = await model.generateContentStream(prompt, { timeout: 20000 });
        let text = '';
        let formatError = false;
        for await (const chunk of result.stream) {
            const delta = chunk.text();
            text += delta;
            if (!structuredSearch && !formatError) {
                try { parser.push(delta); } catch { formatError = true; }
            }
        }
        const response = await result.response;
        const end = structuredSearch ? null : parser.end();
        let valid = false;
        try {
            const parsed = structuredSearch ? JSON.parse(text) : text.trim().split('\n').map(line => JSON.parse(line));
            valid = parsed.length === 2 && parsed.every((r, i) => r.seq === i && r.text === sentences[i] && r.kind === 'explanation' && Array.isArray(r.evidenceIds) && r.evidenceIds.length === 0);
        } catch { /* record format failure without emitting model text */ }
        return { mode: structuredSearch ? 'schema-with-search-config' : 'jsonl', status: valid && !formatError && (structuredSearch || (end.count === 2 && !end.unfinishedTail)) ? 'passed' : 'format-failed',
            elapsedMs: performance.now() - started, firstRecordMs, parser: end,
            usage: response.usageMetadata || null,
            searchQueries: response.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length || 0,
            limitation: 'Format/config compatibility only; no factuality, real search invocation or production TTS validation claim.' };
    } catch (error) {
        return { mode: structuredSearch ? 'schema-with-search-config' : 'jsonl', status: 'failed', elapsedMs: performance.now() - started, error: safeError(error), usage: null };
    }
}

async function speechProbe(client, directory) {
    const results = [];
    for (let seq = 0; seq < sentences.length; seq++) {
        const start = performance.now();
        try {
            const [response] = await client.synthesizeSpeech({ input: { text: sentences[seq] }, voice,
                audioConfig: { audioEncoding: 'MP3' } }, { timeout: 15000, retry: null });
            const bytes = Buffer.from(response.audioContent || []);
            await fs.writeFile(path.join(directory, `sentence-${seq}.mp3`), bytes);
            results.push({ mode: 'mp3', seq, status: bytes.length ? 'passed' : 'empty', elapsedMs: performance.now() - start, bytes: bytes.length });
        } catch (error) { results.push({ mode: 'mp3', seq, status: 'failed', elapsedMs: performance.now() - start, error: safeError(error) }); }
    }
    const streamResult = await new Promise(resolve => {
        const start = performance.now();
        let stream;
        let secondTimer;
        let timeout;
        let settled = false;
        const buffers = [];
        let bytes = 0;
        let firstByteMs = null;
        let secondInputMs = null;
        const finish = (status, error) => {
            if (settled) return;
            settled = true;
            clearTimeout(secondTimer); clearTimeout(timeout);
            stream?.destroy();
            resolve({ metrics: { mode: 'ogg', status, firstByteMs, secondInputMs,
                firstByteBeforeSecondInput: firstByteMs !== null && secondInputMs !== null && firstByteMs < secondInputMs,
                elapsedMs: performance.now() - start, bytes, ...(error ? { error: safeError(error) } : {}) }, audio: Buffer.concat(buffers) });
        };
        try {
            stream = client.streamingSynthesize({ timeout: 20000, retry: null });
            timeout = setTimeout(() => finish('timeout'), 20000);
            stream.on('data', response => {
                if (settled || !response.audioContent?.length) return;
                firstByteMs ??= performance.now() - start;
                bytes += response.audioContent.length;
                if (bytes > 1024 * 1024) return finish('buffer-limit');
                buffers.push(Buffer.from(response.audioContent));
            });
            stream.on('error', error => finish('failed', error));
            stream.on('end', () => finish(bytes ? 'passed' : 'empty'));
            stream.write({ streamingConfig: { voice, streamingAudioConfig: { audioEncoding: 'OGG_OPUS' } } });
            stream.write({ input: { text: sentences[0] } });
            secondTimer = setTimeout(() => {
                if (settled) return;
                secondInputMs = performance.now() - start;
                stream.write({ input: { text: sentences[1] } });
                stream.end();
            }, 3000);
        } catch (error) { finish('failed', error); }
    });
    if (streamResult.metrics.status === 'passed') await fs.writeFile(path.join(directory, 'continuous.ogg'), streamResult.audio);
    return [...results, streamResult.metrics];
}

async function main() {
    if (process.argv[2] !== '--live' || !process.argv[3]) throw new Error('Usage: node test_scripts/qa_provider_probe.js --live <new-output-directory>');
    const directory = path.resolve(process.argv[3]);
    await fs.mkdir(directory); // Refuse to overwrite any existing result directory.
    backendRequire('dotenv').config({ path: path.join(backendRoot, '.env'), quiet: true });
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(backendRoot, process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const modelName = process.env.QA_MODEL_NAME || 'gemini-3.5-flash-lite';
    const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
        budget: { modelCalls: 2, maxOutputTokensPerCall: 512, searchEnabledCalls: 1, speechCalls: 3, speechCharacters: sentences.join('').length * 2, retries: 0 },
        model: [], speech: [] };
    report.modelName = modelName;
    report.model = process.env.GOOGLE_API_KEY ? [await modelProbe(process.env.GOOGLE_API_KEY, modelName, false),
        await modelProbe(process.env.GOOGLE_API_KEY, modelName, true)] : [{ status: 'unavailable', reason: 'missing-api-key' }];
    const { TextToSpeechClient } = backendRequire('@google-cloud/text-to-speech');
    const client = new TextToSpeechClient();
    try { report.speech = await speechProbe(client, directory); } finally { await client.close(); }
    await fs.writeFile(path.join(directory, 'provider-results.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (require.main === module) main().catch(error => { process.stderr.write(`${JSON.stringify(safeError(error))}\n`); process.exitCode = 1; });
module.exports = { createRecordParser };
