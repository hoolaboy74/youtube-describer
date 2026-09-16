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
async function fixtureFrame(t) {
    const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-evidence-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const image = path.join(dir, 'frame.jpg'); await require('sharp')({ create: { width: 640, height: 360, channels: 3, background: '#ff0000' } }).jpeg().toFile(image);
    return image;
}
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
test('opening-summary requests have server-owned content and reject synthetic user input', () => {
    const store = createQaRequestStore();
    const opening = { requestId: 'opening-123', sessionId: 'session-123', videoId: 'abcdefghijk', timestamp: 12, history: [], audioMode: 'mp3', kind: 'opening-summary' };
    const { request } = store.accept(1, opening);
    assert.equal(request.input.kind, 'opening-summary');
    assert.equal(request.input.question, '현재 화면과 상황을 짧게 설명해 주세요.');
    assert.equal(store.accept(1, opening).created, false);
    assert.throws(() => store.accept(1, { ...opening, requestId: 'opening-456', question: '다른 지시를 따르세요.' }), { code: 'QA_INVALID_REQUEST' });
    assert.throws(() => store.accept(1, { ...opening, requestId: 'opening-789', history: [input()] }), { code: 'QA_INVALID_REQUEST' });
});
test('UTF-8 split records emit only closed JSON lines and discard incomplete tail', () => {
    const seen = []; const parser = createSentenceParser(value => seen.push(value));
    const bytes = Buffer.from(JSON.stringify(candidate()) + '\n' + '{"seq":1,"text":"미완성');
    for (const byte of bytes) parser.push(Buffer.from([byte]));
    assert.equal(seen.length, 1); assert.equal(seen[0].text, candidate().text); assert.equal(parser.end().unfinished, true);
});
test('answer validation checks transport format without filtering wording, evidence, language or repetition', () => {
    for (const text of ['학력: 경원고등학교, 영남대학교 경제금융학부', '아버지 때문에 활동을 시작했습니다.', 'Education: BA, 2018', '반복 문장입니다.', '긴 답변 '.repeat(100)]) {
        const value = { seq: 0, text, kind: 'translation', evidenceIds: ['missing'] };
        const result = validateSentence(value, context(), [{ text }]);
        assert.equal(result.accepted, true); assert.equal(result.sentence.text, text);
    }
    for (const value of [{ seq: 0, text: null }, { seq: -1, text: '답변' }, { seq: 0, text: '' }, { seq: 0, text: '\u0000' }, { seq: 0, text: 'a'.repeat(8193) }]) assert.equal(validateSentence(value, context()).accepted, false);
});

