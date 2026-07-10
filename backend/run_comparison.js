require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { spawn } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { preprocessVtt } = require('./utils');

// --- Argument Parsing ---
if (process.argv.length < 3) {
    console.error('Usage: node run_comparison.js <youtubeUrl>');
    process.exit(1);
}
const youtubeUrl = process.argv[2];
const promptFilePath = path.join(__dirname, 'prompt_template.txt');

if (!fs.existsSync(promptFilePath)) {
    console.error(`Error: Prompt file not found at ${promptFilePath}`);
    process.exit(1);
}

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error("GOOGLE_API_KEY is not defined in the environment");
}
const genAI = new GoogleGenerativeAI(API_KEY);

// 비용 계산 헬퍼 함수 (운영 기준 매핑)
const calculateApiCost = (modelName, promptTokenCount, candidatesTokenCount, totalTokenCount) => {
    const modelLower = modelName.toLowerCase();
    let inputRate = 1.25; // Default legacy pro rate (gemini-1.5-pro / gemini-2.5-pro)
    let outputRate = 10.00;
    let inputRateOverLimit = 2.50;
    let outputRateOverLimit = 15.00;

    if (modelLower.includes('3.1-pro')) {
        inputRate = 2.00;
        outputRate = 12.00;
        inputRateOverLimit = 4.00;
        outputRateOverLimit = 18.00;
    } else if (modelLower.includes('3.5-flash')) {
        inputRate = 1.50;
        outputRate = 9.00;
        inputRateOverLimit = 1.50;
        outputRateOverLimit = 9.00;
    } else if (modelLower.includes('1.5-flash')) {
        inputRate = 0.075;
        outputRate = 0.30;
        inputRateOverLimit = 0.15;
        outputRateOverLimit = 0.60;
    }

    const inputCost = (promptTokenCount / 1000000) * (totalTokenCount <= 200000 ? inputRate : inputRateOverLimit);
    const outputCost = (candidatesTokenCount / 1000000) * (totalTokenCount <= 200000 ? outputRate : outputRateOverLimit);
    return inputCost + outputCost;
};

// 쿠키 랜덤 선택 기능 (운영 기준)
const getRandomCookiePath = () => {
    const cookiesDir = path.join(__dirname, 'cookies');
    if (!fs.existsSync(cookiesDir)) return null;
    const cookieFiles = fs.readdirSync(cookiesDir)
        .filter(file => file.endsWith('_cookies.txt') && fs.statSync(path.join(cookiesDir, file)).size > 0);
    if (cookieFiles.length === 0) return null;
    const randomCookieFile = cookieFiles[Math.floor(Math.random() * cookieFiles.length)];
    return path.join(cookiesDir, randomCookieFile);
};

