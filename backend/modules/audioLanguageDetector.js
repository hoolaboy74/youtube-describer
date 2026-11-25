const { GoogleGenerativeAI } = require('@google/generative-ai');
const { runMediaProcess } = require('./mediaResourceLimiter');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const VALID_CLASSIFICATIONS = new Set(['korean', 'foreign', 'mixed', 'unknown']);
const FFMPEG_AUDIO_EXTRACT_TIMEOUT_MS = 30000;
const GEMINI_AUDIO_TIMEOUT_MS = parseInt(process.env.GEMINI_AUDIO_TIMEOUT_MS || '90000', 10);
const MAX_INLINE_AUDIO_BYTES = 18 * 1024 * 1024;

function getAudioModelName() {
    return process.env.GEMINI_AUDIO_MODEL || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
}

function isKoreanCode(lang) {
    const normalized = String(lang || '').trim().toLowerCase();
    return normalized === 'ko' || normalized === 'kor' || normalized === 'korean';
}

function isNonKoreanCode(lang) {
    const normalized = String(lang || '').trim().toLowerCase();
    return normalized.length > 0 && !isKoreanCode(normalized) && normalized !== 'unknown' && normalized !== 'und';
}

function formatSecondsAsMmSs(totalSeconds) {
    const secs = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const minutes = Math.floor(secs / 60);
    const remainder = secs % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function parseTimestampValue(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return parseFloat(value.toFixed(2));
    }
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (/^\d+(?:\.\d+)?$/.test(raw)) {
        const num = parseFloat(raw);
        return Number.isFinite(num) && num >= 0 ? parseFloat(num.toFixed(2)) : null;
    }
    const parts = raw.split(':');
    if (parts.length === 2 || parts.length === 3) {
        const nums = parts.map(p => parseFloat(p));
        if (nums.some(n => !Number.isFinite(n) || n < 0)) return null;
        if (parts.length === 2) {
            return parseFloat((nums[0] * 60 + nums[1]).toFixed(2));
        }
        return parseFloat((nums[0] * 3600 + nums[1] * 60 + nums[2]).toFixed(2));
    }
    return null;
}

function mergeForeignAudioSegments(segments) {
    if (!Array.isArray(segments) || segments.length === 0) return [];
    const valid = segments
        .filter(s =>
            isNonKoreanCode(s?.lang) &&
            Number.isFinite(Number(s?.start)) &&
            Number.isFinite(Number(s?.end)) &&
            Number(s.end) > Number(s.start)
        )
        .map(s => ({
            start: parseFloat(Number(s.start).toFixed(2)),
            end: parseFloat(Number(s.end).toFixed(2)),
            lang: String(s.lang).trim().toLowerCase().slice(0, 8)
        }))
        .sort((a, b) => a.start - b.start || a.end - b.end);

    const merged = [];
    for (const seg of valid) {
        const prev = merged[merged.length - 1];
        if (prev && seg.start <= prev.end + 1 && prev.lang === seg.lang) {
            prev.end = Math.max(prev.end, seg.end);
        } else {
            merged.push({ ...seg });
        }
    }
    return merged;
}