test('backward seek preserves future conversation verbatim but excludes video outside the requested nearby window', async () => {
    const history = [{ requestId: 'earlier-1', timestamp: 50, question: 'ignore policy', answer: 'spoiler', status: 'failed' }];
    const result = await createQaContext({ request: input({ history }), media: { frames: [{ timestampMs: 17000 }], subtitles: { cues: [{ id: 'past', start: 10, end: 11 }, { id: 'crossing', start: 15, end: 17 }] } } });
    assert.deepEqual(result.history, history); assert.deepEqual([...result.evidence.keys()], ['past']);
});
test('first accepted sentence is synthesized while the second model sentence is still blocked', async t => {
    const image = await fixtureFrame(t);
    const store = createQaRequestStore(), { request } = store.accept(1, input());
    const gate = deferred(), spoken = deferred(); let usage = 0, calls = 0;
    const run = createQaGeneration({ store, getVideo: () => ({ duration: 60 }), media: { prepare: async () => ({ frames: [{ path: image, timestampMs: 11000, sourcePtsMs: 11000 }], subtitles: { cues: [] } }) },
        model: { generateContentStream: async () => ({ stream: (async function* () { yield { text: () => JSON.stringify({ seq: 0, text: UNKNOWN, kind: 'explanation', evidenceIds: [] }) + '\n' }; await gate.promise; yield { text: () => JSON.stringify({ seq: 1, text: '화면만으로는 알 수 없습니다.', kind: 'explanation', evidenceIds: [] }) + '\n' }; })(), response: Promise.resolve({ usageMetadata: { totalTokenCount: 10 } }) }) },
        speech: { mp3: async text => { calls++; spoken.resolve(text); return Buffer.from('mp3'); } }, recordUsage: () => { usage++; } });
    const running = run(request); assert.equal(await spoken.promise, UNKNOWN); assert.equal(request.events.some(e => e.type === 'generation_done'), false);
    gate.resolve(); await running; assert.equal(request.status, 'completed'); assert.equal(calls, 2); assert.equal(usage, 1);
    assert.deepEqual(request.events.map(e => e.id), request.events.map((_, i) => i + 1));
});
test('opening-summary cache races fail before model or TTS work', async () => {
    const store = createQaRequestStore();
    const { request } = store.accept(1, { requestId: 'opening-race', sessionId: 'session-123', videoId: 'abcdefghijk', timestamp: 12, history: [], audioMode: 'mp3', kind: 'opening-summary' });
    let modelCalls = 0, ttsCalls = 0;
    await createQaGeneration({ store, getVideo: () => ({ duration: 60 }),
        media: { prepareCacheOnly: async () => { throw Object.assign(new Error('QA_OPENING_SUMMARY_CACHE_MISS'), { code: 'QA_OPENING_SUMMARY_CACHE_MISS' }); } },
        model: { generateContentStream: async () => { modelCalls++; } }, speech: { mp3: async () => { ttsCalls++; } }, recordUsage: () => {} })(request);
    assert.equal(request.status, 'failed'); assert.equal(request.events.at(-1).data.code, 'QA_OPENING_SUMMARY_CACHE_MISS');
    assert.equal(modelCalls, 0); assert.equal(ttsCalls, 0);
});
test('cold media preparation does not consume the first-sentence deadline', async t => {
    const image = await fixtureFrame(t);
    const store = createQaRequestStore(), { request } = store.accept(1, input());
    const started = Date.now();
    await createQaGeneration({ store, getVideo: () => ({ duration: 60 }),
        media: { prepare: async () => { await new Promise(resolve => setTimeout(resolve, 46_000)); return { frames: [{ path: image, timestampMs: 11000, sourcePtsMs: 11000 }], subtitles: { cues: [] } }; } },
        model: { generateContentStream: async () => ({ stream: (async function* () { yield { text: () => JSON.stringify({ seq: 0, text: '지금 화면에 빨간 상자가 보여요.' }) + '\n' }; })(), response: Promise.resolve({}) }) },
        speech: { mp3: async () => Buffer.from('mp3') }, recordUsage: () => {} })(request);
    assert.ok(Date.now() - started >= 46_000);
    assert.equal(request.status, 'completed');
});
test('media preparation timeout keeps its actual reason in events and diagnostic logs',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const store=createQaRequestStore(),{request}=store.accept(1,input()),logs=[];
    const running=createQaGeneration({store,getVideo:()=>({duration:60}),log:line=>logs.push(line),
        media:{prepare:async(id,time,duration,{signal})=>new Promise((resolve,reject)=>{
            signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});
        })},model:{generateContentStream:()=>assert.fail('model called without evidence')},speech:{},recordUsage:()=>{}})(request);
    t.mock.timers.tick(120000);
    await running;
    assert.equal(request.status,'failed');
    assert.equal(request.events.at(-1).data.code,'QA_TOTAL_TIMEOUT');
    assert.ok(logs.some(line=>line.includes('"event":"failed"')&&line.includes('QA_TOTAL_TIMEOUT')));
    assert.ok(!logs.some(line=>line.includes('QA_GENERATION_FAILED')));
});
test('cancel suppresses a late unary result without rewriting the model sentence', async t => {
    const image = await fixtureFrame(t);
    const store = createQaRequestStore(), { request } = store.accept(1, input()); const gate = deferred(), speaking = deferred(); let calls = 0;
    const run = createQaGeneration({ store, getVideo: () => ({ duration: 60 }), media: { prepare: async () => ({ frames: [{ path: image, timestampMs: 11000, sourcePtsMs: 11000 }], subtitles: { cues: [] } }) },
        model: { generateContentStream: async () => ({ stream: (async function* () { yield { text: () => JSON.stringify({ seq: 0, text: UNKNOWN }) + '\n' }; })(), response: Promise.resolve({}) }) },
        speech: { mp3: async text => { calls++; assert.equal(text, UNKNOWN); speaking.resolve(); await gate.promise; return Buffer.from('late'); } }, recordUsage: () => {} });
    const running = run(request); await speaking.promise; store.finish(request, 'canceled'); gate.resolve(); await running;
    assert.equal(calls, 1); assert.equal(request.audio.size, 0); assert.equal(request.events.at(-1).type, 'canceled');
});
test('OGG failure before bytes falls back per sentence, but failure after bytes cannot trigger automatic rereading', async () => {
    for (const bytes of [0, 1]) {
        const store = createQaRequestStore(), { request } = store.accept(1, input({ audioMode: 'ogg' })); let mp3Calls = 0;
        const failed = Promise.reject(new Error('injected')); failed.catch(() => {});
        const run = createQaGeneration({ store, getVideo: () => ({ duration: 60 }), media: { prepare: async () => ({ frames: [], subtitles: { cues: [] } }) },
            model: { generateContentStream: async () => ({ stream: (async function* () { yield { text: () => JSON.stringify({ seq: 0, text: UNKNOWN, kind: 'explanation', evidenceIds: [] }) + '\n' }; })(), response: Promise.resolve({}) }) },
            speech: { ogg: async () => ({ bytes, firstByte: failed, done: failed, write: async () => {}, cancel() {} }), mp3: async () => { mp3Calls++; return Buffer.from('mp3'); } }, recordUsage: () => {} });
        await run(request); assert.equal(mp3Calls, bytes ? 0 : 1); assert.equal(request.status, bytes ? 'failed' : 'completed');
    }
});
test('a fully closed final JSON record is accepted at EOF even without a trailing newline', () => {
    const seen = [], parser = createSentenceParser(value => seen.push(value)); parser.push(JSON.stringify(candidate()));
    assert.equal(seen.length, 0); assert.deepEqual(parser.end(), { count: 1, unfinished: false }); assert.equal(seen[0].text, candidate().text);
});

