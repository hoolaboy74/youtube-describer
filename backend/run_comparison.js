require('dotenv').config();
const { execFile, spawn } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const util = require('util');
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

const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
if (!API_KEY) {
  throw new Error("GOOGLE_API_KEY or GEMINI_API_KEY is not defined in the environment");
}
const genAI = new GoogleGenerativeAI(API_KEY);

const run = async () => {
    const videoId = crypto.createHash('sha256').update(youtubeUrl).digest('hex');
    const requestHash = `comparison-${videoId.substring(0, 8)}`;
    const totalTimeLabel = `[${requestHash}] Total Process Time`;
    console.time(totalTimeLabel);

    const baseTempDir = path.join(__dirname, 'temp', videoId);

    try {
        console.log(`[${requestHash}] Starting processing for ${youtubeUrl}`);
        await fs.promises.mkdir(baseTempDir, { recursive: true });

        // Step 1: Extract ALL data upfront (Title, Subtitles, Frames)
        console.log(`[${requestHash}] Step 1: Starting initial data extraction...`);
        const extractionLabel = `[${requestHash}] Initial Data Extraction Time`;
        console.time(extractionLabel);

        // Get video title
        const { stdout } = await util.promisify(execFile)('python3', [
            '-m', 'yt_dlp',
            '-j', // --print-json
            '--no-progress',
            '--impersonate', 'safari',
            youtubeUrl
        ]);
        const videoInfo = JSON.parse(stdout);
        const videoTitle = videoInfo.title;

        // Get subtitles and frames in parallel
        const [subtitleContent, allTimestamps] = await Promise.all([
            // Fetch subtitles
            (async () => {
                let content = '';
                const subtitlePath = path.join(baseTempDir, 'subtitles.ko.vtt');
                try {
                    await util.promisify(execFile)('python3', [
                        '-m', 'yt_dlp',
                        '--write-auto-sub',
                        '--sub-lang', 'ko',
                        '--sub-format', 'vtt',
                        '--output', `${baseTempDir}/subtitles`,
                        '--skip-download',
                        '--no-progress',
                        '--impersonate', 'safari',
                        youtubeUrl
                    ]);
                    
                    if (fs.existsSync(subtitlePath)) {
                        const rawVtt = fs.readFileSync(subtitlePath, 'utf-8');
                        content = preprocessVtt(rawVtt);
                        console.log(`[${requestHash}] Successfully loaded and preprocessed subtitles.`);
                    } else {
                        console.warn(`[${requestHash}] yt-dlp did not create a subtitle file. Proceeding without subtitles.`);
                    }
                } catch (error) {
                    console.warn(`[${requestHash}] Error fetching subtitles: ${error.message}. Proceeding without subtitles.`);
                }
                return content;
            })(),
            // Extract frames
            (async () => {
                const extractedTimestamps = [];
                await new Promise((resolve, reject) => {
                    const ytdlpArgs = ['-m', 'yt_dlp', '-f', 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]', '-o', '-', '--no-progress', '--impersonate', 'safari', youtubeUrl];
                    const ffmpegArgs = ['-i', '-', '-vf', "select='gt(scene,0.4)',showinfo", '-vsync', 'vfr', path.join(baseTempDir, 'frame-%04d.png')];
                    const ytdlpProcess = spawn('python3', ytdlpArgs);
                    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
                    
                    ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);
                    
                    let ffmpegStderr = '';
                    ffmpegProcess.stderr.on('data', (data) => {
                        ffmpegStderr += data.toString();
                        const timeMatches = data.toString().matchAll(/pts_time:(\d+\.?\d*)/g);
                        for (const match of timeMatches) {
                            extractedTimestamps.push(parseFloat(match[1]));
                        }
                    });

                    ytdlpProcess.on('error', (err) => reject(new Error(`yt-dlp spawn error: ${err.message}`)));
                    ffmpegProcess.on('error', (err) => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
                    ffmpegProcess.on('close', (code) => {
                        if (code === 0) return resolve(extractedTimestamps);
                        reject(new Error(`ffmpeg frame extraction exited with code ${code}. Stderr: ${ffmpegStderr}`));
                    });
                });
                return extractedTimestamps;
            })()
        ]);

        console.timeEnd(extractionLabel);
        console.log(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, Total Frames: ${allTimestamps.length}`);

        // Step 2: Prepare AI inputs
        console.log(`[${requestHash}] Step 2: Preparing AI inputs...`);

        const allFrameFiles = (await fs.promises.readdir(baseTempDir)).filter(f => f.endsWith('.png')).sort();
        const imageParts = [];

        for (let i = 0; i < allTimestamps.length; i++) {
            const timestamp = allTimestamps[i];
            const frameFile = allFrameFiles[i];
            if (frameFile) {
                const framePath = path.join(baseTempDir, frameFile);
                if (fs.existsSync(framePath)) {
                    imageParts.push({ inlineData: { data: Buffer.from(await fs.promises.readFile(framePath)).toString("base64"), mimeType: 'image/png' } });
                    imageParts.push({ text: `Timestamp: [${Math.round(timestamp)}]` });
                }
            }
        }

        if (imageParts.length === 0) {
            console.warn(`[${requestHash}] No frames to process. Exiting.`);
            return;
        }

        // Load and prepare the prompt from the file
        let promptTemplate = fs.readFileSync(promptFilePath, 'utf-8');
        promptTemplate = promptTemplate.replace('{{VIDEO_TITLE}}', videoTitle);
        promptTemplate = promptTemplate.replace('{{SUBTITLES}}', subtitleContent);

        const requestPayload = [promptTemplate, ...imageParts];

        // Step 3: Call both models and compare results
        console.log(`[${requestHash}] Step 3: Calling both models...`);
        const aiLabel = `[${requestHash}] AI Comparison Time`;
        console.time(aiLabel);

        const model_2_5 = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
        const model_3_0 = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });

        const [result_2_5, result_3_0] = await Promise.all([
            model_2_5.generateContent(requestPayload).catch(e => ({ error: e.message })),
            model_3_0.generateContent(requestPayload).catch(e => ({ error: e.message }))
        ]);

        console.timeEnd(aiLabel);

        // Step 4: Output the results
        console.log('\n========================================');
        console.log('      Gemini 2.5 Pro (기존 모델)        ');
        console.log('========================================\n');

        if (result_2_5.error) {
            console.error("Error:", result_2_5.error);
        } else if (result_2_5.response.promptFeedback && result_2_5.response.promptFeedback.blockReason) {
            console.error("Blocked:", result_2_5.response.promptFeedback.blockReason);
        } else {
            console.log(result_2_5.response.text());
        }


        console.log('\n========================================');
        console.log('    Gemini 3.0 Pro Preview (신규 모델)    ');
        console.log('========================================\n');

        if (result_3_0.error) {
            console.error("Error:", result_3_0.error);
        } else if (result_3_0.response.promptFeedback && result_3_0.response.promptFeedback.blockReason) {
            console.error("Blocked:", result_3_0.response.promptFeedback.blockReason);
        } else {
            console.log(result_3_0.response.text());
        }

        console.log('\n--- COMPARISON COMPLETE ---\n');

    } catch (error) {
        console.error(new Error(`[${requestHash}] Error in comparison run: ${error.message}`));
        console.error(error.stack);
    } finally {
        if (fs.existsSync(baseTempDir)) {
            console.log(`[${requestHash}] Cleaning up temporary directory...`);
            await fs.promises.rm(baseTempDir, { recursive: true, force: true });
        }
        console.timeEnd(totalTimeLabel);
    }
};

run();