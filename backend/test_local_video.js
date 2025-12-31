const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config(); 

// --- 커맨드 라인 인자 파싱 ---
const args = process.argv.slice(2);
let videoPath = null;
let subtitlePath = null;
let promptPath = path.join('../../test', 'prompt_template.txt');
let modelName = "gemini-2.5-pro";

for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
        case '-s':
            videoPath = args[++i];
            break;
        case '-t':
            subtitlePath = args[++i];
            break;
        case '-p':
            promptPath = args[++i];
            break;
        case '-m':
            modelName = args[++i];
            break;
    }
}

if (!videoPath) {
    console.error("Usage: node test_local_video.js -s <video_file> [-t <subtitle_file>] [-p <prompt_file>] [-m <model_name>]");
    process.exit(1);
}

// 자막 경로 자동 설정 (입력되지 않은 경우)
if (!subtitlePath) {
    const ext = path.extname(videoPath);
    subtitlePath = videoPath.replace(ext, '.ko.vtt');
}

// --- 설정 ---
const MODEL_NAME = modelName;
const TEST_DIR = path.dirname(videoPath); // 결과 파일은 영상과 같은 위치에 저장
const API_KEY = process.env.GOOGLE_API_KEY;

if (!API_KEY) {
    console.error("Error: GOOGLE_API_KEY is not defined in .env file.");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

// --- 유틸리티 함수 ---
function preprocessVtt(vttContent) {
    if (!vttContent) return '';
    return vttContent.replace(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g, (match, hh, mm, ss, ms) => {
        const hours = parseInt(hh, 10);
        const minutes = parseInt(mm, 10);
        const seconds = parseInt(ss, 10);
        const milliseconds = parseInt(ms, 10);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
        return `(${totalSeconds.toFixed(1)}s)`;
    });
}

// --- 메인 로직 ---
async function processSingleVideo() {
        const videoFileName = path.basename(videoPath);
        const videoTitle = path.parse(videoFileName).name;
        const baseTempDir = path.join(TEST_DIR, `temp_${videoTitle}`);
    
        process.stderr.write(`\n=== Processing Video: ${videoTitle} ===\n`);
        process.stderr.write(`Video File: ${videoPath}\n`);
        process.stderr.write(`Subtitle File: ${subtitlePath}\n`);
        process.stderr.write(`Prompt File: ${promptPath}\n`);
        process.stderr.write(`Model: ${MODEL_NAME}\n`);
    
        try {
            // 1. 임시 디렉토리 생성
            if (fs.existsSync(baseTempDir)) {
                fs.rmSync(baseTempDir, { recursive: true, force: true });
            }
            fs.mkdirSync(baseTempDir, { recursive: true });
    
            // 2. 자막 로드
            let subtitleContent = '';
            if (fs.existsSync(subtitlePath)) {
                process.stderr.write(`Loading subtitles...\n`);
                subtitleContent = preprocessVtt(fs.readFileSync(subtitlePath, 'utf-8'));
            } else {
                process.stderr.write(`Warning: Subtitle file not found at ${subtitlePath}\n`);
            }
    
            // 3. 프레임 추출
            process.stderr.write('Extracting frames...\n');
            const allTimestamps = await new Promise((resolve, reject) => {
                const extractedTimestamps = [];
                const ffmpegArgs = [
                    '-i', videoPath,
                    '-vf', "select='isnan(prev_selected_t)+gt(scene,0.4)+gte(t-prev_selected_t,2)',showinfo",
                    '-vsync', 'vfr',
                    path.join(baseTempDir, 'frame-%04d.png')
                ];
    
                const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
                let ffmpegStderr = '';
    
                ffmpegProcess.stderr.on('data', (data) => {
                    const chunk = data.toString();
                    ffmpegStderr += chunk;
                    const timeMatches = chunk.matchAll(/pts_time:(\d+\.?\d*)/g);
                    for (const match of timeMatches) {
                        extractedTimestamps.push(parseFloat(match[1]));
                    }
                });
    
                ffmpegProcess.on('close', (code) => {
                    if (code === 0) {
                        resolve(extractedTimestamps.sort((a, b) => a - b));
                    } else {
                        reject(new Error(`ffmpeg exited with code ${code}. Stderr: ${ffmpegStderr}`));
                    }
                });
            });
    
            process.stderr.write(`Extracted ${allTimestamps.length} frames.\n`);
    
            // 4. Gemini 요청 준비
            const allFrameFiles = fs.readdirSync(baseTempDir).filter(f => f.endsWith('.png')).sort();
            const imageParts = [];
    
            for (let i = 0; i < allTimestamps.length; i++) {
                const timestamp = allTimestamps[i];
                const frameFile = allFrameFiles[i];
                if (frameFile) {
                    const framePath = path.join(baseTempDir, frameFile);
                    imageParts.push({
                        inlineData: {
                            data: fs.readFileSync(framePath).toString("base64"),
                            mimeType: 'image/png'
                        }
                    });
                    imageParts.push({ text: `Timestamp: [${Math.round(timestamp)}]` });
                }
            }
    
            if (imageParts.length === 0) {
                process.stderr.write('No frames extracted. Skipping AI generation.\n');
                return;
            }
    
            // 5. 프롬프트 로드
            let promptTemplate = fs.readFileSync(promptPath, 'utf-8');
            const prompt = promptTemplate
                .replace('{{VIDEO_TITLE}}', videoTitle)
                .replace('{{SUBTITLES}}', subtitleContent);
    
            process.stderr.write('Sending request to Gemini...\n');
            const model = genAI.getGenerativeModel({ 
                model: MODEL_NAME, 
                generationConfig: { temperature: 0.7 } 
            });
    
            const result = await model.generateContentStream([prompt, ...imageParts]);
    
            // 6. 결과 수신 및 stdout 출력
            let fullText = '';
            process.stderr.write('Generating: ');
            
            for await (const chunk of result.stream) {
                const chunkText = chunk.text();
                process.stderr.write('.');
                fullText += chunkText;
            }
            process.stderr.write('\nGeneration complete.\n');
    
            // 최종 결과만 stdout으로 출력
            process.stdout.write(fullText);
    
        } catch (error) {
            process.stderr.write(`Error processing video: ${error.message}\n`);
        } finally {        // 임시 파일 정리
        if (fs.existsSync(baseTempDir)) {
            fs.rmSync(baseTempDir, { recursive: true, force: true });
        }
    }
}

processSingleVideo();