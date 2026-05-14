require('dotenv').config();
const { execFile, spawn } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const util = require('util');
const VAD = require('node-vad');
const wav = require('wav');
const crypto = require('crypto');
const { formatTime, invertSpeechTimestamps } = require('./utils');

// --- Argument Parsing ---
if (process.argv.length < 4) {
    console.error('Usage: node run_batch_single.js <youtubeUrl> <promptFilePath>');
    process.exit(1);
}
const youtubeUrl = process.argv[2];
const promptFilePath = process.argv[3];

if (!fs.existsSync(promptFilePath)) {
    console.error(`Error: Prompt file not found at ${promptFilePath}`);
    process.exit(1);
}

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error("GOOGLE_API_KEY is not defined in the environment");
}
const genAI = new GoogleGenerativeAI(API_KEY);

const run = async () => {
    const videoId = crypto.createHash('sha256').update(youtubeUrl).digest('hex');
    const requestHash = `single-run-${videoId.substring(0, 8)}`;
    const totalTimeLabel = `[${requestHash}] Total Process Time`;
    console.time(totalTimeLabel);

    const baseTempDir = path.join(__dirname, 'temp', videoId);

    try {
        console.log(`[${requestHash}] Starting processing for ${youtubeUrl}`);
        await fs.promises.mkdir(baseTempDir, { recursive: true });

        // Step 1: Extract ALL data upfront (Title, VAD, Frames)
        console.log(`[${requestHash}] Step 1: Starting initial data extraction (Title, VAD, Frames)...`);
        const extractionLabel = `[${requestHash}] Initial Data Extraction Time`;
        console.time(extractionLabel);

        const [videoTitle, { totalDuration }, allTimestamps] = await Promise.all([
            util.promisify(execFile)('python3', ['-m', 'yt_dlp', '--get-title', '--encoding', 'utf-8', '--no-progress', '--impersonate', 'safari', '--cookies', 'cookies.txt', youtubeUrl]).then(result => result.stdout.trim()),
            (async () => {
                const audioPath = path.join(baseTempDir, 'audio.wav');
                const downloadedAudio = path.join(baseTempDir, 'audio_source.m4a');
                await util.promisify(execFile)('python3', ['-m', 'yt_dlp', '-f', 'bestaudio', '-o', downloadedAudio, '--no-progress', '--impersonate', 'safari', '--cookies', 'cookies.txt', youtubeUrl]);
                const metadata = await util.promisify(ffmpeg.ffprobe)(downloadedAudio);
                const duration = metadata.format.duration;
                await new Promise((resolve, reject) => {
                    ffmpeg(downloadedAudio).toFormat('wav').audioFrequency(16000).audioChannels(1).on('end', resolve).on('error', reject).save(audioPath);
                });
                const speechTimestamps = await new Promise((resolve, reject) => {
                    const vad = new VAD(VAD.Mode.NORMAL);
                    const fileStream = fs.createReadStream(audioPath).pipe(new wav.Reader());
                    const timestamps = [];
                    let isSpeaking = false, speechStart = 0, processedBytes = 0;
                    const bytesPerMs = (16000 * 16 / 8) / 1000;
                    fileStream.on('format', format => {
                        fileStream.on('data', chunk => {
                            vad.processAudio(chunk, format.sampleRate).then(res => {
                                const currentTime = processedBytes / bytesPerMs;
                                if (res === VAD.Event.VOICE && !isSpeaking) { isSpeaking = true; speechStart = currentTime; }
                                if (res === VAD.Event.SILENCE && isSpeaking) { isSpeaking = false; timestamps.push({ start: speechStart, end: currentTime }); }
                                processedBytes += chunk.length;
                            }).catch(reject);
                        });
                    });
                    fileStream.on('end', () => {
                        if (isSpeaking) { timestamps.push({ start: speechStart, end: processedBytes / bytesPerMs }); }
                        resolve(timestamps);
                    });
                    fileStream.on('error', reject);
                });
                return { 
                    nonSpeechIntervals: invertSpeechTimestamps(speechTimestamps, duration * 1000),
                    totalDuration: duration
                };
            })(),
            (async () => {
                const extractedTimestamps = [];
                await new Promise((resolve, reject) => {
                    const ytdlpArgs = ['-m', 'yt_dlp', '-f', 'bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]', '-o', '-', '--no-progress', '--impersonate', 'safari', '--cookies', 'cookies.txt', youtubeUrl];
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
        console.log(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, VAD Intervals: ${nonSpeechIntervals.length}, Total Frames: ${allTimestamps.length}`);

        // Step 2: Process AI generation for the entire video
        console.log(`[${requestHash}] Step 2: Starting AI Generation...`);
        const aiLabel = `[${requestHash}] Full AI Process Time`;
        console.time(aiLabel);

        const allFrameFiles = (await fs.promises.readdir(baseTempDir)).filter(f => f.endsWith('.png')).sort();
        const imageParts = [];

        for (let i = 0; i < allTimestamps.length; i++) {
            const timestamp = allTimestamps[i];
            const frameFile = allFrameFiles[i];
            if (frameFile) {
                const framePath = path.join(baseTempDir, frameFile);
                if (fs.existsSync(framePath)) {
                    imageParts.push({ inlineData: { data: Buffer.from(await fs.promises.readFile(framePath)).toString("base64"), mimeType: 'image/png' } });
                    imageParts.push({ text: `Timestamp: [${formatTime(timestamp)}]` });
                }
            }
        }

        if (imageParts.length === 0) {
            console.warn(`[${requestHash}] No frames to process. Exiting.`);
            return;
        }

        const silentIntervalsString = nonSpeechIntervals.map(interval => `${formatTime(interval.start)} ~ ${formatTime(interval.end)}`).join('\n');
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

        // Load and prepare the prompt from the file
        let promptTemplate = fs.readFileSync(promptFilePath, 'utf-8');
        promptTemplate = promptTemplate.replace('{{VIDEO_TITLE}}', videoTitle);
        promptTemplate = promptTemplate.replace('{{SILENT_INTERVALS}}', silentIntervalsString);

        const result = await model.generateContent([promptTemplate, ...imageParts]);
        
        if (result.response.promptFeedback && result.response.promptFeedback.blockReason) {
            const reason = result.response.promptFeedback.blockReason;
            console.error(`[${requestHash}] AI request was blocked. Reason: ${reason}`);
            throw new Error(`The AI prompt was blocked due to prohibited content: ${reason}`);
        }

        const scriptText = result.response.text();
        console.timeEnd(aiLabel);

        // Step 3: Output the result
        console.log('\n--- GENERATED SCRIPT ---\n');
        console.log(scriptText);
        console.log('\n--- END OF SCRIPT ---\n');

    } catch (error) {
        console.error(new Error(`[${requestHash}] Error in single batch run: ${error.message}`));
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
