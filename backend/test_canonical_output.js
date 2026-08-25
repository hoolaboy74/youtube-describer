'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const canonical = require('./modules/canonicalOutput');

const duration = 40;
const visual = (timestamp = 12) => ({
    kind: 'visual',
    frameEvidence: [{ frameId: `frame-${timestamp}`, timestamp }]
});
const screenText = (timestamp = 12, text = '긴급 속보') => ({
    kind: 'screen_text',
    frameEvidence: [{ frameId: `frame-${timestamp}`, timestamp, visibleText: text }]
});
const foreignDialogue = (start = 12, end = 16, overrides = {}) => ({
    kind: 'foreign_dialogue',
    dialogueInterval: {
        id: `dialogue-${start}`,
        start,
        end,
        sourceLanguage: 'en',
        confirmed: true,
        ...overrides
    }
});
const parse = (line, overrides = {}) => canonical.parseLegacyLine(line, {
    duration,
    audioLanguage: 'foreign',
    provenance: visual(),
    ...overrides
});

test('exports the canonical API and allowlisted tags', () => {
    for (const name of [
        'POLICY_VERSION',
        'CANONICAL_TAGS',
        'parseLegacyLine',
        'validateCandidate',
        'validateEvents',
        'toLegacyScriptEvent',
        'normalizeText',
        'createCanonicalEventId'
    ]) {
        assert.ok(name in canonical, `${name} is exported`);
    }
    assert.equal(canonical.POLICY_VERSION, 'codex-v2');
    assert.deepEqual(canonical.CANONICAL_TAGS, ['v1', 'v2', 'v3', 'txt', 'trans']);
});

test('parses every canonical tag and retains its legacy verbosity', () => {
    const fixtures = [
        ['v1', 'v1', visual()],
        ['v2', 'v2', visual()],
        ['v3', 'v3', visual()],
        ['txt', 'text', screenText()],
        ['trans', 'translation', foreignDialogue()]
    ];

    for (const [tag, legacyVerbosity, provenance] of fixtures) {
        const event = parse(`[12][${tag}] 확인된 문장입니다.`, {
            provenance,
            audioLanguage: tag === 'trans' ? 'foreign' : 'unknown'
        });
        assert.equal(event.validationStatus, 'accepted', tag);
        assert.equal(event.tag, tag);
        assert.equal(event.legacyVerbosity, legacyVerbosity);
        assert.equal(event.timestamp, 12);
        assert.equal(event.ttsEligible, true);
    }
});

test('rejects malformed, empty, overlong, and out-of-range candidates without clamping', () => {
    const fixtures = [
        ['[0][v2] 시작 시각도 허용하지 않습니다.', 'TIMESTAMP_OUT_OF_RANGE'],
        ['[-1][v2] 음수 시각입니다.', 'INVALID_TIMESTAMP'],
        ['[41][v2] 영상 밖의 시각입니다.', 'TIMESTAMP_OUT_OF_RANGE'],
        ['[NaN][v2] 숫자가 아닙니다.', 'INVALID_TIMESTAMP'],
        ['[12][desc] 허용되지 않은 태그입니다.', 'UNSUPPORTED_TAG'],
        ['[12][v2]   ', 'EMPTY_TEXT']
    ];

    for (const [line, reason] of fixtures) {
        const event = parse(line);
        assert.notEqual(event.validationStatus, 'accepted', line);
        assert.equal(event.ttsEligible, false, line);
        assert.ok(event.validationReasons.includes(reason), `${line}: ${reason}`);
        assert.notEqual(event.timestamp, duration, `${line}: timestamp was not clamped`);
    }

    const overlong = parse('[12][v2] 다섯 글자를 넘는 문장입니다.', { maxTextLength: 5 });
    assert.equal(overlong.validationStatus, 'rejected');
    assert.deepEqual(overlong.validationReasons, ['TEXT_TOO_LONG']);
    assert.equal(overlong.ttsEligible, false);
});

test('requires supported provenance and independent frame evidence', () => {
    const fixtures = [
        [{ timestamp: 12, tag: 'v2', text: '근거가 없습니다.' }, 'MISSING_PROVENANCE'],
        [{ timestamp: 12, tag: 'v2', text: '종류가 다릅니다.', provenance: { kind: 'caption' } }, 'UNSUPPORTED_PROVENANCE'],
        [{ timestamp: 12, tag: 'v2', text: '프레임이 없습니다.', provenance: { kind: 'visual' } }, 'MISSING_FRAME_EVIDENCE'],
        [{ timestamp: 12, tag: 'txt', text: '대사만으로 보이는 글자입니다.', provenance: {
            kind: 'screen_text',
            dialogueInterval: { start: 12, end: 16, sourceLanguage: 'ko', confirmed: true }
        } }, 'MISSING_FRAME_EVIDENCE'],
        [{ timestamp: 12, tag: 'txt', text: '읽을 수 없는 글자입니다.', provenance: {
            kind: 'screen_text',
            frameEvidence: [{ frameId: 'f1', timestamp: 12 }]
        } }, 'MISSING_VISIBLE_TEXT_EVIDENCE']
    ];

    for (const [candidate, reason] of fixtures) {
        const event = canonical.validateCandidate(candidate, { duration, audioLanguage: 'unknown' });
        assert.notEqual(event.validationStatus, 'accepted', reason);
        assert.equal(event.ttsEligible, false);
        assert.ok(event.validationReasons.includes(reason), reason);
    }

    const independentlyVisible = canonical.validateCandidate({
        timestamp: 12,
        tag: 'txt',
        text: '긴급 속보',
        provenance: screenText(12, '긴급 속보')
    }, { duration, audioLanguage: 'unknown' });
    assert.equal(independentlyVisible.validationStatus, 'accepted');
    assert.equal(independentlyVisible.provenance.kind, 'screen_text');
});

