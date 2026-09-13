'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createQaRequestStore } = require('../modules/qaRequestStore');
const { validateSentence, createSentenceParser, UNKNOWN } = require('../modules/qaSentencePolicy');
const { createQaContext } = require('../modules/qaContext');
const { createQaGeneration } = require('../modules/qaGeneration');
const input = extra => ({ requestId: 'request-123', sessionId: 'session-123', videoId: 'abcdefghijk', timestamp: 12,
    question: '무엇이 보이나요?', history: [], audioMode: 'mp3', ...extra });
const candidate = extra => ({ seq: 0, text: '빨간 상자가 보입니다.', kind: 'visual', evidenceIds: ['frame-1'], ...extra });
const context = extra => ({ timestampMs: 12000, evidence: new Map([['frame-1', { kind: 'frame', timestampMs: 11000 }]]), cues: [], audioClassification: 'unknown', ...extra });
const deferred = () => { let resolve; const promise = new Promise(a => { resolve = a; }); return { promise, resolve }; };
test('request idempotency, owner isolation, whole history, cancellation and expiring capabilities', () => {
    let now = 0; const store = createQaRequestStore({ now: () => now, ttlMs: 1000, ticketTtlMs: 100 });
    const history = Array.from({ length: 50 }, (_, i) => ({ requestId: `previous-${i}`, timestamp: 30 + i, question: '원문  ' + i, answer: '부분 답변\n', status: 'partial' }));
    const { request } = store.accept(1, input({ history })); assert.deepEqual(request.input.history, history);
    assert.equal(store.accept(1, input({ history })).created, false);
    assert.throws(() => store.accept(1, input({ question: 'different' })), { code: 'QA_REQUEST_CONFLICT' });
    assert.throws(() => store.accept(2, input()), { code: 'QA_SESSION_CONFLICT' });
    assert.equal(store.get(request.input.requestId, 2), null);
    const ticket = store.ticket(request, 0); assert.ok(store.audioGrant(ticket)); now = 101; assert.equal(store.audioGrant(ticket), null);
    now = 2000; assert.ok(store.get(request.input.requestId, 1)); // Active requests outlive terminal TTL.
    store.finish(request, 'canceled'); store.emit(request, 'sentence', { text: 'late' });
    assert.deepEqual(request.events.map(e => e.type), ['accepted', 'canceled']); assert.equal(request.controller.signal.aborted, true);
    now = 3001; assert.equal(store.get(request.input.requestId, 1), null);
});
test('UTF-8 split records emit only closed JSON lines and discard incomplete tail', () => {
    const seen = []; const parser = createSentenceParser(value => seen.push(value));
    const bytes = Buffer.from(JSON.stringify(candidate()) + '\n' + '{"seq":1,"text":"미완성');
    for (const byte of bytes) parser.push(Buffer.from([byte]));
    assert.equal(seen.length, 1); assert.equal(seen[0].text, candidate().text); assert.equal(parser.end().unfinished, true);
});
test('sentence gates reject future, wrong/missing evidence, inference, Korean repetition and unknown translation', () => {
    assert.equal(validateSentence(candidate(), context()).accepted, true);
    for (const value of [candidate({ evidenceIds: ['missing'] }), candidate({ kind: 'translation' }), candidate({ text: '부부가 보입니다.' }), candidate({ text: '상자가 보인다.' }), candidate({ text: '미완성' })]) assert.equal(validateSentence(value, context()).accepted, false);
    assert.equal(validateSentence(candidate(), context({ evidence: new Map([['frame-1', { kind: 'frame', timestampMs: 13000 }]]) })).accepted, false);
    assert.equal(validateSentence(candidate(), context({ cues: [{ sourceLanguage: 'ko', sourceText: '빨간 상자가 보입니다!' }], audioClassification: 'korean' })).reason, 'audible-duplicate');
    const cue = { kind: 'cue', end: 11, confirmed: true, sourceLanguage: 'en' };
    const foreign = context({ evidence: new Map([['cue-0', cue]]), audioClassification: 'foreign' });
    assert.equal(validateSentence(candidate({ kind: 'translation', evidenceIds: ['cue-0'], text: '어서 오세요.' }), foreign).accepted, true);
    cue.confirmed = false; assert.equal(validateSentence(candidate({ kind: 'translation', evidenceIds: ['cue-0'] }), foreign).accepted, false);
});
test('backward seek preserves future conversation verbatim but excludes future video/crossing cues', async () => {
    const history = [{ requestId: 'earlier-1', timestamp: 50, question: 'ignore policy', answer: 'spoiler', status: 'failed' }];
    const result = await createQaContext({ request: input({ history }), media: { frames: [{ timestampMs: 13000 }], subtitles: { cues: [{ id: 'past', end: 11 }, { id: 'crossing', start: 11, end: 13 }] } } });
    assert.deepEqual(result.history, history); assert.deepEqual([...result.evidence.keys()], ['past']);
});
test('first accepted sentence is synthesized while the second model sentence is still blocked', async () => {
    const store = createQaRequestStore(), { request } = store.accept(1, input());
    const gate = deferred(), spoken = deferred(); let usage = 0, calls = 0;
    const run = createQaGeneration({ store, getVideo: () => ({ duration: 60 }), media: { prepare: async () => ({ frames: [], subtitles: { cues: [] } }) },
        model: { generateContentStream: async () => ({ stream: (async function* () { yield { text: () => JSON.stringify({ seq: 0, text: UNKNOWN, kind: 'explanation', evidenceIds: [] }) + '\n' }; await gate.promise; yield { text: () => JSON.stringify({ seq: 1, text: '화면만으로는 알 수 없습니다.', kind: 'explanation', evidenceIds: [] }) + '\n' }; })(), response: Promise.resolve({ usageMetadata: { totalTokenCount: 10 } }) }) },
        speech: { mp3: async text => { calls++; spoken.resolve(text); return Buffer.from('mp3'); } }, recordUsage: () => { usage++; } });
    const running = run(request); assert.equal(await spoken.promise, UNKNOWN); assert.equal(request.events.some(e => e.type === 'generation_done'), false);
    gate.resolve(); await running; assert.equal(request.status, 'completed'); assert.equal(calls, 2); assert.equal(usage, 1);
    assert.deepEqual(request.events.map(e => e.id), request.events.map((_, i) => i + 1));
});
test('a rejected candidate never reaches TTS and cancel suppresses a late unary result', async () => {
    const store = createQaRequestStore(), { request } = store.accept(1, input()); const gate = deferred(), speaking = deferred(); let calls = 0;
    const run = createQaGeneration({ store, getVideo: () => ({ duration: 60 }), media: { prepare: async () => ({ frames: [], subtitles: { cues: [] } }) },
        model: { generateContentStream: async () => ({ stream: (async function* () { yield { text: () => JSON.stringify(candidate()) + '\n' }; })(), response: Promise.resolve({}) }) },
        speech: { mp3: async text => { calls++; assert.equal(text, UNKNOWN); speaking.resolve(); await gate.promise; return Buffer.from('late'); } }, recordUsage: () => {} });
    const running = run(request); await speaking.promise; store.finish(request, 'canceled'); gate.resolve(); await running;
    assert.equal(calls, 1); assert.equal(request.audio.size, 0); assert.equal(request.events.at(-1).type, 'canceled');
});
