'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    analyzeAudioLanguage,
    detectLanguage,
    buildAudioAnalysisPrompt,
    parseGeminiAudioAnalysisResponse,
    parseTimestampValue,
    formatSecondsAsMmSs,
    mergeForeignAudioSegments
} = require('../modules/audioLanguageDetector');

test('parseTimestampValue and formatSecondsAsMmSs handle MM:SS, HH:MM:SS, and numeric seconds', () => {
    assert.equal(parseTimestampValue('00:14'), 14);
    assert.equal(parseTimestampValue('08:25'), 505);
    assert.equal(parseTimestampValue('1:02:03.5'), 3723.5);
    assert.equal(parseTimestampValue(124.5), 124.5);
    assert.equal(parseTimestampValue('invalid'), null);
    assert.equal(parseTimestampValue(-5), null);
    assert.equal(formatSecondsAsMmSs(621), '10:21');
});

test('parseGeminiAudioAnalysisResponse handles mixed JSON, fenced JSON, clamping, merging, and ko filtering', () => {
    const raw = [
        '```json',
        JSON.stringify({
            audioClassification: 'mixed',
            foreignSegments: [
                { start: '00:14', end: '00:40', lang: 'en' },
                { start: '00:40', end: '00:42', lang: 'en' },
                { start: '01:00', end: '01:30', lang: 'ko' },
                { start: '08:15', end: '12:00', lang: 'EN' },
                { start: '05:00', end: '04:50', lang: 'en' }
            ]
        }),
        '```'
    ].join('\n');

    const parsed = parseGeminiAudioAnalysisResponse(raw, 621);
    assert.equal(parsed.audioLanguage, 'mixed');
    assert.deepEqual(parsed.foreignAudioSegments, [
        { start: 14, end: 42, lang: 'en' },
        { start: 495, end: 621, lang: 'en' }
    ]);
});

test('parseGeminiAudioAnalysisResponse clears foreignSegments for non-mixed classifications and falls back on malformed JSON', () => {
    const koParsed = parseGeminiAudioAnalysisResponse(JSON.stringify({
        audioClassification: 'korean',
        foreignSegments: [{ start: '00:10', end: '00:20', lang: 'en' }]
    }), 300);
    assert.deepEqual(koParsed, { audioLanguage: 'korean', foreignAudioSegments: [] });

    const foreignParsed = parseGeminiAudioAnalysisResponse(JSON.stringify({
        audioClassification: 'foreign',
        foreignSegments: [{ start: '00:00', end: '05:00', lang: 'en' }]
    }), 300);
    assert.deepEqual(foreignParsed, { audioLanguage: 'foreign', foreignAudioSegments: [] });

    const invalid = parseGeminiAudioAnalysisResponse('not json at all', 300);
    assert.deepEqual(invalid, { audioLanguage: 'unknown', foreignAudioSegments: [] });
});

test('mergeForeignAudioSegments merges adjacent intervals of the same language and keeps distinct languages separate', () => {
    const merged = mergeForeignAudioSegments([
        { start: 10, end: 20, lang: 'en' },
        { start: 21, end: 35, lang: 'en' },
        { start: 35, end: 50, lang: 'ja' },
        { start: 60, end: 70, lang: 'ko' }
    ]);
    assert.deepEqual(merged, [
        { start: 10, end: 35, lang: 'en' },
        { start: 35, end: 50, lang: 'ja' }
    ]);
});

test('buildAudioAnalysisPrompt includes total duration and strict classification boundaries', () => {
    const prompt = buildAudioAnalysisPrompt(621);
    assert.match(prompt, /10:21 \(621초\)/);
    assert.match(prompt, /"audioClassification"/);
    assert.match(prompt, /"foreignSegments"/);
});

test('analyzeAudioLanguage and detectLanguage fail conservatively when file is missing or key is offline', async () => {
    const missing = await analyzeAudioLanguage('/no/such/file.mp4', 60, 'test-missing', { apiKey: 'offline-test-key' });
    assert.equal(missing.audioLanguage, 'unknown');
    assert.deepEqual(missing.foreignAudioSegments, []);

    const tmpFile = path.join(os.tmpdir(), `audio-detector-offline-${process.pid}.mp4`);
    fs.writeFileSync(tmpFile, Buffer.from('dummy'));
    try {
        const lang = await detectLanguage(tmpFile, 60, 'test-offline', { apiKey: 'offline-test-key' });
        assert.equal(lang, 'unknown');
    } finally {
        fs.rmSync(tmpFile, { force: true });
    }
});
