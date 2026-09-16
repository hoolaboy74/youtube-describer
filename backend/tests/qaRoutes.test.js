'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const { once, EventEmitter } = require('node:events');
const { createQaRouter } = require('../modules/qaRoutes');
const { createQaRequestStore } = require('../modules/qaRequestStore');
const { createQaSpeech } = require('../modules/qaSpeech');
const { createMediaResourceLimiter } = require('../modules/mediaResourceLimiter');
const body = { requestId: 'request-123', sessionId: 'session-123', videoId: 'abcdefghijk', timestamp: 12, question: '질문입니다.', history: [], audioMode: 'mp3' };
test('HTTP acceptance is idempotent, events replay without a new job and audio issuance checks ownership', async t => {
    const store = createQaRequestStore(); let calls = 0;
    const app = express(); app.use(express.json()); app.use('/api/qa', createQaRouter({ store, enabled: () => true,
        auth: (req, res, next) => { if (!req.headers.authorization) return res.status(401).end(); req.user = { id: req.headers.authorization }; next(); },
        run: async request => { calls++; store.emit(request, 'sentence', { seq: 0, text: '답변입니다.' }); store.putAudio(request, 0, Buffer.from('mp3')); store.finish(request, 'audio_done'); }, manager: () => ({}) }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}/api/qa`;
    const post = (suffix, value, user = 'owner') => fetch(base + suffix, { method: 'POST', headers: { authorization: user, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal((await fetch(base + '/config')).status, 401);
    assert.equal((await post('/requests', body)).status, 202); assert.equal((await post('/requests', body)).status, 202); assert.equal(calls, 1);
    assert.equal((await post('/requests', { ...body, question: 'changed' })).status, 409);
    const replay = await fetch(base + '/requests/request-123/events', { headers: { authorization: 'owner', 'last-event-id': '1' } }); const text = await replay.text();
    assert.ok(!text.includes('event: accepted')); assert.ok(text.includes('event: sentence')); assert.ok(text.includes('event: audio_done')); assert.equal(calls, 1);
    assert.equal((await post('/requests/request-123/audio', { seq: 0 }, 'other')).status, 404);
    const grant = await (await post('/requests/request-123/audio', { seq: 0 })).json();
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}` + grant.path)).text(), 'mp3');
});
test('opening-summary eligibility is authenticated, validates input, and reports cache misses without generation', async t => {
    let cacheCalls = 0, runCalls = 0;
    const app = express(); app.use(express.json()); app.use('/api/qa', createQaRouter({ store: createQaRequestStore(), enabled: () => true,
        auth: (req, res, next) => { if (!req.headers.authorization) return res.status(401).end(); req.user = { id: req.headers.authorization }; next(); },
        getVideo: () => ({ duration: 60 }), media: () => ({ prepareCacheOnly: async () => { cacheCalls++; throw Object.assign(new Error('QA_OPENING_SUMMARY_CACHE_MISS'), { code: 'QA_OPENING_SUMMARY_CACHE_MISS' }); } }),
        manager: () => ({}), run: async () => { runCalls++; } }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}/api/qa/opening-summary-eligibility`;
    const post = (value, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
    assert.equal((await post({ videoId: 'abcdefghijk', timestamp: 12 })).status, 401);
    assert.equal((await post({ videoId: 'bad', timestamp: 12 }, { authorization: 'owner' })).status, 400);
    const response = await post({ videoId: 'abcdefghijk', timestamp: 12 }, { authorization: 'owner' });
    assert.deepEqual(await response.json(), { available: false }); assert.equal(cacheCalls, 1); assert.equal(runCalls, 0);
});
test('continuous TTS produces bytes after the first input before end and releases its permit', async () => {
    const limiter = createMediaResourceLimiter({ tts: 1 }); const rpc = new EventEmitter(); const writes = [];
    rpc.destroy = () => {}; rpc.write = value => { writes.push(value); if (value.input) rpc.emit('data', { audioContent: Buffer.from('ogg-byte') }); return true; };
    rpc.end = () => rpc.emit('end');
    const speech = createQaSpeech({ streamingClient: { streamingSynthesize: () => rpc }, limiter });
    const stream = await speech.ogg(new AbortController().signal); const first = once(stream.output, 'data');
    await stream.write('첫 문장입니다.'); assert.equal((await first)[0].toString(), 'ogg-byte'); assert.equal(writes.length, 2); assert.equal(limiter.snapshot().used.tts, 1);
    await stream.write('두 번째 문장입니다.'); stream.end(); await stream.done; assert.equal(limiter.snapshot().used.tts, 0);
});
