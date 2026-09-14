const { runMediaProcess } = require('./mediaResourceLimiter');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const whisperBin = process.env.WHISPER_BIN || '/home/chacha/whisper.cpp/build/bin/whisper-cli';
const whisperModel = process.env.WHISPER_MODEL || '/home/chacha/whisper.cpp/models/ggml-tiny-q5_1.bin';
const whisperThreads = process.env.WHISPER_THREADS || '2';
const whisperTimeoutMs = parseInt(process.env.WHISPER_TIMEOUT_MS || '15000', 10);

async function runProcess(cmd, args, timeoutMs) {
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
    return stderr.match(/auto-detected language:\s*([a-z]{2})/)?.[1] || 'unknown';
}

/**
 * 3개 분산 오디오 샘플 추출 및 로컬 Whisper 동시 추론 기반 언어 판별 함수
 */
async function detectLanguage(tempVideoPath, totalDuration, requestHash) {
    if (!fs.existsSync(tempVideoPath)) {
        logger.error(`[${requestHash}] Audio detection failed: Video file not found.`);
        return 'unknown';
    }

    const baseTempDir = path.dirname(tempVideoPath);
    const runId = Math.random().toString(36).substring(2, 10);
    
    const sliceWavPaths = [
        path.join(baseTempDir, `slice_${runId}_1.wav`),
        path.join(baseTempDir, `slice_${runId}_2.wav`),
        path.join(baseTempDir, `slice_${runId}_3.wav`)
    ];

    const p20 = (totalDuration * 0.2).toFixed(2);
    const p50 = (totalDuration * 0.5).toFixed(2);
    const p80 = (totalDuration * 0.8).toFixed(2);
    const offsets = [p20, p50, p80];

    logger.info(`[${requestHash}] Extracting 3 audio samples at offsets: [${offsets.join(', ')}]s`);

    try {
        // 1. FFmpeg 단일 프로세스 기반 다중 오디오 10초 슬라이스 동시 추출
        const ffmpegArgs = [
            '-y',
            '-ss', p20, '-t', '10', '-i', tempVideoPath,
            '-ss', p50, '-t', '10', '-i', tempVideoPath,
            '-ss', p80, '-t', '10', '-i', tempVideoPath,
            '-map', '0:a', '-ar', '16000', '-ac', '1', '-vn', sliceWavPaths[0],
            '-map', '1:a', '-ar', '16000', '-ac', '1', '-vn', sliceWavPaths[1],
            '-map', '2:a', '-ar', '16000', '-ac', '1', '-vn', sliceWavPaths[2]
        ];
        await runProcess('ffmpeg', ffmpegArgs, 15000);

        // 2. Whisper 동시 3개 실행 (양자화 모델, 스레드 제한, -dl 언어 감지 조기 종료 옵션 적용)
        logger.info(`[${requestHash}] Running 3 Whisper samples with shared concurrency limit (threads: ${whisperThreads})`);
        const whisperPromises = sliceWavPaths.map((wavPath) => {
            const whisperArgs = [
                '-m', whisperModel,
                '-f', wavPath,
                '-t', whisperThreads,
                '-bs', '1',
                '-fa',
                '-dl'
            ];
            return runWhisperDetect(whisperBin, whisperArgs, whisperTimeoutMs);
        });

        const outcomes = await Promise.allSettled(whisperPromises);
        const failed = outcomes.find(outcome => outcome.status === 'rejected');
        if (failed) throw failed.reason;
        const detectedLangs = outcomes.map(outcome => outcome.value);
        logger.info(`[${requestHash}] Whisper detected languages: [${detectedLangs.join(', ')}]`);

        // 3. 언어 판정 분석
        const isKo = l => l === 'ko' || l === 'korean';
        const isNonKo = l => l !== 'ko' && l !== 'korean' && l !== 'unknown';

        let audioClassification = 'unknown';
        if (detectedLangs.every(isKo)) {
            audioClassification = 'korean';
        } else if (detectedLangs.every(isNonKo)) {
            audioClassification = 'foreign';
        } else if (detectedLangs.some(isKo) && detectedLangs.some(isNonKo)) {
            audioClassification = 'mixed';
        }

        logger.info(`[${requestHash}] Final audio classification result: ${audioClassification}`);
        return audioClassification;

    } catch (err) {
        logger.error(`[${requestHash}] Failed to detect audio language:`, err);
        return 'unknown';
    } finally {
        // 임시 WAV 파일 정리
        sliceWavPaths.forEach(p => {
            if (fs.existsSync(p)) {
                try { fs.unlinkSync(p); } catch (e) {}
            }
        });
    }
}

module.exports = {
    detectLanguage
};