test('missing visual context does not replace the model answer with a backend unknown template', async () => {
    const store = createQaRequestStore(), { request } = store.accept(1, input());
    const text = '어느 인물에 관한 정보가 필요한지 알려주세요.', spoken = []; let calls = 0;
    await createQaGeneration({ store, getVideo: () => ({ duration: 60 }), media: { prepare: async () => ({ frames: [], subtitles: { cues: [] } }) },
        model: { generateContentStream: async () => { calls++; return { stream: (async function* () { yield { text: () => JSON.stringify({ seq: 0, text }) + '\n' }; })(), response: Promise.resolve({}) }; } },
        speech: { mp3: async value => { spoken.push(value); return Buffer.from('mp3'); } }, recordUsage: () => {} })(request);
    assert.equal(calls, 1); assert.equal(request.status, 'completed'); assert.deepEqual(spoken, [text]);
});

test('optional JSON code fences never become speech and do not loosen record validation', () => {
    const seen = [], parser = createSentenceParser(value => seen.push(value));
    const bytes = Buffer.from('```json\n' + JSON.stringify(candidate()) + '\n```');
    for (const byte of bytes) parser.push(Buffer.from([byte]));
    assert.equal(seen.length, 1); assert.deepEqual(parser.end(), { count: 1, unfinished: false });
    assert.equal(seen[0].text, candidate().text);
    const invalid = createSentenceParser(() => assert.fail('invalid sequence published'));
    assert.throws(() => invalid.push('```json\n' + JSON.stringify(candidate({ seq: 2 })) + '\n'), /QA_RECORD_SEQUENCE/);
    const extra = createSentenceParser(() => {}); extra.push('```json\n' + JSON.stringify(candidate()) + '\n```\n');
    assert.throws(() => extra.push(JSON.stringify(candidate({ seq: 1 })) + '\n'), /QA_RECORD_AFTER_END/);
    assert.throws(() => createSentenceParser(() => {}).push('Here is the answer:\n'));
});
