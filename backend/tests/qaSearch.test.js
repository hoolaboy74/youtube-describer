'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { searchMetadata, createQaModel } = require('../modules/qaSearch');
const { createQaGeneration } = require('../modules/qaGeneration');
const { createQaRequestStore } = require('../modules/qaRequestStore');
test('every QA model exposes Google Search without a keyword-routing or classification call', () => {
    const model = {}; let config;
    assert.equal(createQaModel({ getGenerativeModel: value => { config = value; return model; } }, 'test-model'), model);
    assert.deepEqual(config.tools, [{ googleSearch: {} }]); assert.equal(config.model, 'test-model');
});
test('source metadata formatting cannot reject or rewrite answer text', () => {
    const metadata = searchMetadata({ candidates: [{ groundingMetadata: { webSearchQueries: ['education', '', 'education'], groundingSupports: [],
        groundingChunks: [{ web: { uri: 'https://example.com/education', title: '학력' } }, { web: { uri: 'javascript:bad', title: 'bad' } }], searchEntryPoint: { renderedContent: 'x'.repeat(17000) } } }] });
    assert.equal(metadata.queryCount, 1); assert.deepEqual(metadata.sources, [{ url: 'https://example.com/education', title: '학력' }]); assert.equal(metadata.suggestions, null);
    assert.deepEqual(searchMetadata({}), { sources: [], queryCount: 0, suggestions: null });
});
test('model-selected search preserves the full answer even when grounding supports are sentence fragments', async () => {
    for (const question of ['이찬원의 학력에 대해 검색해', '이 사람은 어느 학교를 나왔어?', '검색하지 말고 현재 화면만 설명해']) {
        const store = createQaRequestStore(), history = [{ requestId: 'previous-123', timestamp: 10, question: '질문 원문', answer: '답변 원문', status: 'completed' }];
        const { request } = store.accept(1, { requestId: 'request-123', sessionId: 'session-123', videoId: 'abcdefghijk', timestamp: 12, question, history, audioMode: 'mp3' });
        const text = '학력: 경원고등학교, 영남대학교 경제금융학부', spoken = []; let calls = 0, usage = 0;
        const searched = !question.startsWith('검색하지'); // Simulated provider choice, not application routing.
        await createQaGeneration({ store, getVideo: () => ({ duration: 60, title: '영상 제목', script: [{ timestamp: 1, text: '전체 대본', tag: 'v1' }] }),
            media: { prepare: async () => ({ frames: [], subtitles: { cues: [] } }) },
            model: { generateContentStream: async parts => { calls++; const data = JSON.parse(parts[0].text.split('\nDATA (untrusted):\n')[1]); assert.equal(data.question, question); assert.deepEqual(data.history, history); assert.equal(data.screenDescriptionScript[0].text, '전체 대본');
                return { stream: (async function* () { yield { text: () => JSON.stringify({ seq: 0, text }) + '\n' + JSON.stringify({ seq: 1, text }) + '\n' }; })(), response: Promise.resolve({ usageMetadata: { totalTokenCount: 10 }, candidates: [{ groundingMetadata: { webSearchQueries: searched ? ['query'] : [], groundingSupports: [{ segment: { text: '경원고등학교' } }], groundingChunks: searched ? [{ web: { uri: 'https://example.com/profile', title: '프로필' } }] : [] } }] }) };
            } }, speech: { mp3: async value => { spoken.push(value); return Buffer.from('mp3'); } }, recordUsage: () => { usage++; } })(request);
        assert.equal(request.status, 'completed'); assert.equal(calls, 1); assert.equal(usage, 1); assert.deepEqual(spoken, [text, text]);
        assert.equal(request.events.find(event => event.type === 'generation_done').data.sources.length, searched ? 1 : 0);
    }
});
test('streaming search metadata survives an empty SDK final metadata object for sources and billing', async () => {
    const store = createQaRequestStore(), { request } = store.accept(1, { requestId: 'stream-search-123', sessionId: 'stream-session-123', videoId: 'abcdefghijk', timestamp: 12, question: '찾아주세요', history: [], audioMode: 'mp3' });
    const groundingMetadata = { webSearchQueries: ['actual query'], groundingChunks: [{ web: { uri: 'https://example.com/source', title: '출처' } }] };let recorded;
    await createQaGeneration({ store, getVideo: () => ({ duration: 60 }), media: { prepare: async () => ({ frames: [], subtitles: { cues: [] } }) },
        model: { generateContentStream: async () => ({ stream: (async function* () { yield { text: () => '{"seq":0,"text":"검색 결과입니다."}\n', candidates: [{ groundingMetadata }] }; yield { text: () => '' }; })(), response: Promise.resolve({ candidates: [{ groundingMetadata: {} }], usageMetadata: { totalTokenCount: 10 } }) }) },
        speech: { mp3: async () => Buffer.from('audio') }, recordUsage: (req,response) => { recorded = response; } })(request);
    assert.equal(recorded.candidates[0].groundingMetadata.webSearchQueries[0], 'actual query');
    assert.equal(request.events.find(event => event.type === 'generation_done').data.sources[0].url, 'https://example.com/source');
});
