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
    const { request } = store.accept(1, { requestId: 'request-123', sessionId: 'session-123', videoId: 'abcdefghijk', timestamp: 12, question: '유튜버의 약력에 대해 검색해 주세요.', history, audioMode: 'mp3' });
    let calls = 0, recorded = 0;
    await createQaGeneration({ store, getVideo: () => ({ duration: 60 }), media: { prepare: async () => ({ frames: [], subtitles: { cues: [] } }) },
        model: { generateContentStream: () => { throw new Error('unexpected second model'); } }, searchModel: { generateContent: async prompt => { calls++; assert.ok(prompt.includes(JSON.stringify(history))); return { response: response() }; } },
        speech: { mp3: async text => { assert.equal(text, EXTERNAL_PREFIX + claim); return Buffer.from('audio'); } }, recordUsage: () => { recorded++; } })(request);
    assert.equal(calls, 1); assert.equal(recorded, 1); assert.equal(request.status, 'completed'); assert.ok(request.events.find(e => e.type === 'generation_done').data.searchSuggestions);
});

test('ordinary Korean biography search requests route externally without requiring a search-engine name', () => {
    for (const question of ['유튜버의 약력에 대해 검색해 줘.', '이 사람 약력 검색', '경력을 검색을 해 봐', '프로필을 찾아봐', '학력을 알아봐 주세요']) assert.equal(wantsExternalSearch(question), true, question);
    for (const question of ['검색창은 어디에 있나요?', '화면에 보이는 검색어가 뭐야?', '검색하지 말고 대본으로 설명해 줘.', '검색 없이 설명해 주세요.']) assert.equal(wantsExternalSearch(question), false, question);
});
test('source-grounded biography/causal terms survive visual-inference filters without allowing invented additions', () => {
    for (const claim of ['그의 아버지는 음악 교사입니다.', '부부가 함께 운영하는 채널입니다.', '공연 일정 때문에 활동을 중단했습니다.']) {
        const evidence = { id: 'search-0', kind: 'external', claim, sources: [{ url: 'https://example.com/bio', title: '약력' }] };
        const context = { evidence: new Map([[evidence.id, evidence]]), timestampMs: 0, cues: [], audioClassification: 'unknown' };
        const answer = { seq: 0, kind: 'explanation', text: EXTERNAL_PREFIX + claim, evidenceIds: [evidence.id] };
        assert.equal(validateSentence(answer, context).accepted, true, claim);
        assert.equal(validateSentence({ ...answer, text: EXTERNAL_PREFIX + '그의 어머니는 의사입니다.' }, context).accepted, false);
        assert.equal(validateSentence({ ...answer, kind: 'visual' }, context).accepted, false);
    }
});
test('a search without usable source support reports external-search failure rather than missing screen evidence', async () => {
    const store = createQaRequestStore();
    const { request } = store.accept(1, { requestId: 'search-empty-123', sessionId: 'session-empty-123', videoId: 'abcdefghijk', timestamp: 12, question: '유튜버 약력 검색해 줘.', history: [], audioMode: 'mp3' });
    const spoken = [], logs = [];
    await createQaGeneration({ store, getVideo: () => ({ duration: 60 }), media: { prepare: async () => ({ frames: [], subtitles: { cues: [] } }) },
        model: { generateContentStream: () => assert.fail('search misrouted to scene model') },
        searchModel: { generateContent: async () => ({ response: { text: () => '출처 없는 약력입니다.' } }) },
        speech: { mp3: async text => { spoken.push(text); return Buffer.from('audio'); } }, recordUsage: () => {}, log: line => logs.push(line) })(request);
    assert.equal(request.status, 'completed'); assert.deepEqual(spoken, ['외부 자료를 확인하지 못했습니다.']);
    assert.ok(logs.some(line => line.includes('external_search')));
});
