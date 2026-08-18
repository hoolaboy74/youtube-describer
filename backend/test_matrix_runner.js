#!/usr/bin/env node

/**
 * Local vs Remote Video and Prompt Anomaly Matrix Test Runner
 * 
 * 실행: node test_matrix_runner.js [youtube_url]
 * Default YouTube URL: https://www.youtube.com/watch?v=OT0wMk7yIEo (유퀴즈 놀란 감독)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const videoProcessor = require('./videoProcessor');

const API_KEY = process.env.GOOGLE_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.5-flash";

if (!API_KEY) {
    console.error('오류: GOOGLE_API_KEY가 .env 파일에 존재하지 않습니다.');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const youtubeUrl = process.argv[2] || "https://www.youtube.com/watch?v=OT0wMk7yIEo";
const videoId = "OT0wMk7yIEo";

const baseTempDir = path.join(__dirname, 'temp_matrix_test');
if (fs.existsSync(baseTempDir)) {
    fs.rmSync(baseTempDir, { recursive: true, force: true });
}
fs.mkdirSync(baseTempDir, { recursive: true });

const tempVideoFilename = `video_matrix_${videoId}.mp4`;
const tempVideoPath = path.join(baseTempDir, tempVideoFilename);
const reportFilePath = path.join(__dirname, `matrix_test_report_${process.platform === 'darwin' ? 'local' : 'remote'}.json`);

function runProcess(cmd, args, ignoreSubErrors = false) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args);
        let stderr = '';
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('close', code => {
            const hasVideo = fs.existsSync(tempVideoPath) && fs.statSync(tempVideoPath).size > 0;
            if (code === 0 || (ignoreSubErrors && hasVideo && stderr.includes('subtitle'))) {
                resolve();
            } else {
                reject(new Error(`${cmd} failed with code ${code}. Stderr: ${stderr}`));
            }
        });
    });
}

// 쿠키 파일 탐색 헬퍼 추가
const getRandomCookiePath = () => {
    const customCookiePath = path.join(__dirname, 'my_cookies.txt');
    if (fs.existsSync(customCookiePath)) {
        return customCookiePath;
    }
    const cookiesDir = path.join(__dirname, 'cookies');
    if (!fs.existsSync(cookiesDir)) {
        const defaultCookiePath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(defaultCookiePath)) return defaultCookiePath;
        return null;
    }
    const cookieFiles = fs.readdirSync(cookiesDir).filter(file => file.endsWith('_cookies.txt') && fs.statSync(path.join(cookiesDir, file)).size > 0);
    if (cookieFiles.length === 0) {
        const defaultCookiePath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(defaultCookiePath)) return defaultCookiePath;
        return null;
    }
    const randomCookieFile = cookieFiles[Math.floor(Math.random() * cookieFiles.length)];
    return path.join(cookiesDir, randomCookieFile);
};

// 2초 단순 순차 추출 함수 (기존 방식 모사)
async function extractKeyframesSimple(videoPath, outputDir) {
    const extractedTimestamps = [];
    let chunkStderr = '';
    const ffmpegArgs = [
        '-loglevel', 'info',
        '-i', videoPath,
        '-vf', "select='isnan(prev_selected_t)+gte(t-prev_selected_t,2)',scale=640:-1,showinfo",
        '-vsync', '0',
        '-q:v', '5',
        path.join(outputDir, 'frame_simple_%04d.jpg')
    ];

    await new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', ffmpegArgs);
        child.stderr.on('data', data => {
            const chunk = data.toString();
            chunkStderr += chunk;
            const timeMatches = chunk.matchAll(/pts_time:(\d+\.?\d*)/g);
            for (const match of timeMatches) {
                extractedTimestamps.push(parseFloat(match[1]));
            }
        });
        child.on('close', code => {
            if (code === 0 || chunkStderr.includes('Nothing was written')) {
                resolve();
            } else {
                reject(new Error(`FFmpeg simple extraction failed with code ${code}. Stderr: ${chunkStderr}`));
            }
        });
    });

    const sorted = extractedTimestamps.sort((a, b) => a - b);
    // 타임스탬프 중복 매핑 방지를 위해 순서대로 파일들과 연관짓는 메타데이터 리턴
    const files = fs.readdirSync(outputDir).filter(f => f.startsWith('frame_simple_') && f.endsWith('.jpg')).sort();
    return sorted.map((time, idx) => ({
        path: path.join(outputDir, files[idx] || files[files.length - 1]),
        timestamp: time
    }));
}

// SHA-256 계산 함수
function calculateFileHash(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

async function startMatrixTest() {
    console.log(`[Matrix Test] Target Video: ${youtubeUrl}`);
    console.log(`[Matrix Test] Base Temp Directory: ${baseTempDir}`);
    
    // 0단계: yt-dlp 다운로드 및 해시 분석
    console.log('=== [0단계] yt-dlp 비디오 다운로드 및 해시 분석 ===');
    
    // format list dump
    try {
        console.log('Available formats:');
        const formatsList = execSync(`yt-dlp -F "${youtubeUrl}"`, { encoding: 'utf8' });
        console.log(formatsList.split('\n').slice(0, 20).join('\n') + '\n... (생략)');
    } catch (e) {
        console.warn('포맷 리스트 덤프 실패:', e.message);
    }

    let hasPreExistingVideo = false;
    if (fs.existsSync(tempVideoPath) && fs.statSync(tempVideoPath).size > 0) {
        console.log('-> 이미 비디오 파일이 존재하여 다운로드를 생략합니다.');
        hasPreExistingVideo = true;
    }

    if (!hasPreExistingVideo) {
        console.log('비디오 다운로드 시작...');
        const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];
        
        let isSafariImpersonateSupported = false;
        try {
            const output = execSync('yt-dlp --list-impersonate-targets', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            isSafariImpersonateSupported = output.includes('safari');
        } catch (e) {}
        const impersonateArgs = isSafariImpersonateSupported ? ['--impersonate', 'safari'] : [];

        const ytdlpArgs = [
            '-f', 'bestvideo[height<=360][acodec=none][ext=mp4]/best[height<=360]',
            '-o', tempVideoPath,
            '--force-ipv4',
            '--legacy-server-connect',
            '--no-check-certificate',
            '--write-auto-sub',
            '--write-sub',
            '--sub-lang', 'en' // 맷 데이먼의 자막 누락 검증을 위해 영어 자동자막
        ];

        if (process.platform === 'darwin') {
            console.log('로컬 Mac 환경 감지: 크롬 브라우저 쿠키를 직접 추출하여 사용합니다.');
            ytdlpArgs.push('--cookies-from-browser', 'chrome');
        } else {
            const cookiePath = getRandomCookiePath();
            if (cookiePath) ytdlpArgs.push('--cookies', cookiePath);
            if (impersonateArgs.length > 0) ytdlpArgs.push(...impersonateArgs);
            if (proxyArgs.length > 0) ytdlpArgs.push(...proxyArgs);
        }

        ytdlpArgs.push(youtubeUrl);
        await runProcess('yt-dlp', ytdlpArgs, true);
        console.log('비디오 다운로드 완료.');
    }

    const fileSize = fs.statSync(tempVideoPath).size;
    const fileHash = calculateFileHash(tempVideoPath);
    console.log(`- 비디오 파일 크기: ${fileSize} bytes`);
    console.log(`- 비디오 파일 SHA-256 해시: ${fileHash}`);

    // 자막(VTT) 파일 탐색 및 파싱
    let subtitles = '';
    let dialogueTrack = [];
    const vttFile = fs.readdirSync(baseTempDir).find(f => f.endsWith('.vtt'));
    if (vttFile) {
        const vttPath = path.join(baseTempDir, vttFile);
        console.log(`자막 파일 발견: ${vttFile}`);
        const vttContent = fs.readFileSync(vttPath, 'utf-8');
        try {
            // videoProcessor 내 파서 재활용
            dialogueTrack = videoProcessor.parseVttToDialogueTrack ? videoProcessor.parseVttToDialogueTrack(vttContent) : [];
            subtitles = vttContent;
        } catch (e) {
            console.error('자막 파싱 실패:', e.message);
        }
    } else {
        console.log('다운로드된 VTT 자막 파일이 없습니다.');
    }

    // 맷 데이먼 구간 Mock 자막 주입 (429 차단 등으로 자막이 없거나 불완전한 경우 대응)
    if (!subtitles || dialogueTrack.length === 0 || !dialogueTrack.some(t => t.start >= 160 && t.start <= 184)) {
        console.log('-> 맷 데이먼 인터뷰 구간(160~184초)에 대한 Mock 자막 데이터를 강제 주입합니다.');
        subtitles = `WEBVTT

1
00:02:40.000 --> 00:02:44.000
Yeah, he is Nolan.

2
00:02:44.000 --> 00:02:56.000
One of my friends is a baseball agent...

3
00:02:56.000 --> 00:03:04.000
And he told me that.
`;
        dialogueTrack = [
            { start: 160.0, end: 164.0, text: "Yeah, he is Nolan." },
            { start: 164.0, end: 176.0, text: "One of my friends is a baseball agent..." },
            { start: 176.0, end: 184.0, text: "And he told me that." }
        ];
    }

    // 2단계: 프레임 추출
    console.log('\n=== [2단계] 프레임 추출 ===');
    
    // 2-1. 기존 단순 방식 추출
    console.log('2-1. 기존 방식(Simple 2s interval) 추출 중...');
    const simpleDir = path.join(baseTempDir, 'frames_simple');
    fs.mkdirSync(simpleDir);
    const simpleFrames = await extractKeyframesSimple(tempVideoPath, simpleDir);
    console.log(`-> 단순 추출 완료: ${simpleFrames.length}개 프레임.`);

    // 2-2. 하이브리드 방식 추출
    console.log('2-2. 현재 방식(Hybrid Keyframe + Backfill) 추출 중...');
    const hybridDir = path.join(baseTempDir, 'frames_hybrid');
    fs.mkdirSync(hybridDir);
    
    // videoProcessor.extractKeyframesHybrid는 tempVideoFilename(상대경로) 및 baseTempDir를 내부에서 사용함
    // 파일 복사
    fs.copyFileSync(tempVideoPath, path.join(hybridDir, tempVideoFilename));
    const totalDuration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempVideoPath}"`, { encoding: 'utf8' }).trim());
    
    const rawHybridTimestamps = await videoProcessor.extractKeyframesHybrid({
        tempVideoPath: path.join(hybridDir, tempVideoFilename),
        tempVideoFilename: tempVideoFilename,
        baseTempDir: hybridDir,
        totalDuration: totalDuration,
        requestHash: 'MATRIX_HYBRID_TEST'
    });

    const hybridFiles = fs.readdirSync(hybridDir).filter(f => f.endsWith('.jpg') && !f.startsWith('frame_raw_') && !f.startsWith('frame_backfill_')).sort();
    const hybridFrames = rawHybridTimestamps.map((time, idx) => ({
        path: path.join(hybridDir, hybridFiles[idx] || hybridFiles[hybridFiles.length - 1]),
        timestamp: time
    }));
    console.log(`-> 하이브리드 추출 완료: ${hybridFrames.length}개 프레임.`);

    // 3, 4단계 변수 정의
    const promptConfigs = [
        { name: 'simple_ocr', path: path.join(__dirname, 'prompt_template_simple_ocr.txt') },
        { name: 'old', path: path.join(__dirname, 'prompt_template_old.txt') },
        { name: 'current', path: path.join(__dirname, 'prompt_template.txt') }
    ];

    const resolutionConfigs = [
        { name: 'low', mediaResolution: 'MEDIA_RESOLUTION_LOW' },
        { name: 'high', mediaResolution: 'MEDIA_RESOLUTION_HIGH' }
    ];

    const extractionConfigs = [
        { name: 'simple', frames: simpleFrames },
        { name: 'hybrid', frames: hybridFrames }
    ];

    const results = {
        video: {
            size: fileSize,
            hash: fileHash,
            duration: totalDuration
        },
        runs: []
    };

    console.log('\n=== [3단계 & 4단계] AI 대본 생성 테스트 매트릭스 구동 ===');
    
    for (const ext of extractionConfigs) {
        // 160s ~ 184s 구간 프레임 필터링 (테스트 시간 단축 및 정밀 타겟팅)
        const targetFrames = ext.frames.filter(f => f.timestamp >= 160 && f.timestamp <= 184);
        console.log(`\n[추출: ${ext.name}] 160-184초 타겟 프레임 수: ${targetFrames.length}개`);

        for (const res of resolutionConfigs) {
            for (const pr of promptConfigs) {
                console.log(`-> 매트릭스 기동: [추출: ${ext.name}] x [해상도: ${res.name}] x [프롬프트: ${pr.name}]`);
                
                let promptTemplate = fs.readFileSync(pr.path, 'utf-8');
                let prompt = promptTemplate
                    .replace('{{VIDEO_TITLE}}', '유퀴즈 맷 데이먼 테스트')
                    .replace('{{SUBTITLES}}', subtitles.substring(0, 10000))
                    .replace('{{AUDIO_CLASSIFICATION}}', 'mixed')
                    .replace('{{AUDIO_LANGUAGE}}', 'mixed')
                    .replace('{{DIALOGUE_TRACK}}', JSON.stringify(dialogueTrack, null, 2));

                const imageParts = [];
                for (const frame of targetFrames) {
                    if (fs.existsSync(frame.path)) {
                        imageParts.push({
                            inlineData: {
                                data: fs.readFileSync(frame.path).toString("base64"),
                                mimeType: 'image/jpeg'
                            }
                        });
                        imageParts.push({ text: `[Time: ${Math.round(frame.timestamp)}s]` });
                    }
                }

                if (imageParts.length === 0) {
                    console.warn('프레임 이미지가 존재하지 않아 스킵합니다.');
                    continue;
                }

                const model = genAI.getGenerativeModel({ 
                    model: MODEL_NAME, 
                    generationConfig: { 
                        temperature: 0.7, 
                        mediaResolution: res.mediaResolution 
                    } 
                });

                let outputText = '';
                try {
                    const response = await model.generateContent([prompt, ...imageParts]);
                    outputText = response.response.text();
                } catch (err) {
                    console.error(`AI 생성 중 실패: ${err.message}`);
                    outputText = `ERROR: ${err.message}`;
                }

                // 맷 데이먼 대사("baseball agent", "야구", "에이전트", "친구" 등) 포함 여부 자동 체크
                const keywords = ["야구", "에이전트", "에이전시", "친구", "baseball", "agent", "맷", "데이먼", "Damon"];
                const detectedKeywords = keywords.filter(kw => outputText.toLowerCase().includes(kw));
                const containsTargetSub = detectedKeywords.length > 0;

                console.log(`   결과: 대상 자막 포함 여부 = ${containsTargetSub} (검출된 키워드: ${detectedKeywords.join(', ')})`);

                results.runs.push({
                    extraction: ext.name,
                    resolution: res.name,
                    prompt: pr.name,
                    containsTargetSub,
                    detectedKeywords,
                    output: outputText
                });
            }
        }
    }

    fs.writeFileSync(reportFilePath, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\n[Matrix Test] 모든 테스트 완료! 결과 레포트가 생성되었습니다: ${reportFilePath}`);
}

startMatrixTest().catch(err => {
    console.error('Matrix test failed:', err);
    process.exit(1);
});
