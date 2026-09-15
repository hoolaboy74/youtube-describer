'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// videoProcessor performs environment validation during module loading, but
// these tests exercise only pure selection/parsing/canonicalization helpers.
process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'test-key';
const {
    canonicalizeModelOutput,
    parseVttToDialogueTrack,
    selectDialogueSubtitle,
    selectMixedEnglishReferenceSubtitle
} = require('./videoProcessor');

test('foreign and unknown audio prefer original English VTT over Korean translated VTT', () => {
    const files = ['video.ko.vtt', 'video.en.vtt', 'video.en-US.vtt'];

    assert.deepEqual(selectDialogueSubtitle(files, 'foreign'), {
        file: 'video.en.vtt',
        sourceLanguage: 'en',
        foreign: true,
        sourceRole: 'original_dialogue',
        logLabel: 'foreign/unknown video: loaded English source subtitles'
    });
    assert.equal(selectDialogueSubtitle(files, 'unknown').file, 'video.en.vtt');
    assert.equal(selectDialogueSubtitle(['video.ko.vtt'], 'foreign'), null);
    assert.equal(selectDialogueSubtitle(['video.ko.vtt'], 'unknown'), null);
});

test('model-produced screen text uses the supplied multimodal frame as evidence without OCR', () => {
    const result = canonicalizeModelOutput('[6][txt] 화면 하단에 안내 문구가 보입니다.', {
        duration: 20,
        audioLanguage: 'mixed',
        frameEvidence: [{ id: 'frame-6', timestamp: 6 }]
    });

    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].tag, 'txt');
    assert.equal(result.accepted[0].ttsEligible, true);
    assert.deepEqual(result.accepted[0].provenance, {
        kind: 'screen_text',
        frameEvidence: [{ id: 'frame-6', timestamp: 6 }],
        visibleTextEvidence: '화면 하단에 안내 문구가 보입니다.',
        source: 'gemini_multimodal_frame'
    });
});

test('Korean and mixed audio prefer Korean source VTT', () => {
    const files = ['video.ko.vtt', 'video.en.vtt'];

    assert.equal(selectDialogueSubtitle(files, 'korean').file, 'video.ko.vtt');
    assert.equal(selectDialogueSubtitle(files, 'mixed').file, 'video.ko.vtt');
    assert.equal(selectDialogueSubtitle(['video.en.vtt'], 'mixed'), null);
    assert.equal(selectMixedEnglishReferenceSubtitle(files, 'mixed'), 'video.en.vtt');
    assert.equal(selectMixedEnglishReferenceSubtitle(files, 'korean'), null);
});

