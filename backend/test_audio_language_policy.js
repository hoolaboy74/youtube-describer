'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseLegacyLine, validateCandidate } = require('./modules/canonicalOutput');

const duration = 60;
const dialogue = (sourceLanguage, overrides = {}) => ({
    kind: 'foreign_dialogue',
    dialogueInterval: {
        start: 12,
        end: 16,
        sourceLanguage,
        confirmed: true,
        ...overrides
    }
});
const screen = (text = '독립 화면 글자') => ({
    kind: 'screen_text',
    frameEvidence: [{ frameId: 'screen-1', timestamp: 12, visibleText: text }]
});
const trans = (audioLanguage, provenance = dialogue('en')) => parseLegacyLine(
    '[12][trans] 확인된 한국어 번역입니다.',
    { duration, audioLanguage, provenance }
);

test('applies distinct policy outcomes for korean, foreign, mixed, and unknown audio', () => {
    const fixtures = [
        ['korean', dialogue('ko'), 'rejected', 'TRANSLATION_NOT_ALLOWED_KOREAN'],
        ['foreign', dialogue('en'), 'accepted', null],
        ['mixed', dialogue('en'), 'accepted', null],
        ['unknown', dialogue('en'), 'rejected', 'TRANSLATION_NOT_ALLOWED_UNKNOWN']
    ];
    for (const [audioLanguage, provenance, status, reason] of fixtures) {
        const event = trans(audioLanguage, provenance);
        assert.equal(event.audioLanguage, audioLanguage);
        assert.equal(event.validationStatus, status, audioLanguage);
        assert.equal(event.tag, 'trans');
        assert.equal(event.ttsEligible, status === 'accepted');
        if (reason) assert.ok(event.validationReasons.includes(reason), audioLanguage);
    }
});

test('does not read Korean dialogue again through identical Korean caption or OCR', () => {
    const event = validateCandidate({
        timestamp: 12,
        tag: 'txt',
        text: '오늘은 출발합니다.',
        provenance: screen('오늘은 출발합니다.')
    }, {
        duration,
        audioLanguage: 'korean',
        dialogueTrack: [{
            start: 12,
            end: 16,
            sourceLanguage: 'ko',
            sourceText: '오늘은 출발합니다.',
            confirmed: true
        }]
    });
    assert.equal(event.validationStatus, 'quarantined');
    assert.equal(event.ttsEligible, false);
    assert.ok(event.validationReasons.includes('DIALOGUE_DUPLICATE'));
});

test('keeps a confirmed foreign dialogue translation eligible even when its Korean caption is visible', () => {
    const event = trans('foreign', {
        kind: 'foreign_dialogue',
        dialogueInterval: {
            start: 12,
            end: 16,
            sourceLanguage: 'ko',
            sourceText: '오늘은 출발합니다.',
            confirmed: true
        }
    });
    assert.equal(event.validationStatus, 'accepted');
    assert.equal(event.ttsEligible, true);
    assert.equal(event.tag, 'trans');
    assert.equal(event.legacyVerbosity, 'translation');
});

test('translates only the confirmed foreign interval in mixed audio', () => {
    const fixtures = [
        ['en', 'accepted', null],
        ['ko', 'quarantined', 'UNCERTAIN_MIXED_INTERVAL'],
        ['unknown', 'quarantined', 'UNCERTAIN_MIXED_INTERVAL']
    ];
    for (const [sourceLanguage, status, reason] of fixtures) {
        const event = trans('mixed', dialogue(sourceLanguage));
        assert.equal(event.validationStatus, status, sourceLanguage);
        assert.equal(event.ttsEligible, status === 'accepted');
        if (reason) assert.ok(event.validationReasons.includes(reason), sourceLanguage);
    }
});

test('never translates unknown audio merely because foreign subtitle metadata exists', () => {
    const event = trans('unknown', dialogue('en', { sourceText: 'Foreign subtitle metadata' }));
    assert.equal(event.validationStatus, 'rejected');
    assert.equal(event.ttsEligible, false);
    assert.ok(event.validationReasons.includes('TRANSLATION_NOT_ALLOWED_UNKNOWN'));
});

test('accepts independently visible screen text for every non-dialogue audio class', () => {
    for (const audioLanguage of ['korean', 'foreign', 'mixed', 'unknown']) {
        const event = parseLegacyLine('[12][txt] 독립 화면 글자', {
            duration,
            audioLanguage,
            provenance: screen()
        });
        assert.equal(event.validationStatus, 'accepted', audioLanguage);
        assert.equal(event.ttsEligible, true);
        assert.equal(event.tag, 'txt');
        assert.equal(event.legacyVerbosity, 'text');
    }
});

test('quarantines uncertain mixed dialogue and rejects unsupported audio decisions', () => {
    const uncertain = trans('mixed', dialogue('undetermined', { confirmed: false }));
    assert.equal(uncertain.validationStatus, 'quarantined');
    assert.equal(uncertain.ttsEligible, false);
    assert.ok(uncertain.validationReasons.includes('UNCONFIRMED_DIALOGUE'));

    const unsupported = validateCandidate({
        timestamp: 12,
        tag: 'trans',
        text: '알 수 없는 분류입니다.',
        audioLanguage: 'maybe',
        provenance: dialogue('en')
    }, { duration });
    assert.equal(unsupported.validationStatus, 'rejected');
    assert.equal(unsupported.ttsEligible, false);
    assert.ok(unsupported.validationReasons.includes('INVALID_AUDIO_LANGUAGE'));
});
