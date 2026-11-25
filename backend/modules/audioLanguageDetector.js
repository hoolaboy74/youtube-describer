const { runMediaProcess } = require('./mediaResourceLimiter');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const whisperBin = process.env.WHISPER_BIN || '/home/chacha/whisper.cpp/build/bin/whisper-cli';
const whisperModel = process.env.WHISPER_MODEL || '/home/chacha/whisper.cpp/models/ggml-tiny-q5_1.bin';
const whisperThreads = process.env.WHISPER_THREADS || '2';
const whisperTimeoutMs = parseInt(process.env.WHISPER_TIMEOUT_MS || '15000', 10);

const MIN_SAMPLE_CONFIDENCE = 0.70;
const SINGLE_OUTLIER_MIN_CONFIDENCE = 0.90;
const TIMELINE_MIN_CONFIDENCE = 0.75;
const FFMPEG_SLICE_TIMEOUT_MS = 25000;
const FFMPEG_MAX_OUTPUTS_PER_CALL = 24;

function isKoreanCode(lang) {
    return lang === 'ko' || lang === 'korean';
}

function isNonKoreanCode(lang) {
    return typeof lang === 'string' && lang.length > 0 && !isKoreanCode(lang) && lang !== 'unknown';
}

function parseWhisperLanguageOutput(stderr) {
    const match = String(stderr || '').match(/auto-detected language:\s*([a-z]{2})(?:\s*\(p\s*=\s*([0-9.]+)\))?/);
    if (!match) return { lang: 'unknown', prob: null };
    const prob = match[2] !== undefined ? parseFloat(match[2]) : null;
    return {
        lang: match[1],
        prob: Number.isFinite(prob) ? prob : null
    };
}

function computeSampleOffsets(totalDuration) {
    const duration = Number(totalDuration);
    if (!Number.isFinite(duration) || duration <= 0) return [];

    let ratios;
    if (duration < 60) {
        ratios = [0.2, 0.5, 0.8];
    } else if (duration < 180) {
        ratios = [0.15, 0.325, 0.5, 0.675, 0.85];
    } else {
        ratios = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    }

    const maxOffset = Math.max(0, duration - 2);
    return ratios.map(r => parseFloat(Math.min(maxOffset, Math.max(0, duration * r)).toFixed(2)));
}

function classifySamples(samples) {
    if (!Array.isArray(samples) || samples.length === 0) return 'unknown';

    const normalized = samples.map(sample => {
        if (typeof sample === 'string') return { lang: sample, prob: null };
        return {
            lang: sample?.lang || 'unknown',
            prob: Number.isFinite(Number(sample?.prob)) && sample?.prob !== null ? Number(sample.prob) : null
        };
    });

    const confident = normalized.filter(s =>
        s.lang !== 'unknown' && (s.prob === null || s.prob >= MIN_SAMPLE_CONFIDENCE)
    );
    const koSamples = confident.filter(s => isKoreanCode(s.lang));
    const nonKoSamples = confident.filter(s => isNonKoreanCode(s.lang));

    if (koSamples.length === 0 && nonKoSamples.length === 0) return 'unknown';
    if (koSamples.length > 0 && nonKoSamples.length === 0) return 'korean';
    if (nonKoSamples.length > 0 && koSamples.length === 0) return 'foreign';

    // On 5+ sample runs, guard against a single BGM/silence outlier flipping
    // a pure Korean or pure English video into `mixed`.
    if (normalized.length >= 5) {
        const koEffective = koSamples.length >= 2 ||
            koSamples.some(s => s.prob === null || s.prob >= SINGLE_OUTLIER_MIN_CONFIDENCE);
        const nonKoEffective = nonKoSamples.length >= 2 ||
            nonKoSamples.some(s => s.prob === null || s.prob >= SINGLE_OUTLIER_MIN_CONFIDENCE);

        if (koEffective && nonKoEffective) return 'mixed';
        if (koEffective && !nonKoEffective) return 'korean';
        if (nonKoEffective && !koEffective) return 'foreign';
        if (koSamples.length > nonKoSamples.length) return 'korean';
        if (nonKoSamples.length > koSamples.length) return 'foreign';
    }

    return 'mixed';
}