const run = async () => {
    const videoId = crypto.createHash('sha256').update(youtubeUrl).digest('hex').substring(0, 8);
    const requestHash = `comp-${videoId}`;
    const totalTimeLabel = `[${requestHash}] Total Bench Time`;
    console.time(totalTimeLabel);

    const baseTempDir = path.join(__dirname, 'temp', `comp-${videoId}`);

    try {
        console.log(`[${requestHash}] Starting comparison benchmark for ${youtubeUrl}`);
        await fs.promises.mkdir(baseTempDir, { recursive: true });

        // Step 1: Extract ALL data upfront (Title, Subtitles, Frames) - matching videoProcessor.js
        console.log(`[${requestHash}] Step 1: Starting initial data extraction...`);
        const extractionLabel = `[${requestHash}] Initial Data Extraction Time`;
        console.time(extractionLabel);

        const cookiePath = getRandomCookiePath();
        const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];
        const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

        // 1. Get metadata and subtitles in parallel using spawn to allow options
        let videoTitle = "Unknown Title";
        let subtitleContent = "";
        let allTimestamps = [];

        await new Promise((resolve, reject) => {
            const ytdlpArgs = [
                '-f', 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]',
                '-o', '-',
                '--force-ipv4',
                '--legacy-server-connect',
                '--no-check-certificate',
                '--plugin-dirs', path.join(__dirname, 'yt_dlp_plugins'),
                '--remote-components', 'ejs:github',
                '--impersonate', 'safari',
                '--newline',
                '--write-auto-sub',
                '--write-sub',
                '--sub-lang', 'ko,en',
                ...cookieArgs,
                ...proxyArgs,
                youtubeUrl
            ];

            const ffmpegArgs = [
                '-i', '-',
                '-vf', "select='isnan(prev_selected_t)+gte(t-prev_selected_t,2)',showinfo",
                '-vsync', 'vfr',
                path.join(baseTempDir, 'frame-%04d.jpg') // Matching operational jpeg format
            ];

            const ytdlpProcess = spawn('yt-dlp', ytdlpArgs);
            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

            ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);

            let ffmpegStderr = '';
            ffmpegProcess.stderr.on('data', (data) => {
                ffmpegStderr += data.toString();
                const timeMatches = data.toString().matchAll(/pts_time:(\d+\.?\d*)/g);
                for (const match of timeMatches) {
                    allTimestamps.push(parseFloat(match[1]));
                }
            });

            ytdlpProcess.on('error', (err) => reject(new Error(`yt-dlp spawn error: ${err.message}`)));
            ffmpegProcess.on('error', (err) => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
            ffmpegProcess.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg frame extraction exited with code ${code}. Stderr: ${ffmpegStderr}`));
            });
        });

        allTimestamps.sort((a, b) => a - b);

        // Load subtitles (operational ko > en logic)
        const potentialSubtitles = fs.readdirSync(baseTempDir).filter(f => f.endsWith('.vtt'));
        const koSub = potentialSubtitles.find(f => f.includes('.ko.'));
        if (koSub) {
            subtitleContent = preprocessVtt(fs.readFileSync(path.join(baseTempDir, koSub), 'utf-8'));
            console.log(`[${requestHash}] Found and preprocessed Korean subtitles.`);
        } else {
            const enSub = potentialSubtitles.find(f => f.includes('.en.') || f.includes('.en-'));
            if (enSub) {
                subtitleContent = preprocessVtt(fs.readFileSync(path.join(baseTempDir, enSub), 'utf-8'));
                console.log(`[${requestHash}] Found and preprocessed English subtitles.`);
            }
        }

        // Get video title via simple yt-dlp call
        try {
            const { execSync } = require('child_process');
            videoTitle = execSync(`yt-dlp --get-title ${cookieArgs.join(' ')} ${proxyArgs.join(' ')} "${youtubeUrl}"`, { encoding: 'utf8' }).trim();
        } catch (e) {
            console.warn(`[${requestHash}] Could not fetch video title: ${e.message}`);
        }

        console.timeEnd(extractionLabel);
        console.log(`[${requestHash}] Data extraction complete. Title: ${videoTitle}, Frames: ${allTimestamps.length}`);

        // Step 2: Prepare AI inputs
        const allFrameFiles = fs.readdirSync(baseTempDir).filter(f => f.endsWith('.jpg')).sort();
        const imageParts = [];

        for (let i = 0; i < allTimestamps.length; i++) {
            const timestamp = allTimestamps[i];
            const frameFile = allFrameFiles[i];
            if (frameFile) {
                const framePath = path.join(baseTempDir, frameFile);
                if (fs.existsSync(framePath)) {
                    imageParts.push({ inlineData: { data: Buffer.from(fs.readFileSync(framePath)).toString("base64"), mimeType: 'image/jpeg' } });
                    imageParts.push({ text: `Timestamp: [${Math.round(timestamp)}]` });
                }
            }
        }

        if (imageParts.length === 0) {
            console.warn(`[${requestHash}] No frames to process. Exiting.`);
            return;
        }

        let promptTemplate = fs.readFileSync(promptFilePath, 'utf-8');
        promptTemplate = promptTemplate.replace('{{VIDEO_TITLE}}', videoTitle).replace('{{SUBTITLES}}', subtitleContent);

        const requestPayload = [promptTemplate, ...imageParts];

        // Step 3: Run Model comparison
        console.log(`[${requestHash}] Step 3: Running AI Generations...`);

        const models = [
            { name: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (비용 절감 대안)' },
            { name: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview (최고 품질 대안)' }
        ];

        const results = [];

        for (const mSpec of models) {
            console.log(`\n---> Calling ${mSpec.label}...`);
            const start = Date.now();
            try {
                const model = genAI.getGenerativeModel({ model: mSpec.name, generationConfig: { temperature: 0.7 } });
                const response = await model.generateContent(requestPayload);
                const duration = ((Date.now() - start) / 1000).toFixed(2);
                
                let tokenUsage = { prompt: 0, candidates: 0, total: 0 };
                let cost = 0.00;
                
                if (response.response.usageMetadata) {
                    const { promptTokenCount, candidatesTokenCount, totalTokenCount } = response.response.usageMetadata;
                    tokenUsage = { prompt: promptTokenCount, candidates: candidatesTokenCount, total: totalTokenCount };
                    cost = calculateApiCost(mSpec.name, promptTokenCount, candidatesTokenCount, totalTokenCount);
                }

                results.push({
                    name: mSpec.name,
                    label: mSpec.label,
                    duration,
                    tokenUsage,
                    cost,
                    text: response.response.text()
                });
            } catch (err) {
                console.error(`Error with ${mSpec.name}: ${err.message}`);
                results.push({
                    name: mSpec.name,
                    label: mSpec.label,
                    error: err.message
                });
            }
        }

        // Step 4: Output Benchmark Summary
        console.log('\n==================================================');
        console.log('            BENCHMARK RESULTS SUMMARY             ');
        console.log('==================================================');
        results.forEach(res => {
            console.log(`\n* Model: ${res.label} (${res.name})`);
            if (res.error) {
                console.log(`  - Status: FAILED (Error: ${res.error})`);
            } else {
                console.log(`  - Latency: ${res.duration}s`);
                console.log(`  - Tokens Used: Prompt: ${res.tokenUsage.prompt} | Output: ${res.tokenUsage.candidates} | Total: ${res.tokenUsage.total}`);
                console.log(`  - Estimated Cost: $${res.cost.toFixed(6)} USD`);
            }
        });
        console.log('==================================================\n');

        // Write outputs for detailed quality inspection
        results.forEach(res => {
            if (!res.error) {
                const outPath = path.join(__dirname, `benchmark_${res.name}.txt`);
                fs.writeFileSync(outPath, res.text, 'utf-8');
                console.log(`Detailed script saved to: benchmark_${res.name}.txt`);
            }
        });

    } catch (error) {
        console.error(`Error in benchmark: ${error.message}`);
        console.error(error.stack);
    } finally {
        if (fs.existsSync(baseTempDir)) {
            console.log(`[${requestHash}] Cleaning up temp extraction dir...`);
            await fs.promises.rm(baseTempDir, { recursive: true, force: true });
        }
        console.timeEnd(totalTimeLabel);
    }
};

run();