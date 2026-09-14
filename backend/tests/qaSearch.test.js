'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { wantsExternalSearch, groundedSearch, EXTERNAL_PREFIX } = require('../modules/qaSearch');
const { validateSentence } = require('../modules/qaSentencePolicy');
const { createQaGeneration } = require('../modules/qaGeneration');
const { createQaRequestStore } = require('../modules/qaRequestStore');
const { extractGoogleSearchQueryCount } = require('../modules/geminiCost');
const claim = '공식 문서에서 지원 여부를 확인할 수 있습니다.';
function response() { return { text: () => claim, usageMetadata: { totalTokenCount: 10 }, candidates: [{ content: { parts: [{ text: claim }] }, groundingMetadata: {
    webSearchQueries: ['query', '', 'query'], groundingChunks: [{ web: { uri: 'https://example.com/source', title: '공식 문서' } }],
    groundingSupports: [{ segment: { text: claim, startIndex: 0, endIndex: Buffer.byteLength(claim) }, groundingChunkIndices: [0] }], searchEntryPoint: { renderedContent: '<div>검색 제안</div>' } } } ] }; }
test('only the current explicit external-search request enables search', () => {
    assert.equal(wantsExternalSearch('현재 화면에 누가 앉아 있나요?'), false);
    assert.equal(wantsExternalSearch('앞서 말한 내용을 검색하지 말고 화면에서만 설명해 주세요.'), false);
    assert.equal(wantsExternalSearch('인터넷에서 공식 자료를 검색해 주세요.'), true);
});
test('search evidence requires actual queries, supported UTF-8 segments and safe source URLs', () => {
    const value = response(); const result = groundedSearch(value); assert.equal(result.evidence.length, 1); assert.equal(extractGoogleSearchQueryCount(value), 1);
    value.candidates[0].groundingMetadata.groundingSupports[0].segment.endIndex--; assert.equal(groundedSearch(value).evidence.length, 0);
    const unsafe = response(); unsafe.candidates[0].groundingMetadata.groundingChunks[0].web.uri = 'javascript:alert(1)'; assert.equal(groundedSearch(unsafe).evidence.length, 0);
    const noSearch = response(); noSearch.candidates[0].groundingMetadata.webSearchQueries = []; assert.equal(groundedSearch(noSearch).evidence.length, 0);
});
test('external claims are attributed explanations, never visual evidence or unsupported paraphrases', () => {
    const evidence = groundedSearch(response()).evidence[0]; const context = { evidence: new Map([[evidence.id, evidence]]), timestampMs: 12000, cues: [], audioClassification: 'unknown' };
    const candidate = { seq: 0, text: EXTERNAL_PREFIX + evidence.claim, kind: 'explanation', evidenceIds: [evidence.id] };
    const result = validateSentence(candidate, context); assert.equal(result.accepted, true); assert.equal(result.sentence.sources[0].url, 'https://example.com/source');
    assert.equal(validateSentence({ ...candidate, kind: 'visual' }, context).accepted, false);
    assert.equal(validateSentence({ ...candidate, text: '외부 자료에 따르면 다른 정보입니다.' }, context).accepted, false);
});
test('external mode retains the full history, invokes one model and sends only grounded text to TTS', async () => {
    const store = createQaRequestStore(); const history = [{ requestId: 'previous-123', timestamp: 50, question: '원문', answer: '이전 답변', status: 'partial' }];
    const { request } = store.accept(1, { requestId: 'request-123', sessionId: 'session-123', videoId: 'abcdefghijk', timestamp: 12, question: '인터넷에서 자료를 검색해 주세요.', history, audioMode: 'mp3' });
    let calls = 0, recorded = 0;
    await createQaGeneration({ store, getVideo: () => ({ duration: 60 }), media: { prepare: async () => ({ frames: [], subtitles: { cues: [] } }) },
        model: { generateContentStream: () => { throw new Error('unexpected second model'); } }, searchModel: { generateContent: async prompt => { calls++; assert.ok(prompt.includes(JSON.stringify(history))); return { response: response() }; } },
        speech: { mp3: async text => { assert.equal(text, EXTERNAL_PREFIX + claim); return Buffer.from('audio'); } }, recordUsage: () => { recorded++; } })(request);
    assert.equal(calls, 1); assert.equal(recorded, 1); assert.equal(request.status, 'completed'); assert.ok(request.events.find(e => e.type === 'generation_done').data.searchSuggestions);
});