test('mixed VTT keeps foreign marking as diagnostics without blocking aligned model translations', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-describer-vtt-'));
    const koreanVttPath = path.join(directory, 'video.ko.vtt');
    const englishVttPath = path.join(directory, 'video.en.vtt');
    try {
        fs.writeFileSync(koreanVttPath, [
            'WEBVTT',
            '',
            '00:00:00.000 --> 00:00:02.000',
            '한국어 진행자의 질문입니다.',
            '',
            '00:00:02.000 --> 00:00:03.100',
            '한국어 질문입니다. This answer starts here.',
            '',
            '00:00:03.100 --> 00:00:06.000',
            'This answer starts here and continues in English.',
            '',
            '00:00:06.000 --> 00:00:08.000',
            '아이폰 iPhone 17을 소개합니다.',
            ''
        ].join('\n'));
        fs.writeFileSync(englishVttPath, [
            'WEBVTT',
            '',
            '00:00:03.100 --> 00:00:06.000',
            'This answer starts here and continues in English.',
            ''
        ].join('\n'));

        const englishReference = parseVttToDialogueTrack(englishVttPath, 'en', {
            sourceRole: 'mixed_language_reference'
        });
        const dialogueTrack = parseVttToDialogueTrack(koreanVttPath, 'ko', {
            sourceRole: 'original_dialogue',
            mixedEnglishReferenceTrack: englishReference
        });
        const result = canonicalizeModelOutput([
            '[2][trans] 한국어 질문을 다시 읽으면 안 됩니다.',
            '[4][trans] 이 답변은 여기서 시작해 영어로 이어집니다.'
        ].join('\n'), {
            duration: 20,
            audioLanguage: 'mixed',
            dialogueTrack,
            dialogueTimestampTolerance: 1,
            frameEvidence: []
        });

        assert.equal(dialogueTrack.filter(interval => interval.foreign).length, 1);
        assert.equal(dialogueTrack[2].foreign, true);
        assert.equal(dialogueTrack[2].sourceLanguage, 'ko');
        assert.equal(dialogueTrack[1].foreign, undefined);
        assert.equal(dialogueTrack[3].foreign, undefined);
        assert.equal(result.accepted.length, 2);
        assert.deepEqual(result.accepted.map(event => event.timestamp), [2, 4]);
        assert.equal(result.accepted[1].provenance.dialogueInterval.foreign, true);
        assert.equal(result.quarantined.length, 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('mixed VTT captions remain translatable when their confirmed timed context lacks an aligned reference', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-describer-vtt-'));
    const koreanVttPath = path.join(directory, 'video.ko.vtt');
    try {
        fs.writeFileSync(koreanVttPath, [
            'WEBVTT',
            '',
            '00:00:03.000 --> 00:00:06.000',
            'This may be an unverified English caption.',
            ''
        ].join('\n'));
        const dialogueTrack = parseVttToDialogueTrack(koreanVttPath, 'ko', {
            sourceRole: 'original_dialogue',
            mixedEnglishReferenceTrack: []
        });
        const result = canonicalizeModelOutput('[4][trans] 확인되지 않은 영어 자막을 번역하면 안 됩니다.', {
            duration: 20,
            audioLanguage: 'mixed',
            dialogueTrack,
            dialogueTimestampTolerance: 1,
            frameEvidence: []
        });

        assert.equal(dialogueTrack[0].foreign, undefined);
        assert.equal(result.accepted.length, 1);
        assert.equal(result.accepted[0].ttsEligible, true);
        assert.equal(result.quarantined.length, 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('mixed-language prompts do not use VTT foreign metadata as the sole translation gate', () => {
    for (const filename of ['prompt_template_codex_v2.txt', 'prompt_template_writer_v13.txt']) {
        const prompt = fs.readFileSync(path.join(__dirname, filename), 'utf8');
        assert.match(prompt, /foreign: true.*유용한 근거.*유일한 제외 기준/s);
        assert.match(prompt, /실제 한국어 발화.*번역하지 마십시오/);
        assert.match(prompt, /시작보다 앞당기지 (?:마십시오|않는)/);
    }
});

test('foreign translation provenance matches a timestamp inside a fractional VTT cue', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-describer-vtt-'));
    const vttPath = path.join(directory, 'video.en.vtt');
    try {
        fs.writeFileSync(vttPath, [
            'WEBVTT',
            '',
            '00:00:05.50 --> 00:00:08.00 align:start position:0%',
            'This is the original English speech.',
            ''
        ].join('\n'));

        const dialogueTrack = parseVttToDialogueTrack(vttPath, 'en', {
            foreign: true,
            sourceRole: 'original_dialogue'
        });
        const result = canonicalizeModelOutput('[6][trans] 이것은 원래 영어 대사의 번역입니다.', {
            duration: 20,
            audioLanguage: 'foreign',
            dialogueTrack,
            frameEvidence: []
        });

        assert.equal(dialogueTrack.length, 1);
        assert.equal(dialogueTrack[0].confirmed, true);
        assert.equal(dialogueTrack[0].foreign, true);
        assert.equal(result.accepted.length, 1);
        assert.equal(result.accepted[0].ttsEligible, true);
        assert.deepEqual(result.accepted[0].provenance.dialogueInterval, {
            start: 5.5,
            end: 8,
            sourceLanguage: 'en',
            sourceText: 'this is the original english speech.',
            confirmed: true,
            foreign: true
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('foreign translation binds when integer output rounds a fractional cue start', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-describer-vtt-'));
    const vttPath = path.join(directory, 'video.en.vtt');
    try {
        fs.writeFileSync(vttPath, [
            'WEBVTT',
            '',
            '00:00:00.16 --> 00:00:00.96',
            'This short cue is represented by an integer timestamp.',
            ''
        ].join('\n'));

        const dialogueTrack = parseVttToDialogueTrack(vttPath, 'en', {
            foreign: true,
            sourceRole: 'original_dialogue'
        });
        const result = canonicalizeModelOutput('[1][trans] 짧은 영어 대사의 번역입니다.', {
            duration: 20,
            audioLanguage: 'foreign',
            dialogueTrack,
            dialogueTimestampTolerance: 1,
            frameEvidence: []
        });

        assert.equal(result.accepted.length, 1);
        assert.equal(result.accepted[0].ttsEligible, true);
        assert.equal(result.accepted[0].provenance.dialogueInterval.start, 0.16);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('WebVTT cue settings and whitespace lines preserve the first dialogue cue', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-describer-vtt-'));
    const vttPath = path.join(directory, 'video.en.vtt');
    try {
        fs.writeFileSync(vttPath, [
            'WEBVTT',
            '',
            '00:00:00.000 --> 00:00:01.710 align:start position:0%',
            ' ',
            'Google<00:00:00.320><c> Gemini</c> just released.',
            '',
            '00:00:01.710 --> 00:00:03.150 align:start position:0%',
            'Google Gemini just released a bunch of brand new models.',
            ''
        ].join('\n'));

        const dialogueTrack = parseVttToDialogueTrack(vttPath, 'en', {
            foreign: true,
            sourceRole: 'original_dialogue'
        });
        const result = canonicalizeModelOutput('[1][trans] 구글 제미나이가 새로운 소식을 발표했습니다.', {
            duration: 20,
            audioLanguage: 'foreign',
            dialogueTrack,
            dialogueTimestampTolerance: 1,
            frameEvidence: []
        });

        assert.equal(dialogueTrack[0].start, 0);
        assert.equal(dialogueTrack[0].end, 1.71);
        assert.match(dialogueTrack[0].sourceText, /Google Gemini/);
        assert.equal(result.accepted.length, 1);
        assert.equal(result.accepted[0].provenance.dialogueInterval.end, 1.71);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('mixed audio retains Korean VTT provenance without blocking a model translation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-describer-vtt-'));
    const vttPath = path.join(directory, 'video.ko.vtt');
    try {
        fs.writeFileSync(vttPath, [
            'WEBVTT',
            '',
            '00:00:00.000 --> 00:00:03.000 align:start position:0%',
            '한국어 나레이션입니다.',
            ''
        ].join('\n'));

        const dialogueTrack = parseVttToDialogueTrack(vttPath, 'ko', {
            sourceRole: 'original_dialogue'
        });
        const result = canonicalizeModelOutput('[1][trans] 한국어 나레이션을 번역하면 안 됩니다.', {
            duration: 20,
            audioLanguage: 'mixed',
            dialogueTrack,
            dialogueTimestampTolerance: 1,
            frameEvidence: []
        });

        assert.equal(dialogueTrack[0].sourceLanguage, 'ko');
        assert.equal(dialogueTrack[0].foreign, undefined);
        assert.equal(result.accepted.length, 1);
        assert.equal(result.accepted[0].ttsEligible, true);
        assert.equal(result.quarantined.length, 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
