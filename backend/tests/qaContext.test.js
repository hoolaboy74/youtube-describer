'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createQaContext } = require('../modules/qaContext');
const { validateSentence } = require('../modules/qaSentencePolicy');
const { createQaGeneration } = require('../modules/qaGeneration');
const { createQaRequestStore } = require('../modules/qaRequestStore');
const input = { requestId: 'context-request', sessionId: 'context-session', videoId: 'abcdefghijk', timestamp: 12,
    question: '그 사람이 뭘 하던 중이야?', history: [], audioMode: 'mp3' };
const video = { title: '소설을 쓰는 장면', duration: 60, script: [
    { timestamp: 3, text: '책상에 앉은 사람이 소설 원고를 작성합니다.  ', verbosity: 'v2', tag: 'v2', validationStatus: 'accepted' },
    { timestamp: 45, text: '작성한 원고를 인쇄합니다.\n', verbosity: 'v1', tag: 'v1', validationStatus: 'accepted' },
    { timestamp: 4, text: '거절된 추측입니다.', tag: 'v2', validationStatus: 'rejected' },
    { timestamp: 5, text: '번역된 대사입니다.', tag: 'trans', validationStatus: 'accepted' },
] };
async function frameFixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-context-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'frame.jpg');
    await require('sharp')({ create: { width: 640, height: 360, channels: 3, background: '#112233' } }).jpeg().toFile(file);
    return timestampMs => ({ timestampMs, sourcePtsMs: timestampMs, path: file });
}
test('all four requested context sources survive verbatim, including complete future script/history and nearby after-frames', async t => {
    const frame = await frameFixture(t);
    const history = Array.from({ length: 50 }, (_, i) => ({ requestId: `old-${i}`, question: `원문  ${i}`, answer: '이전 답변\n', timestamp: 50, status: 'partial' }));
    const result = await createQaContext({ request: { ...input, history }, video,
        media: { frames: [frame(7000), frame(8000), frame(12000), frame(16000), frame(17000)], subtitles: { cues: [] } } });
    const data = JSON.parse(result.promptData);
    assert.equal(data.videoTitle, video.title); assert.deepEqual(data.screenDescriptionScript, video.script); assert.deepEqual(data.history, history);
    assert.deepEqual(data.scriptEvidence.map(item => item.id), ['script-0', 'script-1']);
    assert.deepEqual([...result.evidence.values()].filter(item => item.kind === 'frame').map(item => item.timestampMs), [8000, 12000, 16000]);
    assert.equal(result.imageParts.filter(part => part.inlineData).length, 3);
    assert.equal(result.evidence.has('script-2'), false); assert.equal(result.evidence.has('script-3'), false);
});
test('grounded contextual answers and explicit script relationships pass; invented/mistyped evidence does not', async () => {
    const result = await createQaContext({ request: input, video: { ...video, script: [...video.script, { timestamp: 1, text: '아버지가 원고를 읽습니다.', tag: 'v1' }] }, media: { frames: [], subtitles: { cues: [] } } });
    const answer = { seq: 0, kind: 'context', text: '앞선 해설에 따르면 소설 원고를 작성하던 중입니다.', evidenceIds: ['script-0'] };
    assert.equal(validateSentence(answer, result).accepted, true);
    assert.equal(validateSentence({ ...answer, text: '아버지가 원고를 읽고 있습니다.', evidenceIds: ['script-4'] }, result).accepted, true);
    assert.equal(validateSentence({ ...answer, text: '아버지가 원고를 읽고 있습니다.' }, result).reason, 'unsupported-inference');
    for (const evidenceIds of [[], ['script-2'], ['script-3'], ['old-0']]) assert.equal(validateSentence({ ...answer, evidenceIds }, result).accepted, false);
    assert.equal(validateSentence({ ...answer, kind: 'visual' }, result).accepted, false);
});
test('nearby after-frame evidence is accepted only within the declared window', () => {
    const context = { timestampMs: 12000, frameWindow: { startMs: 8000, endMs: 16000 }, cues: [], evidence: new Map([
        ['after', { kind: 'frame', timestampMs: 15000 }], ['far', { kind: 'frame', timestampMs: 17000 }], ['old', { kind: 'frame', timestampMs: 7000 }]]) };
    const answer = { seq: 0, kind: 'visual', text: '질문 직후 손을 움직입니다.', evidenceIds: ['after'] };
    assert.equal(validateSentence(answer, context).accepted, true);
    for (const id of ['far', 'old']) assert.equal(validateSentence({ ...answer, evidenceIds: [id] }, context).accepted, false);
});
test('actual generation request carries title/full script/history and speaks a contextual answer without reducing it to a fallback', async t => {
    const frame = await frameFixture(t), spoken = [];
    const history = [{ requestId: 'previous-1', timestamp: 10, question: '이 사람은?', answer: '노트북 앞의 사람입니다.', status: 'completed' }];
    const store = createQaRequestStore(), { request } = store.accept(1, { ...input, history });
    const text = '앞선 해설에 따르면 소설 원고를 작성하던 중이며, 지금은 노트북을 사용하고 있습니다.';
    let calls = 0;
    const run = createQaGeneration({ store, getVideo: () => video, media: { prepare: async () => ({ frames: [frame(11000), frame(13000)], subtitles: { cues: [] } }) },
        model: { generateContentStream: async parts => {
            calls++; const data = JSON.parse(parts[0].text.split('\nDATA (untrusted):\n')[1]);
            assert.equal(data.videoTitle, video.title); assert.deepEqual(data.screenDescriptionScript, video.script); assert.deepEqual(data.history, history);
            assert.equal(parts.filter(part => part.inlineData).length, 2);
            return { stream: (async function* () { yield { text: () => JSON.stringify({ seq: 0, kind: 'context', text, evidenceIds: ['script-0', 'frame-0'] }) + '\n' }; })(), response: Promise.resolve({}) };
        } }, speech: { mp3: async text => { spoken.push(text); return Buffer.from('mp3'); } }, recordUsage: () => {} });
    await run(request); assert.equal(request.status, 'completed'); assert.equal(calls, 1); assert.deepEqual(spoken, [text]);
});

