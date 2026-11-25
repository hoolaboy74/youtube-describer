'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseWhisperLanguageOutput,
    computeSampleOffsets,
    classifySamples,
    mergeForeignAudioSegments
} = require('../modules/audioLanguageDetector');

test('parseWhisperLanguageOutput extracts language code and confidence probability', () => {
    assert.deepEqual(
        parseWhisperLanguageOutput('whisper_full_with_state: auto-detected language: en (p = 0.996385)'),
        { lang: 'en', prob: 0.996385 }
    );
    assert.deepEqual(
        parseWhisperLanguageOutput('auto-detected language: ko'),
        { lang: 'ko', prob: null }
    );
    assert.deepEqual(
        parseWhisperLanguageOutput('no language line here'),
        { lang: 'unknown', prob: null }
    );
});

test('computeSampleOffsets adapts sample count to video duration (3 / 5 / 9 points)', () => {
    assert.deepEqual(computeSampleOffsets(0), []);
    assert.deepEqual(computeSampleOffsets(-10), []);

    const shortOffsets = computeSampleOffsets(30);
    assert.equal(shortOffsets.length, 3);
    assert.deepEqual(shortOffsets, [6, 15, 24]);

    const mediumOffsets = computeSampleOffsets(120);
    assert.equal(mediumOffsets.length, 5);

    const longOffsets = computeSampleOffsets(620.9);
    assert.equal(longOffsets.length, 9);
    assert.ok(longOffsets.every(o => o >= 0 && o <= 618.9));
});

test('classifySamples shields pure Korean videos with BGM/noise from flipping to mixed', () => {
    // Low-confidence BGM sample (< 0.70) ignored
    const lowConfBgm = [
        { lang: 'ko', prob: 0.99 },
        { lang: 'ko', prob: 0.98 },
        { lang: 'ko', prob: 0.97 },
        { lang: 'ko', prob: 0.99 },
        { lang: 'en', prob: 0.45 },
        { lang: 'ko', prob: 0.99 },
        { lang: 'ko', prob: 0.98 },
        { lang: 'ko', prob: 0.97 },
        { lang: 'ko', prob: 0.96 }
    ];
    assert.equal(classifySamples(lowConfBgm), 'korean');

    // Single moderate-confidence outlier (< 0.90) on 9-point run stays korean
    const singleModerateOutlier = [
        { lang: 'ko', prob: 0.99 },
        { lang: 'ko', prob: 0.98 },
        { lang: 'ko', prob: 0.99 },
        { lang: 'ko', prob: 0.97 },
        { lang: 'en', prob: 0.76 },
        { lang: 'ko', prob: 0.99 },
        { lang: 'ko', prob: 0.98 },
        { lang: 'ko', prob: 0.99 },
        { lang: 'ko', prob: 0.98 }
    ];
    assert.equal(classifySamples(singleModerateOutlier), 'korean');
});

test('classifySamples shields pure English videos from flipping to mixed on a single noisy ko sample', () => {
    const pureEnglishWithNoise = [
        { lang: 'en', prob: 0.99 },
        { lang: 'en', prob: 0.98 },
        { lang: 'en', prob: 0.97 },
        { lang: 'ko', prob: 0.78 },
        { lang: 'en', prob: 0.99 },
        { lang: 'en', prob: 0.98 },
        { lang: 'en', prob: 0.96 },
        { lang: 'en', prob: 0.99 },
        { lang: 'en', prob: 0.97 }
    ];
    assert.equal(classifySamples(pureEnglishWithNoise), 'foreign');
});

test('classifySamples detects mixed audio for bilingual documentaries and high-confidence short foreign clips', () => {
    // YXLWe_pqmjU 9-point empirical pattern
    const docuSamples = [
        { lang: 'en', prob: 0.99 },
        { lang: 'en', prob: 0.99 },
        { lang: 'ko', prob: 0.99 },
        { lang: 'ko', prob: 0.99 },
        { lang: 'en', prob: 0.98 },
        { lang: 'ko', prob: 0.91 },
        { lang: 'en', prob: 0.99 },
        { lang: 'en', prob: 0.98 },
        { lang: 'ko', prob: 0.98 }
    ];
    assert.equal(classifySamples(docuSamples), 'mixed');

    // Single very high-confidence English interview (>= 0.90) in Korean video
    const shortInterview = [
        { lang: 'ko', prob: 0.99 },
        { lang: 'ko', prob: 0.98 },
        { lang: 'en', prob: 0.96 },
        { lang: 'ko', prob: 0.99 },
        { lang: 'ko', prob: 0.98 }
    ];
    assert.equal(classifySamples(shortInterview), 'mixed');

    // Short 3-point video with both languages
    assert.equal(classifySamples([
        { lang: 'ko', prob: 0.95 },
        { lang: 'ko', prob: 0.94 },
        { lang: 'en', prob: 0.85 }
    ]), 'mixed');

    // All low-confidence -> unknown
    assert.equal(classifySamples([
        { lang: 'en', prob: 0.41 },
        { lang: 'ko', prob: 0.52 },
        { lang: 'en', prob: 0.38 }
    ]), 'unknown');
});

test('mergeForeignAudioSegments merges adjacent high-confidence non-Korean intervals and drops Korean/low-conf', () => {
    const merged = mergeForeignAudioSegments([
        { start: 0, end: 10, lang: 'ko', prob: 0.99 },
        { start: 10, end: 20, lang: 'en', prob: 0.98 },
        { start: 20, end: 30, lang: 'en', prob: 0.95 },
        { start: 30, end: 40, lang: 'en', prob: 0.55 }, // below threshold
        { start: 50, end: 60, lang: 'en', prob: 0.99 },
        { start: 60, end: 70, lang: 'ja', prob: 0.92 }
    ]);
    assert.deepEqual(merged, [
        { start: 10, end: 30, lang: 'en', prob: 0.98 },
        { start: 50, end: 60, lang: 'en', prob: 0.99 },
        { start: 60, end: 70, lang: 'ja', prob: 0.92 }
    ]);
});