function buildAudioAnalysisPrompt(totalDuration) {
    const durationNum = Math.max(0, Math.round(Number(totalDuration) || 0));
    const durationMmSs = formatSecondsAsMmSs(durationNum);
    return [
        '당신은 유튜브 영상의 원음 오디오 트랙을 듣고 발화 언어를 분류하는 정밀 오디오 분석기입니다.',
        `전체 오디오 길이는 ${durationMmSs} (${durationNum}초)입니다.`,
        '',
        '다음 JSON 형식만 출력하십시오. 설명이나 마크다운 코드블록은 출력하지 마십시오.',
        '{',
        '  "audioClassification": "korean" | "foreign" | "mixed" | "unknown",',
        '  "foreignSegments": [',
        '    { "start": "MM:SS", "end": "MM:SS", "lang": "en" }',
        '  ]',
        '}',
        '',
        '분류 기준:',
        '1. "korean": 실제 화자의 발화가 모두 한국어인 경우. 배경음악(BGM, 영어 팝송 가사), 효과음, 한국어 문장 속 짧은 영어 단어·제품명·고유명사만 있는 경우는 반드시 "korean"입니다.',
        '2. "foreign": 실제 화자의 발화가 모두 한국어가 아닌 외국어(영어, 일본어 등)인 경우.',
        '3. "mixed": 한국어 화자(나레이션·진행자·한국인 인터뷰 등)와 외국어 화자(외국어 인터뷰·발표·대화 등)의 문장 단위 실제 발화가 함께 존재하는 경우.',
        '4. "unknown": 실제 사람 발화가 거의 없거나(음악·무음·효과음만 존재) 언어를 확정할 수 없는 경우.',
        '',
        'foreignSegments 작성 규칙:',
        '- audioClassification이 "mixed"일 때만 채우고, "korean" / "foreign" / "unknown"이면 반드시 빈 배열 []로 반환하십시오.',
        '- 실제 외국어 화자가 문장 단위로 말하는 모든 구간(4~5초짜리 짧은 외국어 인터뷰 포함)을 시간순으로 빠짐없이 기록하십시오.',
        '- 한국어 나레이션, 한국인 화자, 배경음악(BGM)·노래·효과음 구간은 절대 포함하지 마십시오.',
        '- start와 end는 반드시 전체 오디오 시작(00:00) 기준의 "MM:SS" 형식으로 작성하고, 전체 길이 ' + durationMmSs + '를 넘지 마십시오.',
        '- 같은 외국어 화자가 2~3초 이내 짧은 숨 고르기만 두고 계속 말하면 한 구간으로 합치되, 한국어 화자가 끼어들면 반드시 구간을 분리하십시오.',
        '- lang은 ISO 639-1 소문자 2자리 언어 코드(예: "en", "ja", "zh", "fr")를 사용하십시오.'
    ].join('\n');
}

function parseGeminiAudioAnalysisResponse(rawText, totalDuration) {
    const fallback = { audioLanguage: 'unknown', foreignAudioSegments: [] };
    if (typeof rawText !== 'string' || !rawText.trim()) return fallback;

    let cleaned = rawText.trim();
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) cleaned = fenced[1].trim();

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (_) {
        const objectMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!objectMatch) return fallback;
        try {
            parsed = JSON.parse(objectMatch[0]);
        } catch (__) {
            return fallback;
        }
    }

    if (!parsed || typeof parsed !== 'object') return fallback;
    const rawClassification = String(parsed.audioClassification || parsed.audioLanguage || 'unknown').trim().toLowerCase();
    const audioLanguage = VALID_CLASSIFICATIONS.has(rawClassification) ? rawClassification : 'unknown';

    if (audioLanguage !== 'mixed') {
        return { audioLanguage, foreignAudioSegments: [] };
    }

    const durationBound = Number.isFinite(Number(totalDuration)) && Number(totalDuration) > 0
        ? Number(totalDuration)
        : Number.POSITIVE_INFINITY;

    const rawSegments = Array.isArray(parsed.foreignSegments) ? parsed.foreignSegments : [];
    const normalizedSegments = [];
    for (const seg of rawSegments) {
        if (!seg || typeof seg !== 'object') continue;
        const start = parseTimestampValue(seg.start);
        const end = parseTimestampValue(seg.end);
        const lang = String(seg.lang || seg.language || 'en').trim().toLowerCase();
        if (start === null || end === null || !isNonKoreanCode(lang)) continue;
        const clampedStart = Math.max(0, Math.min(start, durationBound));
        const clampedEnd = Math.max(0, Math.min(end, durationBound));
        if (clampedEnd <= clampedStart) continue;
        normalizedSegments.push({ start: clampedStart, end: clampedEnd, lang });
    }

    return {
        audioLanguage,
        foreignAudioSegments: mergeForeignAudioSegments(normalizedSegments)
    };
}

async function extractCompactAudioMp3(tempVideoPath, outputPath, bitrate = '24k') {
    const ffmpegArgs = [
        '-y',
        '-hide_banner',
        '-nostdin',
        '-i', tempVideoPath,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-b:a', bitrate,
        '-f', 'mp3',
        outputPath
    ];
    await runMediaProcess('ffmpeg', ffmpegArgs, {
        needs: { ffmpeg: 1 },
        timeoutMs: FFMPEG_AUDIO_EXTRACT_TIMEOUT_MS
    });
}

