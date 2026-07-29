#!/usr/bin/env node

/**
 * 로컬 Whisper 병합 1회 vs 3개 동시 구동 벤치마크 테스트 스크립트
 * 
 * 사용법:
 * node test_whisper_concurrency.js <youtube_url>
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const whisperBin = process.env.WHISPER_BIN || '/home/chacha/whisper.cpp/build/bin/whisper-cli';
const whisperModel = process.env.WHISPER_MODEL || '/home/chacha/whisper.cpp/models/ggml-tiny.bin';
const whisperThreads = process.env.WHISPER_THREADS || '4';
const ytdlpPath = 'yt-dlp';

const youtubeUrl = process.argv[2];
if (!youtubeUrl) {
    console.error('오류: YouTube URL이 필요합니다.');
    console.error('사용법: node test_whisper_concurrency.js <youtube_url>');
    process.exit(1);
}

const baseTempDir = path.join(__dirname, 'temp_bench');
if (!fs.existsSync(baseTempDir)) {
    fs.mkdirSync(baseTempDir, { recursive: true });
}

const runId = Math.random().toString(36).substring(2, 10);
const tempVideoPath = path.join(baseTempDir, `bench_video_${runId}.mp4`);

// 임시 파일 경로들
const mergedWavPath = path.join(baseTempDir, `merged_${runId}.wav`);
const sliceWavPaths = [
    path.join(baseTempDir, `slice_${runId}_1.wav`),
    path.join(baseTempDir, `slice_${runId}_2.wav`),
    path.join(baseTempDir, `slice_${runId}_3.wav`)
];

const timings = {};

// 사파리 임퍼스네이트 체크
let isSafariImpersonateSupported = false;
try {
    const output = execSync('yt-dlp --list-impersonate-targets', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    isSafariImpersonateSupported = output.includes('safari');
} catch (e) {}
const impersonateArgs = isSafariImpersonateSupported ? ['--impersonate', 'safari'] : [];
const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

function runProcess(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args);
        let stderr = '';
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} 실패 (코드: ${code}). Stderr: ${stderr.substring(0, 300)}`));
        });
    });
}

async function downloadVideo() {
    console.log('[1/5] 유튜브 비디오 다운로드 중 (360p)...');
    const start = Date.now();
    const ytdlpArgs = [
        '-f', 'best[height<=360][vcodec!=none][acodec!=none]/best[height<=360]/best',
        '-o', tempVideoPath,
        '--force-ipv4',
        '--legacy-server-connect',
        '--no-check-certificate',
        ...impersonateArgs,
        ...proxyArgs,
        youtubeUrl
    ];
    await runProcess(ytdlpPath, ytdlpArgs);
    timings.downloadTime = Date.now() - start;
    console.log(`-> 다운로드 완료. (소요: ${(timings.downloadTime / 1000).toFixed(2)}초, 크기: ${(fs.statSync(tempVideoPath).size / (1024*1024)).toFixed(2)}MB)`);
}

async function main() {
    try {
        console.log(`=== Whisper Concurrency Benchmark 시작 (Run ID: ${runId}) ===`);
        console.log(`Whisper BIN: ${whisperBin}`);
        console.log(`Whisper Model: ${whisperModel}`);
        console.log(`Threads: ${whisperThreads}`);

        await downloadVideo();

        // FFprobe로 길이 구하기
        const ffprobeOut = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempVideoPath}"`);
        const durationSec = parseFloat(ffprobeOut.toString().trim());
        console.log(`영상 전체 길이: ${durationSec.toFixed(2)}초`);

        const p20 = (durationSec * 0.2).toFixed(2);
        const p50 = (durationSec * 0.5).toFixed(2);
        const p80 = (durationSec * 0.8).toFixed(2);
        const offsets = [p20, p50, p80];
        console.log(`샘플링 타임스탬프: 20%(${p20}s), 50%(${p50}s), 80%(${p80}s)`);

        // ==========================================
        // 시나리오 A: 3개 오디오 슬라이스 병합 후 1회 Whisper 구동
        // ==========================================
        console.log('\n[시나리오 A] 3개 구간 오디오 병합 추출 및 1회 Whisper 실행 시작...');
        const startA = Date.now();

        // FFmpeg로 3개 구간 한 번에 추출 및 병합
        const ffmpegMergeArgs = [
            '-y',
            '-ss', p20, '-t', '10', '-i', tempVideoPath,
            '-ss', p50, '-t', '10', '-i', tempVideoPath,
            '-ss', p80, '-t', '10', '-i', tempVideoPath,
            '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[outa]',
            '-map', '[outa]',
            '-ar', '16000',
            '-ac', '1',
            mergedWavPath
        ];
        await runProcess('ffmpeg', ffmpegMergeArgs);
        const sliceTimeA = Date.now() - startA;
        console.log(`-> 오디오 병합 추출 완료 (소요: ${(sliceTimeA / 1000).toFixed(2)}초)`);

        const whisperStartA = Date.now();
        const outputJsonBaseA = path.join(baseTempDir, `out_merged_${runId}`);
        const whisperArgsA = [
            '-m', whisperModel,
            '-f', mergedWavPath,
            '-t', whisperThreads,
            '-bs', '1',
            '-fa',
            '--language', 'auto',
            '--output-json',
            '--output-file', outputJsonBaseA,
            '--no-timestamps'
        ];
        await runProcess(whisperBin, whisperArgsA);
        const whisperTimeA = Date.now() - whisperStartA;
        timings.totalA = Date.now() - startA;
        console.log(`-> Whisper 추론 완료 (소요: ${(whisperTimeA / 1000).toFixed(2)}초)`);

        let langA = 'unknown';
        try {
            const res = JSON.parse(fs.readFileSync(`${outputJsonBaseA}.json`, 'utf8'));
            langA = res.result?.language || 'unknown';
        } catch (e) {}
        console.log(`[결과 A] 최종 감지 언어: ${langA}`);

        // ==========================================
        // 시나리오 B: 3개 구간 개별 오디오 추출 후 동시에 3개 Whisper 동시 구동
        // ==========================================
        console.log('\n[시나리오 B] 3개 구간 개별 추출 및 3개 Whisper 동시 실행 시작...');
        const startB = Date.now();

        // 3개 구간 각각 FFmpeg로 추출
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
            return runProcess('ffmpeg', ffmpegArgs);
        });
        await Promise.all(slicePromises);
        const sliceTimeB = Date.now() - startB;
        console.log(`-> 오디오 개별 추출 완료 (소요: ${(sliceTimeB / 1000).toFixed(2)}초)`);

        const whisperStartB = Date.now();
        const whisperPromises = sliceWavPaths.map((wavPath, idx) => {
            const outputJsonBaseB = path.join(baseTempDir, `out_slice_${runId}_${idx}`);
            const whisperArgsB = [
                '-m', whisperModel,
                '-f', wavPath,
                '-t', whisperThreads,
                '-bs', '1',
                '-fa',
                '--language', 'auto',
                '--output-json',
                '--output-file', outputJsonBaseB,
                '--no-timestamps'
            ];
            return runProcess(whisperBin, whisperArgsB);
        });
        await Promise.all(whisperPromises);
        const whisperTimeB = Date.now() - whisperStartB;
        timings.totalB = Date.now() - startB;
        console.log(`-> 3개 Whisper 동시 추론 완료 (소요: ${(whisperTimeB / 1000).toFixed(2)}초)`);

        const langsB = offsets.map((_, idx) => {
            let lang = 'unknown';
            try {
                const res = JSON.parse(fs.readFileSync(path.join(baseTempDir, `out_slice_${runId}_${idx}.json`), 'utf8'));
                lang = res.result?.language || 'unknown';
            } catch (e) {}
            return lang;
        });
        console.log(`[결과 B] 개별 감지 언어: [${langsB.join(', ')}]`);

        // ==========================================
        // 결과 종합 보고
        // ==========================================
        console.log('\n==================================================');
        console.log('                 벤치마크 테스트 결과');
        console.log('==================================================');
        console.log(`- 시나리오 A (30초 병합 1회 실행)`);
        console.log(`  * 오디오 추출: ${(sliceTimeA / 1000).toFixed(2)}초`);
        console.log(`  * Whisper 추론: ${(whisperTimeA / 1000).toFixed(2)}초`);
        console.log(`  * 총 소요 시간: ${(timings.totalA / 1000).toFixed(2)}초`);
        console.log(`  * 언어 판별 결과: ${langA}`);
        console.log('');
        console.log(`- 시나리오 B (10초x3개 동시 3개 실행)`);
        console.log(`  * 오디오 추출: ${(sliceTimeB / 1000).toFixed(2)}초`);
        console.log(`  * Whisper 추론: ${(whisperTimeB / 1000).toFixed(2)}초`);
        console.log(`  * 총 소요 시간: ${(timings.totalB / 1000).toFixed(2)}초`);
        console.log(`  * 언어 판별 결과: [${langsB.join(', ')}]`);
        console.log('==================================================');

    } catch (err) {
        console.error('테스트 중 에러 발생:', err.message);
    } finally {
        // 클린업
        console.log('\n[정리] 임시 벤치마크 리소스 파일 삭제 중...');
        try {
            if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
            if (fs.existsSync(mergedWavPath)) fs.unlinkSync(mergedWavPath);
            sliceWavPaths.forEach(p => {
                if (fs.existsSync(p)) fs.unlinkSync(p);
            });
            // 생성된 JSON 파일 삭제
            const files = fs.readdirSync(baseTempDir);
            files.forEach(f => {
                if (f.startsWith(`out_merged_${runId}`) || f.startsWith(`out_slice_${runId}`)) {
                    fs.unlinkSync(path.join(baseTempDir, f));
                }
            });
            fs.rmdirSync(baseTempDir);
            console.log('-> 클린업 완료.');
        } catch (e) {
            console.warn('-> 클린업 과정 경고:', e.message);
        }
    }
}

main();