function mergeForeignAudioSegments(timelineSamples, minProb = TIMELINE_MIN_CONFIDENCE) {
    if (!Array.isArray(timelineSamples) || timelineSamples.length === 0) return [];
    const foreignSlices = timelineSamples
        .filter(s =>
            isNonKoreanCode(s?.lang) &&
            Number.isFinite(Number(s?.start)) &&
            Number.isFinite(Number(s?.end)) &&
            Number(s.end) > Number(s.start) &&
            (s.prob === null || s.prob === undefined || Number(s.prob) >= minProb)
        )
        .map(s => ({
            start: Number(s.start),
            end: Number(s.end),
            lang: s.lang,
            prob: s.prob === null || s.prob === undefined ? null : Number(s.prob)
        }))
        .sort((a, b) => a.start - b.start || a.end - b.end);

    const merged = [];
    for (const seg of foreignSlices) {
        const prev = merged[merged.length - 1];
        if (prev && seg.start <= prev.end + 1 && prev.lang === seg.lang) {
            prev.end = Math.max(prev.end, seg.end);
            if (prev.prob !== null && seg.prob !== null) {
                prev.prob = Math.max(prev.prob, seg.prob);
            }
        } else {
            merged.push({ ...seg });
        }
    }
    return merged;
}

async function runProcess(cmd, args, timeoutMs = FFMPEG_SLICE_TIMEOUT_MS) {
    await runMediaProcess(cmd, args, { needs: { ffmpeg: 1 }, timeoutMs });
}

async function runWhisperDetect(cmd, args, timeoutMs) {
    let stderr;
    try {
        ({ stderr } = await runMediaProcess(cmd, args, { needs: { whisper: 1 }, timeoutMs }));
    } catch (error) {
        // Whisper -dl can report a language with a nonzero exit. Timeouts and
        // spawn failures still fail conservatively instead of parsing partial output.
        if (error.code !== 'MEDIA_EXIT' || error.exitSignal) throw error;
        stderr = error.stderr;
    }
    return parseWhisperLanguageOutput(stderr);
}

async function extractAndDetectSlices(tempVideoPath, sliceSpecs, baseTempDir, runId) {
    const wavPaths = sliceSpecs.map((_, idx) => path.join(baseTempDir, `slice_${runId}_${idx}.wav`));

    try {
        // Extract slices in bounded chunks so FFmpeg stays well within arg/FD limits
        for (let start = 0; start < sliceSpecs.length; start += FFMPEG_MAX_OUTPUTS_PER_CALL) {
            const batchSpecs = sliceSpecs.slice(start, start + FFMPEG_MAX_OUTPUTS_PER_CALL);
            const batchWavs = wavPaths.slice(start, start + FFMPEG_MAX_OUTPUTS_PER_CALL);
            const ffmpegArgs = ['-y'];
            for (const spec of batchSpecs) {
                ffmpegArgs.push('-ss', spec.start.toFixed(2), '-t', spec.duration.toFixed(2), '-i', tempVideoPath);
            }
            batchWavs.forEach((wavPath, idx) => {
                ffmpegArgs.push('-map', `${idx}:a`, '-ar', '16000', '-ac', '1', '-vn', wavPath);
            });
            await runProcess('ffmpeg', ffmpegArgs, FFMPEG_SLICE_TIMEOUT_MS);
        }

        const whisperPromises = wavPaths.map((wavPath, idx) => {
            const whisperArgs = [
                '-m', whisperModel,
                '-f', wavPath,
                '-t', whisperThreads,
                '-bs', '1',
                '-fa',
                '-dl'
            ];
            return runWhisperDetect(whisperBin, whisperArgs, whisperTimeoutMs).then(result => ({
                start: sliceSpecs[idx].start,
                end: parseFloat((sliceSpecs[idx].start + sliceSpecs[idx].duration).toFixed(2)),
                lang: result.lang,
                prob: result.prob
            }));
        });

        const outcomes = await Promise.allSettled(whisperPromises);
        const failed = outcomes.find(outcome => outcome.status === 'rejected');
        if (failed) throw failed.reason;
        return outcomes.map(outcome => outcome.value);
    } finally {
        wavPaths.forEach(p => {
            if (fs.existsSync(p)) {
                try { fs.unlinkSync(p); } catch (e) {}
            }
        });
    }
}

/**
 * 영상 길이에 따른 동적 다점(3/5/9점) 오디오 샘플 추출 및 로컬 Whisper 신뢰도 기반 언어 판별 함수
 */