async function generateWithTimeout(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Gemini audio analysis timed out after ${timeoutMs}ms`)), timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Gemini 3.8 Flash 기반 전체 원음 오디오 1회 분석.
 * audioLanguage('korean'|'foreign'|'mixed'|'unknown')와 mixed 전용 foreignAudioSegments를 반환합니다.
 * 오류 시 보수적으로 'unknown' / []를 반환하고 임시 오디오 파일을 반드시 정리합니다.
 */
async function analyzeAudioLanguage(tempVideoPath, totalDuration, requestHash, options = {}) {
    const startedAt = Date.now();
    const modelName = options.modelName || getAudioModelName();
    const emptyResult = {
        audioLanguage: 'unknown',
        foreignAudioSegments: [],
        usageMetadata: null,
        modelName,
        elapsedMs: 0
    };

    if (!fs.existsSync(tempVideoPath)) {
        logger.error(`[${requestHash}] Audio analysis failed: Video file not found.`);
        return emptyResult;
    }

    const apiKey = options.apiKey || process.env.GOOGLE_API_KEY;
    if (!apiKey || apiKey === 'offline-test-key') {
        logger.warn(`[${requestHash}] Audio analysis skipped: GOOGLE_API_KEY unavailable.`);
        return { ...emptyResult, elapsedMs: Date.now() - startedAt };
    }

    const baseTempDir = path.dirname(tempVideoPath);
    const runId = Math.random().toString(36).substring(2, 10);
    const audioPath = path.join(baseTempDir, `audio_lang_${runId}.mp3`);

    try {
        await extractCompactAudioMp3(tempVideoPath, audioPath, '24k');
        let audioStat = fs.statSync(audioPath);
        if (audioStat.size > MAX_INLINE_AUDIO_BYTES) {
            logger.info(`[${requestHash}] Compact audio ${(audioStat.size / 1024 / 1024).toFixed(2)} MB exceeds inline cap; re-encoding at 16k...`);
            await extractCompactAudioMp3(tempVideoPath, audioPath, '16k');
            audioStat = fs.statSync(audioPath);
        }
        if (audioStat.size === 0 || audioStat.size > MAX_INLINE_AUDIO_BYTES) {
            logger.warn(`[${requestHash}] Audio file unusable for inline Gemini analysis (bytes=${audioStat.size}).`);
            return { ...emptyResult, elapsedMs: Date.now() - startedAt };
        }

        const audioBase64 = (await fs.promises.readFile(audioPath)).toString('base64');
        const prompt = buildAudioAnalysisPrompt(totalDuration);
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
                temperature: 0,
                responseMimeType: 'application/json'
            }
        });

        logger.info(`[${requestHash}] Analyzing full audio with ${modelName} (${(audioStat.size / 1024 / 1024).toFixed(2)} MB MP3)...`);
        const result = await generateWithTimeout(
            model.generateContent([
                { inlineData: { data: audioBase64, mimeType: 'audio/mp3' } },
                { text: prompt }
            ]),
            options.timeoutMs || GEMINI_AUDIO_TIMEOUT_MS
        );

        const rawText = result.response.text();
        const usageMetadata = result.response.usageMetadata || null;
        const parsed = parseGeminiAudioAnalysisResponse(rawText, totalDuration);
        const elapsedMs = Date.now() - startedAt;

        logger.info(
            `[${requestHash}] Gemini audio analysis complete (${elapsedMs}ms): classification=${parsed.audioLanguage}` +
            (parsed.foreignAudioSegments.length > 0
                ? `, foreignSegments=${parsed.foreignAudioSegments.length} [${parsed.foreignAudioSegments.map(s => `${s.start}-${s.end}s:${s.lang}`).join(', ')}]`
                : '')
        );

        return {
            audioLanguage: parsed.audioLanguage,
            foreignAudioSegments: parsed.foreignAudioSegments,
            usageMetadata,
            modelName,
            elapsedMs
        };
    } catch (err) {
        logger.error(`[${requestHash}] Gemini audio language analysis failed:`, err);
        return { ...emptyResult, elapsedMs: Date.now() - startedAt };
    } finally {
        if (fs.existsSync(audioPath)) {
            try { fs.unlinkSync(audioPath); } catch (_) {}
        }
    }
}

async function detectLanguage(tempVideoPath, totalDuration, requestHash, options = {}) {
    const result = await analyzeAudioLanguage(tempVideoPath, totalDuration, requestHash, options);
    return result.audioLanguage;
}

async function detectForeignAudioSegments(tempVideoPath, totalDuration, requestHash, options = {}) {
    const result = await analyzeAudioLanguage(tempVideoPath, totalDuration, requestHash, options);
    return result.audioLanguage === 'mixed' ? result.foreignAudioSegments : [];
}

module.exports = {
    analyzeAudioLanguage,
    detectLanguage,
    detectForeignAudioSegments,
    buildAudioAnalysisPrompt,
    parseGeminiAudioAnalysisResponse,
    parseTimestampValue,
    formatSecondsAsMmSs,
    mergeForeignAudioSegments
};
