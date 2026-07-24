#!/usr/bin/env node

/**
 * 로컬 Whisper 기반 원음 언어 판별 PoC 스크립트 (방어/우회 로직 일치 + bs=1, fa 최적화)
 * 
 * 사용법:
 * node poc_whisper.js <youtube_url> [offset_percent] [threads]
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const whisperBin = process.env.WHISPER_BIN || '/home/chacha/whisper.cpp/build/bin/whisper-cli';
const whisperModel = process.env.WHISPER_MODEL || '/home/chacha/whisper.cpp/models/ggml-base.bin';
const ytdlpPath = 'yt-dlp';

const youtubeUrl = process.argv[2];
const offsetPercent = parseFloat(process.argv[3] || '20');
const threads = process.argv[4] || '2';

if (!youtubeUrl) {
    console.error('오류: YouTube URL을 인자로 전달하십시오.');
    console.error('사용법: node poc_whisper.js <youtube_url> [offset_percent] [threads]');
    process.exit(1);
}

const baseTempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(baseTempDir)) {
    fs.mkdirSync(baseTempDir, { recursive: true });
}

const runId = Math.random().toString(36).substring(2, 10);
const tempVideoFilename = `poc_video_${runId}.mp4`;
const tempVideoPath = path.join(baseTempDir, tempVideoFilename);
const tempSampleWavName = `poc_sample_${runId}.wav`;
const tempSampleWavPath = path.join(baseTempDir, tempSampleWavName);
const outputJsonBase = path.join(baseTempDir, `poc_whisper_out_${runId}`);
const outputJsonPath = `${outputJsonBase}.json`;

const timings = {
    start: Date.now(),
    downloadEnd: 0,
    sliceEnd: 0,
    whisperEnd: 0
};

// 쿠키 로테이션용 헬퍼
const getRandomCookiePath = (excludePaths = []) => {
    const cookiesDir = path.join(__dirname, 'cookies');
    if (!fs.existsSync(cookiesDir)) {
        const defaultCookiePath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(defaultCookiePath) && !excludePaths.includes(defaultCookiePath)) {
            return defaultCookiePath;
        }
        return null;
    }
    const cookieFiles = fs.readdirSync(cookiesDir)
        .filter(file => file.endsWith('_cookies.txt') && fs.statSync(path.join(cookiesDir, file)).size > 0)
        .map(file => path.join(cookiesDir, file))
        .filter(p => !excludePaths.includes(p));

    if (cookieFiles.length === 0) {
        const defaultCookiePath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(defaultCookiePath) && !excludePaths.includes(defaultCookiePath)) {
            return defaultCookiePath;
        }
        return null;
    }
    return cookieFiles[Math.floor(Math.random() * cookieFiles.length)];
};

// Safari 임퍼스네이트 지원 여부 확인
let isSafariImpersonateSupported = false;
try {
    const output = execSync('yt-dlp --list-impersonate-targets', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    isSafariImpersonateSupported = output.includes('safari');
} catch (e) {}

const impersonateArgs = isSafariImpersonateSupported ? ['--impersonate', 'safari'] : [];
const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

async function main() {
    try {
        console.log(`=== PoC 시작 (Run ID: ${runId}) ===`);
        console.log(`타겟 URL: ${youtubeUrl}`);
        console.log(`추출 시작 지점: 영상의 ${offsetPercent}% 지점`);
        console.log(`바이너리 경로: ${whisperBin}`);
        console.log(`모델 경로: ${whisperModel}`);
        console.log(`스레드 옵션: ${threads} 스레드 (Beam Size: 1, Flash Attention 가속 적용)`);

        if (!fs.existsSync(whisperBin)) {
            throw new Error(`Whisper CLI 바이너리가 존재하지 않습니다: ${whisperBin}`);
        }
        if (!fs.existsSync(whisperModel)) {
            throw new Error(`Whisper 모델 파일이 존재하지 않습니다: ${whisperModel}`);
        }

        // --- Step 1: 음성 포함 단일 360p 비디오 다운로드 (2회 재시도 루프) ---
        console.log('\n[Step 1] yt-dlp 통합 영상 파일 다운로드 시작...');
        const downloadStart = Date.now();
        
        let downloadSuccess = false;
        let downloadAttempt = 1;
        const usedCookiePaths = [];
        let currentCookiePath = getRandomCookiePath();

        while (!downloadSuccess && downloadAttempt <= 2) {
            const isRetry = downloadAttempt === 2;
            if (isRetry) {
                console.log(`-> 1차 시도 실패. 대체 자격증명으로 우회 재시도 중... (Attempt ${downloadAttempt})`);
                if (currentCookiePath) {
                    usedCookiePaths.push(currentCookiePath);
                }
                currentCookiePath = getRandomCookiePath(usedCookiePaths);
            }

            const cookieArgs = currentCookiePath ? ['--cookies', currentCookiePath] : [];
            const ytdlpArgs = [
                '-f', 'best[height<=360][vcodec!=none][acodec!=none]/best[height<=360]/best',
                '-o', tempVideoPath,
                '--force-ipv4',
                '--legacy-server-connect',
                '--no-check-certificate',
                '--plugin-dirs', path.join(__dirname, 'yt_dlp_plugins'),
                '--remote-components', 'ejs:github',
                ...impersonateArgs,
                ...cookieArgs,
                ...proxyArgs,
                youtubeUrl
            ];

            console.log(`-> 실행 명령어: yt-dlp ${ytdlpArgs.filter(a => !a.includes('cookies')).join(' ')} (쿠키: ${currentCookiePath ? path.basename(currentCookiePath) : '없음'})`);

            try {
                await new Promise((resolve, reject) => {
                    const child = spawn(ytdlpPath, ytdlpArgs);
                    let stderr = '';
                    child.stderr.on('data', data => { stderr += data.toString(); });
                    child.on('close', code => {
                        if (code === 0) resolve();
                        else reject(new Error(`yt-dlp 실행 실패 (코드: ${code}). Stderr: ${stderr.substring(0, 500)}`));
                    });
                });
                downloadSuccess = true;
            } catch (err) {
                console.warn(`-> Attempt ${downloadAttempt} 다운로드 실패: ${err.message}`);
                downloadAttempt++;
                if (downloadAttempt > 2) {
                    throw new Error('모든 다운로드 시도가 실패했습니다.');
                }
            }
        }

        timings.downloadEnd = Date.now();
        console.log(`-> 다운로드 성공. (소요 시간: ${((timings.downloadEnd - downloadStart) / 1000).toFixed(2)}초)`);
        console.log(`다운로드 파일 크기: ${(fs.statSync(tempVideoPath).size / (1024 * 1024)).toFixed(2)} MB`);

        // --- Step 2: ffmpeg을 이용하여 영상 총 길이 획득 및 30초 오디오 슬라이싱 ---
        console.log('\n[Step 2] 로컬 오디오 30초 구간 슬라이싱 중...');
        const sliceStart = Date.now();

        // ffprobe로 실제 비디오 재생 길이(초) 파악
        let durationSec = 0;
        try {
            const ffprobeOut = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempVideoPath}"`);
            durationSec = parseFloat(ffprobeOut.toString().trim());
        } catch (e) {
            throw new Error(`영상 길이 획득 실패: ${e.message}`);
        }

        console.log(`-> 영상 총 길이: ${durationSec.toFixed(2)}초`);
        const startSec = (durationSec * (offsetPercent / 100)).toFixed(2);
        console.log(`-> 슬라이싱 구간: ${startSec}초 ~ ${(parseFloat(startSec) + 30).toFixed(2)}초`);

        // ffmpeg을 이용해 로컬에서 30초 오디오(16kHz, mono) wav 추출
        const ffmpegArgs = [
            '-y',
            '-ss', startSec,
            '-t', '30',
            '-i', tempVideoPath,
            '-ar', '16000',
            '-ac', '1',
            '-vn',
            tempSampleWavPath
        ];

        await new Promise((resolve, reject) => {
            const child = spawn('ffmpeg', ffmpegArgs);
            let stderr = '';
            child.stderr.on('data', data => { stderr += data.toString(); });
            child.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg 실행 실패 (코드: ${code}). Stderr: ${stderr}`));
            });
        });

        timings.sliceEnd = Date.now();
        console.log(`-> 오디오 샘플 추출 완료. (소요 시간: ${((timings.sliceEnd - sliceStart) / 1000).toFixed(2)}초)`);

        // --- Step 3: whisper-cli 언어 판별 구동 ---
        console.log('\n[Step 3] whisper.cpp 언어 판별 시작...');
        const whisperStart = Date.now();

        const whisperArgs = [
            '-m', whisperModel,
            '-f', tempSampleWavPath,
            '-t', threads,
            '-bs', '1',
            '-fa',
            '--language', 'auto',
            '--output-json',
            '--output-file', outputJsonBase,
            '--no-timestamps'
        ];

        await new Promise((resolve, reject) => {
            const child = spawn(whisperBin, whisperArgs);
            let stderr = '';
            child.stderr.on('data', data => { stderr += data.toString(); });
            child.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`whisper-cli 실행 실패 (코드: ${code}). Stderr: ${stderr}`));
            });
        });

        timings.whisperEnd = Date.now();
        console.log(`-> Whisper 판별 완료. (소요 시간: ${((timings.whisperEnd - whisperStart) / 1000).toFixed(2)}초)`);

        // --- Step 4: JSON 결과 파싱 및 리포트 작성 ---
        console.log('\n=== PoC 판별 결과 보고 ===');
        if (!fs.existsSync(outputJsonPath)) {
            throw new Error(`Whisper 출력 JSON 파일을 찾을 수 없습니다: ${outputJsonPath}`);
        }

        const rawJson = fs.readFileSync(outputJsonPath, 'utf8');
        const parsed = JSON.parse(rawJson);

        const detectedLanguage = parsed.result?.language || 'unknown';
        console.log(`[+] 최종 감지 언어 코드: ${detectedLanguage}`);
        
        let transcriptionText = '';
        if (Array.isArray(parsed.transcription)) {
            transcriptionText = parsed.transcription.map(t => t.text).join(' ').trim();
        }
        console.log(`[+] 샘플 전사 텍스트:\n"${transcriptionText}"`);

        // 지연 시간 통계
        const totalSec = ((Date.now() - timings.start) / 1000).toFixed(2);
        console.log(`\n=== 레이턴시 세부 보고 (총 소요: ${totalSec}초) ===`);
        console.log(`- Step 1 (yt-dlp 다운로드): ${((timings.downloadEnd - downloadStart) / 1000).toFixed(2)}초`);
        console.log(`- Step 2 (ffmpeg 슬라이싱): ${((timings.sliceEnd - sliceStart) / 1000).toFixed(2)}초`);
        console.log(`- Step 3 (Whisper 추론 시간): ${((timings.whisperEnd - whisperStart) / 1000).toFixed(2)}초`);

    } catch (error) {
        console.error('\n[실패] PoC 에러 발생:', error.message);
    } finally {
        // --- Step 5: 임시 리소스 자원 클린업 ---
        console.log('\n[Step 5] 임시 파일 클린업 중...');
        const tempFiles = [tempVideoPath, tempSampleWavPath, outputJsonPath];
        tempFiles.forEach(file => {
            if (fs.existsSync(file)) {
                try {
                    fs.unlinkSync(file);
                    console.log(`-> 삭제 완료: ${path.basename(file)}`);
                } catch (e) {
                    console.warn(`-> 임시 파일 삭제 에러: ${e.message}`);
                }
            }
        });
        console.log('=== PoC 프로세스 종료 ===');
    }
}

main();
