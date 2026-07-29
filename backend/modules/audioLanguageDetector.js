const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const whisperBin = process.env.WHISPER_BIN || '/home/chacha/whisper.cpp/build/bin/whisper-cli';
const whisperModel = process.env.WHISPER_MODEL || '/home/chacha/whisper.cpp/models/ggml-tiny.bin';
const whisperThreads = process.env.WHISPER_THREADS || '2';
const whisperTimeoutMs = parseInt(process.env.WHISPER_TIMEOUT_MS || '15000', 10);

function runProcess(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args);
        let stderr = '';
        
        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('close', code => {
            clearTimeout(timeout);
            if (code === 0) resolve();
            else reject(new Error(`${cmd} 실패 (코드: ${code}). Stderr: ${stderr.substring(0, 300)}`));
        });
    });
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
        // 1. FFmpeg 오디오 10초 슬라이스 3개 병렬 추출
        const slicePromises = offsets.map((offset, idx) => {
            const ffmpegArgs = [
                '-y',
                '-ss', offset,
                '-t', '10',
                '-i', tempVideoPath,
                '-ar', '16000',
                '-ac', '1',
                '-vn',
                sliceWavPaths[idx]
            ];
            return runProcess('ffmpeg', ffmpegArgs, 10000);
        });
        await Promise.all(slicePromises);

        // 2. Whisper 동시 3개 실행 (최대 동시 실행 3, 프로세스당 스레드 2개 제한)
        logger.info(`[${requestHash}] Running 3 concurrent Whisper instances (threads: ${whisperThreads})`);
        const whisperPromises = sliceWavPaths.map((wavPath, idx) => {
            const outputJsonBase = path.join(baseTempDir, `out_whisper_${runId}_${idx}`);
            const whisperArgs = [
                '-m', whisperModel,
                '-f', wavPath,
                '-t', whisperThreads,
                '-bs', '1',
                '-fa',
                '--language', 'auto',
                '--output-json',
                '--output-file', outputJsonBase,
                '--no-timestamps'
            ];
            return runProcess(whisperBin, whisperArgs, whisperTimeoutMs).then(() => {
                let lang = 'unknown';
                let text = '';
                const jsonPath = `${outputJsonBase}.json`;
                if (fs.existsSync(jsonPath)) {
                    try {
                        const res = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                        lang = res.result?.language || 'unknown';
                        if (Array.isArray(res.transcription)) {
                            text = res.transcription.map(t => t.text).join(' ').trim();
                        }
                    } catch (e) {
                        logger.error(`[${requestHash}] Failed to parse Whisper JSON:`, e);
                    } finally {
                        try { fs.unlinkSync(jsonPath); } catch (e) {}
                    }
                }
                return { lang, text };
            });
        });

        const whisperResults = await Promise.all(whisperPromises);
        const detectedLangs = whisperResults.map(r => r.lang);
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