async function detectLanguage(tempVideoPath, totalDuration, requestHash) {
    if (!fs.existsSync(tempVideoPath)) {
        logger.error(`[${requestHash}] Audio detection failed: Video file not found.`);
        return 'unknown';
    }

    const baseTempDir = path.dirname(tempVideoPath);
    const runId = Math.random().toString(36).substring(2, 10);
    const offsets = computeSampleOffsets(totalDuration);
    if (offsets.length === 0) {
        logger.warn(`[${requestHash}] Audio detection skipped: invalid duration ${totalDuration}`);
        return 'unknown';
    }

    const durationNum = Number(totalDuration);
    const sliceSpecs = offsets.map(offset => ({
        start: offset,
        duration: Math.min(10, Math.max(1, durationNum - offset))
    }));

    logger.info(`[${requestHash}] Extracting ${sliceSpecs.length} audio samples at offsets: [${offsets.map(o => o.toFixed(2)).join(', ')}]s`);

    try {
        logger.info(`[${requestHash}] Running ${sliceSpecs.length} Whisper samples with shared concurrency limit (threads: ${whisperThreads})`);
        const samples = await extractAndDetectSlices(tempVideoPath, sliceSpecs, baseTempDir, runId);
        const formatted = samples.map(s => s.prob !== null ? `${s.lang}(${s.prob.toFixed(2)})` : s.lang);
        logger.info(`[${requestHash}] Whisper detected languages: [${formatted.join(', ')}]`);

        const audioClassification = classifySamples(samples);
        logger.info(`[${requestHash}] Final audio classification result: ${audioClassification}`);
        return audioClassification;
    } catch (err) {
        logger.error(`[${requestHash}] Failed to detect audio language:`, err);
        return 'unknown';
    }
}

/**
 * mixed 판정 영상 전용: 10초 그리드 + 불확실 경계(p < 0.75) 5초 세분화 스캔으로
 * 확인된 외국어 오디오 구간 타임라인을 추출합니다. 실패 시 []로 안전하게 폴백합니다.
 */
async function detectForeignAudioSegments(tempVideoPath, totalDuration, requestHash) {
    const durationNum = Number(totalDuration);
    if (!fs.existsSync(tempVideoPath) || !Number.isFinite(durationNum) || durationNum < 10) {
        return [];
    }

    const baseTempDir = path.dirname(tempVideoPath);
    const runId = `tl_${Math.random().toString(36).substring(2, 8)}`;

    try {
        const coarseSpecs = [];
        for (let t = 0; t + 5 <= durationNum; t += 10) {
            const sliceDur = Math.min(10, durationNum - t);
            if (sliceDur >= 4) {
                coarseSpecs.push({ start: t, duration: sliceDur });
            }
        }
        if (coarseSpecs.length === 0) return [];

        logger.info(`[${requestHash}] Scanning ${coarseSpecs.length} audio timeline windows for mixed foreign segments...`);
        const coarseSamples = await extractAndDetectSlices(tempVideoPath, coarseSpecs, baseTempDir, `${runId}_c`);

        const uncertain = coarseSamples.filter(s => s.prob !== null && s.prob < TIMELINE_MIN_CONFIDENCE && (s.end - s.start) >= 8);
        let combinedSamples = coarseSamples.filter(s => !uncertain.includes(s));

        if (uncertain.length > 0) {
            const fineSpecs = [];
            for (const s of uncertain) {
                const half = parseFloat(((s.end - s.start) / 2).toFixed(2));
                fineSpecs.push({ start: s.start, duration: half });
                fineSpecs.push({ start: parseFloat((s.start + half).toFixed(2)), duration: parseFloat((s.end - s.start - half).toFixed(2)) });
            }
            const fineSamples = await extractAndDetectSlices(tempVideoPath, fineSpecs, baseTempDir, `${runId}_f`);
            combinedSamples = [...combinedSamples, ...fineSamples];
        }

        const segments = mergeForeignAudioSegments(combinedSamples, TIMELINE_MIN_CONFIDENCE);
        logger.info(`[${requestHash}] Detected ${segments.length} confirmed foreign audio segments (refined ${uncertain.length} boundaries): [${segments.map(s => `${s.start}-${s.end}s:${s.lang}`).join(', ')}]`);
        return segments;
    } catch (err) {
        logger.warn(`[${requestHash}] Foreign audio timeline scan failed; continuing with VTT-only mixed pipeline: ${err.message}`);
        return [];
    }
}

module.exports = {
    detectLanguage,
    detectForeignAudioSegments,
    parseWhisperLanguageOutput,
    computeSampleOffsets,
    classifySamples,
    mergeForeignAudioSegments
};
