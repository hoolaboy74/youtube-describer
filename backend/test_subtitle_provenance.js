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
    selectDialogueSubtitle
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

test('Korean audio retains Korean source VTT while mixed audio uses English source VTT', () => {
    const files = ['video.ko.vtt', 'video.en.vtt'];

    assert.equal(selectDialogueSubtitle(files, 'korean').file, 'video.ko.vtt');
    assert.equal(selectDialogueSubtitle(files, 'mixed').file, 'video.en.vtt');
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
