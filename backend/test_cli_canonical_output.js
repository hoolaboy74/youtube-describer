'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  audioClassificationFor,
  canonicalizeCliOutput
} = require('./modules/cliCanonicalOutput');

const frames = [
  { path: 'frame-0001.jpg', timestamp: 12 },
  { path: 'frame-0002.jpg', timestamp: 18 }
];

test('CLI output maps visual synchronizer items to accepted canonical events', () => {
  const result = canonicalizeCliOutput([
    { timestamp: 12, tag: 'v2', text: '문 옆에 사람이 서 있습니다.' }
  ], { duration: 30, audioLanguage: 'ko', frames, dialogueTrack: [] });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].validationStatus, 'accepted');
  assert.equal(result.accepted[0].provenance.kind, 'visual');
  assert.equal(result.accepted[0].ttsEligible, true);
  assert.equal(result.policyVersion, 'codex-v2');
});

test('CLI foreign translation requires a confirmed matching dialogue interval', () => {
  const context = {
    duration: 30,
    audioLanguage: 'en',
    frames,
    dialogueTrack: [{
      id: 'dialogue-12',
      start: 12,
      end: 15,
      sourceLanguage: 'en',
      sourceText: 'Open the door.',
      confirmed: true,
      foreign: true
    }]
  };
  const result = canonicalizeCliOutput([
    { timestamp: 12, tag: 'trans', text: '문을 여세요.' },
    { timestamp: 18, tag: 'trans', text: '확인되지 않은 번역입니다.' }
  ], context);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].tag, 'trans');
  assert.equal(result.quarantined.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.ok(result.rejected[0].validationReasons.includes('TRANS_REQUIRES_FOREIGN_DIALOGUE'));
});

test('legacy text output fails closed unless it matches foreign dialogue', () => {
  const result = canonicalizeCliOutput([
    { timestamp: 12, type: 'text', text: '임의의 레거시 출력입니다.' }
  ], { duration: 30, audioLanguage: 'ko', frames, dialogueTrack: [] });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].validationStatus, 'rejected');
  assert.ok(result.rejected[0].validationReasons.includes('UNSUPPORTED_TAG'));
});

test('CLI screen text uses the supplied frame as multimodal evidence without OCR', () => {
  const result = canonicalizeCliOutput([
    { timestamp: 12, tag: 'txt', text: '화면에 안내 문구가 보입니다.' }
  ], { duration: 30, audioLanguage: 'ko', frames, dialogueTrack: [] });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].tag, 'txt');
  assert.equal(result.accepted[0].provenance.source, 'gemini_multimodal_frame');
  assert.equal(result.accepted[0].provenance.visibleTextEvidence, '화면에 안내 문구가 보입니다.');
  assert.equal(result.accepted[0].ttsEligible, true);
});

test('CLI audio classification is conservative', () => {
  assert.equal(audioClassificationFor('ko'), 'korean');
  assert.equal(audioClassificationFor('en'), 'foreign');
  assert.equal(audioClassificationFor('mixed'), 'mixed');
  assert.equal(audioClassificationFor(''), 'foreign');
  assert.equal(audioClassificationFor('unknown'), 'unknown');
});