test('normalizes whitespace and punctuation for deterministic IDs and duplicate comparison', () => {
    const first = parse('[20][v2] 화면에  문이 보입니다.');
    const second = parse('[20][v2] 화면에 문이 보입니다.');
    assert.equal(canonical.normalizeText(' 화면에   문이 보입니다. '), '화면에 문이 보입니다.');
    assert.equal(first.id, second.id);

    const result = canonical.validateEvents([
        { timestamp: 20, tag: 'v2', text: '화면에  문이 보입니다.', provenance: visual(20) },
        { timestamp: 22, tag: 'v2', text: '화면에 문이 보입니다.', provenance: visual(22) }
    ], { duration, audioLanguage: 'unknown' });
    assert.equal(result.accepted.length, 1);
    assert.equal(result.quarantined.length, 1);
    assert.equal(result.quarantined[0].validationReasons.includes('DUPLICATE_EVENT'), true);
    assert.equal(result.quarantined[0].ttsEligible, false);
});

test('quarantines visual descriptions occupying dialogue and preserves an eligible own translation interval', () => {
    const result = canonical.validateEvents([
        { timestamp: 12, tag: 'v2', text: '대사 중에 겹친 설명입니다.', provenance: visual(12) },
        {
            timestamp: 12,
            tag: 'trans',
            text: '확인된 외국어 번역입니다.',
            audioLanguage: 'foreign',
            provenance: foreignDialogue()
        }
    ], {
        duration,
        audioLanguage: 'foreign',
        dialogueTrack: [{ start: 12, end: 16, sourceLanguage: 'en', confirmed: true }]
    });
    assert.equal(result.quarantined.length, 1);
    assert.equal(result.quarantined[0].tag, 'v2');
    assert.ok(result.quarantined[0].validationReasons.includes('DIALOGUE_OVERLAP'));
    assert.equal(result.quarantined[0].ttsEligible, false);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].tag, 'trans');
    assert.equal(result.accepted[0].ttsEligible, true);
});

test('returns exact accepted, quarantined, and rejected reason buckets', () => {
    const result = canonical.validateEvents([
        { timestamp: 20, tag: 'v2', text: '독립 장면입니다.', provenance: visual(20) },
        { timestamp: 22, tag: 'v2', text: '독립 장면입니다.', provenance: visual(22) },
        { timestamp: 0, tag: 'v2', text: '범위를 벗어났습니다.', provenance: visual(0) }
    ], { duration, audioLanguage: 'unknown' });
    assert.deepEqual(result.accepted.map(event => event.validationStatus), ['accepted']);
    assert.deepEqual(result.quarantined.map(event => event.validationReasons), [['DUPLICATE_EVENT']]);
    assert.deepEqual(result.rejected.map(event => event.validationReasons), [['TIMESTAMP_OUT_OF_RANGE']]);
    assert.ok(result.reasons.some(reason => reason.code === 'DUPLICATE_EVENT'));
    for (const event of [...result.quarantined, ...result.rejected]) assert.equal(event.ttsEligible, false);
});

test('projects canonical txt and trans events to the legacy player contract', () => {
    const fixtures = [
        ['txt', 'text', screenText()],
        ['trans', 'translation', foreignDialogue()]
    ];
    for (const [tag, verbosity, provenance] of fixtures) {
        const event = parse(`[12][${tag}] 호환성 문장입니다.`, {
            provenance,
            audioLanguage: tag === 'trans' ? 'foreign' : 'unknown'
        });
        const legacy = canonical.toLegacyScriptEvent(event);
        assert.deepEqual({
            id: legacy.id,
            timestamp: legacy.timestamp,
            text: legacy.text,
            verbosity: legacy.verbosity,
            validationStatus: legacy.validationStatus,
            ttsEligible: legacy.ttsEligible,
            policyVersion: legacy.policyVersion,
            provenance: legacy.provenance
        }, {
            id: event.id,
            timestamp: 12,
            text: event.text,
            verbosity,
            validationStatus: 'accepted',
            ttsEligible: true,
            policyVersion: 'codex-v2',
            provenance: event.provenance
        });
    }
});