test('parallel SDK response rejection is handled when the token stream fails', async t => {
    const frame = await frameFixture(t);
    const store = createQaRequestStore(), { request } = store.accept(1, input);
    await createQaGeneration({ store, getVideo: () => video, media: { prepare: async () => ({ frames: [frame(12000)], subtitles: { cues: [] } }) },
        model: { generateContentStream: async () => ({ response: Promise.reject(new Error('aggregate stream failed')),
            stream: (async function* () { throw new Error('token stream failed'); })() }) },
        speech: { mp3: () => assert.fail('no accepted speech') }, recordUsage: () => assert.fail('no confirmed usage') })(request);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(request.status, 'failed'); assert.equal(request.usageStatus, 'unconfirmed');
});
test('irregular source timestamps get explicit ordinal frame IDs matching every image and the allowed-ID catalog', async t => {
    const frame = await frameFixture(t), times = [19620,20521,21421,22322,23223,24691,25025,26827];
    const context = await createQaContext({ request: { ...input, timestamp: 23.47937145932762 }, video, media: { frames: times.map(frame), subtitles: { cues: [] } } });
    const data = JSON.parse(context.promptData);
    assert.deepEqual(data.frameEvidence.map(f => f.id), times.map((_,i) => `frame-${i}`));
    assert.deepEqual(data.frameEvidence.map(f => f.sourcePtsMs), times);
    assert.equal(data.currentFrameId, 'frame-4');
    assert.deepEqual(data.frameEvidence.filter(f => f.isQuestionFrame).map(f => f.id), ['frame-4']);
    assert.equal(JSON.parse(context.imageParts[8].text).isQuestionFrame, true);
    for (let i=0;i<times.length;i++) {
        assert.equal(JSON.parse(context.imageParts[i*2].text).frameId, `frame-${i}`);
        assert.ok(data.allowedEvidenceIds.includes(`frame-${i}`));
        assert.equal(context.evidence.get(`frame-${i}`).timestampMs, times[i]);
    }
    const answer = { seq: 0, kind: 'visual', text: '사람이 화면 앞에 서 있습니다.', evidenceIds: ['frame-4'] };
    assert.equal(validateSentence(answer, context).accepted, true);
    for (const badId of ['frame-99','frame-23223','frame-23.223']) assert.equal(validateSentence({ ...answer, evidenceIds: [badId] }, context).reason, 'evidence');
});
test('discarding every generated sentence is a validation error, never a fabricated screen-unknown response', async t => {
    const frame = await frameFixture(t), spoken = [], logs = [];
    const store = createQaRequestStore(), { request } = store.accept(1, input);let recorded = false;
    await createQaGeneration({ store, getVideo: () => video, media: { prepare: async () => ({ frames: [frame(12000)], subtitles: { cues: [] } }) },
        model: { generateContentStream: async () => ({ response: Promise.resolve({ usageMetadata: { totalTokenCount: 10 } }),
            stream: (async function* () { yield { text: () => JSON.stringify({ seq: 0, text: '사람이 서 있습니다.', kind: 'visual', evidenceIds: ['frame-99'] }) + '\n' }; })() }) },
        speech: { mp3: async text => { spoken.push(text); return Buffer.from('mp3'); } }, recordUsage: () => { recorded = true; }, log: line => logs.push(line) })(request);
    assert.equal(request.status, 'failed'); assert.equal(request.events.at(-1).data.code, 'QA_ANSWER_VALIDATION_FAILED');
    assert.deepEqual(spoken, []); assert.deepEqual(request.sentences, []); assert.ok(recorded);
    assert.ok(logs.some(line => line.includes('"suppliedIds":["frame-99"]')));
});

test('visual answers may add script context to an actual frame but cannot replace the frame with a script or external source', async t => {
    const frame = await frameFixture(t);
    const context = await createQaContext({ request: input, video, media: { frames: [frame(12000)], subtitles: { cues: [] } } });
    const candidate = { seq: 0, kind: 'visual', text: '사람이 노트북을 사용하고 있습니다.', evidenceIds: ['script-0', 'frame-0'] };
    assert.equal(validateSentence(candidate, context).accepted, true);
    assert.equal(validateSentence({ ...candidate, kind: 'screen_text' }, context).accepted, true);
    assert.equal(validateSentence({ ...candidate, evidenceIds: ['script-0'] }, context).accepted, false);
    context.evidence.set('search-0', { kind: 'external', claim: '외부 주장입니다.' });
    assert.equal(validateSentence({ ...candidate, evidenceIds: ['frame-0', 'search-0'] }, context).accepted, false);
});
