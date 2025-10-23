require('dotenv').config();
const { execFile, spawn } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const util = require('util');
const wav = require('wav');
const crypto = require('crypto');
const db = require('./database');
const { formatTime } = require('./utils');
const logger = require('./logger');

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error("GOOGLE_API_KEY is not defined in the environment");
}
const genAI = new GoogleGenerativeAI(API_KEY);
const youtube = google.youtube({ version: 'v3', auth: API_KEY });

const processingLocks = new Set();
const timers = new Map();

const time = (label) => {
    timers.set(label, Date.now());
};

const timeEnd = (label) => {
    const startTime = timers.get(label);
    if (startTime) {
        const duration = (Date.now() - startTime) / 1000;
        logger.info(`${label}: ${duration.toFixed(3)}s`);
        timers.delete(label);
    }
};

// Helper to parse ISO 8601 duration
const parseISO8601Duration = (duration) => {
    const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
    if (!match) return 0;
    const hours = (parseInt(match[1], 10) || 0);
    const minutes = (parseInt(match[2], 10) || 0);
    const seconds = (parseInt(match[3], 10) || 0);
    return hours * 3600 + minutes * 60 + seconds;
};


const processVideo = async (videoId, youtubeUrl, sseHandler = null) => {
    const requestHash = sseHandler ? videoId.substring(0, 8) : `batch-${videoId.substring(0, 8)}`;

    if (processingLocks.has(videoId)) {
        logger.warn(`[${requestHash}] Duplicate request for ${videoId}. The process is already running.`);
        if (sseHandler) {
            sseHandler('duplicate_request', { message: 'This video is already being processed.' });
        }
        return;
    }

    processingLocks.add(videoId);

    const totalTimeLabel = `[${requestHash}] Total Process Time`;
    logger.info(`[${requestHash}] Starting processing for ${youtubeUrl}`);
    time(totalTimeLabel);

    const baseTempDir = path.join(__dirname, 'temp', videoId);

    try {
        const cachedData = db.getVideo(videoId);
        if (cachedData && cachedData.script && cachedData.script.length > 0 && cachedData.status === 'completed') {
            logger.info(`[${requestHash}] Cache hit for videoId: ${videoId}.`);
            if (sseHandler) {
                sseHandler('full_script', cachedData);
            }
            return;
        }

        await fs.promises.mkdir(baseTempDir, { recursive: true });

        // Step 1: Extract ALL data upfront (Title, Subtitles, Frames)
        logger.info(`[${requestHash}] Step 1: Starting initial data extraction...`);
        const extractionLabel = `[${requestHash}] Initial Data Extraction Time`;
        time(extractionLabel);

        if (sseHandler) sseHandler('status_update', { message: '영상 정보 확인 중...' });
        
        // Fetch video details from YouTube API
        const videoApiResponse = await youtube.videos.list({
            part: 'snippet,contentDetails',
            id: videoId,
        });

        if (videoApiResponse.data.items.length === 0) {
            throw new Error('Video not found via YouTube API.');
        }
        const videoDetails = videoApiResponse.data.items[0];
        const videoTitle = videoDetails.snippet.title;
        const totalDuration = parseISO8601Duration(videoDetails.contentDetails.duration);

        db.ensureVideoRecord({ videoId, title: videoTitle, duration: Math.round(totalDuration) });

        if (sseHandler) sseHandler('status_update', { message: '자막 정보 확인 중...' });

        // Fetch subtitles using yt-dlp for reliability with auto-generated captions
        let subtitleContent = '';
        const subtitlePath = path.join(baseTempDir, 'subtitles.ko.vtt');
        try {
            await util.promisify(execFile)('yt-dlp', [
                '--write-auto-sub',
                '--sub-lang', 'ko',
                '--sub-format', 'vtt',
                '--output', `${baseTempDir}/subtitles`,
                '--skip-download',
                '--no-progress',
                '--cookies', 'cookies.txt',
                youtubeUrl
            ]);
            
            if (fs.existsSync(subtitlePath)) {
                subtitleContent = fs.readFileSync(subtitlePath, 'utf-8');
                logger.info(`[${requestHash}] Successfully loaded subtitles using yt-dlp.`);
            } else {
                logger.warn(`[${requestHash}] yt-dlp did not create a subtitle file. Proceeding without subtitles.`);
            }
        } catch (error) {
            logger.warn(`[${requestHash}] Error fetching subtitles with yt-dlp: ${error.message}. Proceeding without subtitles.`);
        }


        if (sseHandler) sseHandler('status_update', { message: '주요 장면 프레임 추출 중...' });
        const allTimestamps = await new Promise((resolve, reject) => {
            const extractedTimestamps = [];
            const ytdlpArgs = ['-f', 'bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]', '-o', '-', '--no-progress', '--cookies', 'cookies.txt', youtubeUrl];
            const ffmpegArgs = ['-i', '-', '-vf', "select='gt(scene,0.4)',showinfo", '-vsync', 'vfr', path.join(baseTempDir, 'frame-%04d.png')];
            const ytdlpProcess = spawn('yt-dlp', ytdlpArgs);
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

        timeEnd(extractionLabel);
        logger.info(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, Total Frames: ${allTimestamps.length}`);
        
        if (sseHandler) {
            sseHandler('start', { videoId, title: videoTitle });
        }

        // 2. Process AI generation in chunks
        const CHUNK_DURATION_SECONDS = 180;
        const allFrameFiles = (await fs.promises.readdir(baseTempDir)).filter(f => f.endsWith('.png')).sort();
        
        let previousScriptText = '';
        let frameIndex = 0;

        while (frameIndex < allTimestamps.length) {
            const chunkNumber = Math.floor(allTimestamps[frameIndex] / CHUNK_DURATION_SECONDS) + 1;
            const chunkStartTime = (chunkNumber - 1) * CHUNK_DURATION_SECONDS;
            const chunkEndTime = chunkNumber * CHUNK_DURATION_SECONDS;

            logger.info(`[${requestHash}] Processing AI for chunk ${chunkNumber}...`);
            if (sseHandler) sseHandler('status_update', { message: `AI로 대본 생성 중... (${chunkNumber}번째 조각)` });
            const aiChunkLabel = `[${requestHash}] AI Chunk ${chunkNumber} Time`;
            time(aiChunkLabel);

            const chunkImageParts = [];

            while (frameIndex < allTimestamps.length && allTimestamps[frameIndex] < chunkEndTime) {
                const timestamp = allTimestamps[frameIndex];
                const frameFile = allFrameFiles[frameIndex];
                
                if (frameFile) {
                    const framePath = path.join(baseTempDir, frameFile);
                    if (fs.existsSync(framePath)) {
                        chunkImageParts.push({ inlineData: { data: Buffer.from(await fs.promises.readFile(framePath)).toString("base64"), mimeType: 'image/png' } });
                        chunkImageParts.push({ text: `Timestamp: [${formatTime(timestamp)}]` });
                    }
                }
                frameIndex++;
            }

            if (chunkImageParts.length === 0) {
                logger.warn(`[${requestHash}] No frames for AI chunk ${chunkNumber}. Skipping.`);
                timeEnd(aiChunkLabel);
                continue;
            }

            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-pro",
                generationConfig: {
                    temperature: 0.5
                }
            });
            
            const promptTemplatePath = path.join(__dirname, 'prompt_template.txt');
            let basePrompt = fs.readFileSync(promptTemplatePath, 'utf-8');

            basePrompt = basePrompt.replace('{{VIDEO_TITLE}}', videoTitle);
            basePrompt = basePrompt.replace('{{SUBTITLES}}', subtitleContent);

            const contextPrompt = '**이전까지 생성된 대본 (전체 맥락 파악용):**\n' +
                '\`\`\`\n' +
                previousScriptText + '\n' +
                '\`\`\`\n\n' +
                '**이제부터 제공될 새로운 프레임에 대한 해설을 위 대본에 이어서 자연스럽게 작성해 주세요.**\n';
            
            const prompt = previousScriptText ? basePrompt + '\n\n' + contextPrompt : basePrompt;

            const result = await model.generateContent([prompt, ...chunkImageParts]);

            if (result.response.promptFeedback && result.response.promptFeedback.blockReason) {
                const reason = result.response.promptFeedback.blockReason;
                logger.error(`[${requestHash}] AI request for chunk ${chunkNumber} was blocked. Reason: ${reason}`);
                throw new Error(`The AI prompt for chunk ${chunkNumber} was blocked due to prohibited content: ${reason}`);
            }

            const scriptText = result.response.text();
            
            const scriptLines = scriptText.split('\n').filter(line => line.trim().startsWith('['));
            const chunkScriptData = scriptLines.map((line) => {
                const match = line.match(/^\s*\[(\d{2}):(\d{2}):(\d{2})\]\s*\[v(\d)\]\s*(.*)\s*$/);
                if (!match) return null;

                const id = crypto.createHash('sha256').update(line).digest('hex');
                const [, hours, minutes, seconds, verbosity, text] = match;
                const timestamp = parseInt(hours, 10) * 3600 + parseInt(minutes, 10) * 60 + parseInt(seconds, 10);
                return { id, timestamp, text: text.trim(), verbosity: `v${verbosity}` };
            }).filter(Boolean);

            if (chunkScriptData.length > 0) {
                db.saveVideoChunk({ videoId, scriptChunk: chunkScriptData });
                logger.info(`[${requestHash}] Saved ${chunkScriptData.length} script lines from chunk ${chunkNumber} to DB.`);
            }

            if (sseHandler) {
                sseHandler('script_chunk', chunkScriptData);
            }
            previousScriptText += (previousScriptText ? '\n' : '') + scriptText;

            timeEnd(aiChunkLabel);
        }

        db.updateVideoStatus(videoId, 'completed');
        logger.info(`[${requestHash}] Successfully generated script text.`);
        if (sseHandler) {
            sseHandler('end', { message: 'Processing complete.' });
        }
        
    } catch (error) {
        db.updateVideoStatus(videoId, 'failed');
        logger.error(new Error(`[${requestHash}] Error processing request: ${error.message}`));
        if (sseHandler) {
            sseHandler('error', { message: 'Failed to process video', details: error.message });
        }
    } finally {
        if (fs.existsSync(baseTempDir)) {
            await fs.promises.rm(baseTempDir, { recursive: true, force: true });
        }
        processingLocks.delete(videoId); // Release the lock
        timeEnd(totalTimeLabel);
    }
};

const processVideoBatch = async (videoId, youtubeUrl) => {
    const requestHash = `batch-${videoId.substring(0, 8)}`;
    const totalTimeLabel = `[${requestHash}] Total Batch Process Time`;
    logger.info(`[${requestHash}] Starting batch processing for ${youtubeUrl}`);
    time(totalTimeLabel);

    const baseTempDir = path.join(__dirname, 'temp', videoId);

    try {
        const cachedData = db.getVideo(videoId);
        if (cachedData && cachedData.status === 'completed') {
            logger.info(`[${requestHash}] Cache hit for videoId: ${videoId}. Batch processing not needed.`);
            return;
        }

        await fs.promises.mkdir(baseTempDir, { recursive: true });

        // Step 1: Extract ALL data upfront (Title, Subtitles, Frames)
        logger.info(`[${requestHash}] Step 1: Starting initial data extraction (Title, Subtitles, Frames)...`);
        const extractionLabel = `[${requestHash}] Initial Data Extraction Time`;
        time(extractionLabel);

        const [videoDetails, subtitleContent, allTimestamps] = await Promise.all([
            // Fetch video details from YouTube API
            youtube.videos.list({
                part: 'snippet,contentDetails',
                id: videoId,
            }).then(response => {
                if (response.data.items.length === 0) throw new Error('Video not found via YouTube API.');
                return response.data.items[0];
            }),
            // Fetch subtitles using yt-dlp for reliability with auto-generated captions
            (async () => {
                const subtitlePath = path.join(baseTempDir, 'subtitles.ko.vtt');
                try {
                    await util.promisify(execFile)('yt-dlp', [
                        '--write-auto-sub',
                        '--sub-lang', 'ko',
                        '--sub-format', 'vtt',
                        '--output', `${baseTempDir}/subtitles`,
                        '--skip-download',
                        '--no-progress',
                        '--cookies', 'cookies.txt',
                        youtubeUrl
                    ]);
                    
                    if (fs.existsSync(subtitlePath)) {
                        logger.info(`[${requestHash}] Successfully loaded subtitles using yt-dlp for batch.`);
                        return fs.readFileSync(subtitlePath, 'utf-8');
                    }
                } catch (error) {
                    logger.warn(`[${requestHash}] Error fetching subtitles with yt-dlp for batch: ${error.message}.`);
                }
                logger.warn(`[${requestHash}] yt-dlp did not create a subtitle file for batch. Proceeding without subtitles.`);
                return '';
            })(),
            // Extract frames using yt-dlp and ffmpeg
            (async () => {
                const extractedTimestamps = [];
                await new Promise((resolve, reject) => {
                    const ytdlpArgs = ['-f', 'bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]', '-o', '-', '--no-progress', '--cookies', 'cookies.txt', youtubeUrl];
                    const ffmpegArgs = ['-i', '-', '-vf', "select='gt(scene,0.4)',showinfo", '-vsync', 'vfr', path.join(baseTempDir, 'frame-%04d.png')];
                    const ytdlpProcess = spawn('yt-dlp', ytdlpArgs);
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
        
        const videoTitle = videoDetails.snippet.title;
        const totalDuration = parseISO8601Duration(videoDetails.contentDetails.duration);

        timeEnd(extractionLabel);
        logger.info(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, Total Frames: ${allTimestamps.length}`);

        // Ensure record exists and is marked as processing
        db.ensureVideoRecord({ videoId, title: videoTitle, duration: Math.round(totalDuration) });

        // 2. Process AI generation for the entire video
        const aiLabel = `[${requestHash}] Full AI Process Time`;

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
            // If no frames, we still consider it 'completed' but with an empty script.
            logger.warn(`[${requestHash}] No frames to process. Marking as complete with empty script.`);
            db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), script: [] });
            return; // Exit early
        }

        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-pro",
            generationConfig: {
                temperature: 0.5
            }
        });

        const promptTemplatePath = path.join(__dirname, 'prompt_template.txt');
        let prompt = fs.readFileSync(promptTemplatePath, 'utf-8');

        prompt = prompt.replace('{{VIDEO_TITLE}}', videoTitle);
        prompt = prompt.replace('{{SUBTITLES}}', subtitleContent);

        const result = await model.generateContent([prompt, ...imageParts]);
        
        if (result.response.promptFeedback && result.response.promptFeedback.blockReason) {
            const reason = result.response.promptFeedback.blockReason;
            logger.error(`[${requestHash}] AI request was blocked. Reason: ${reason}`);
            throw new Error(`The AI prompt was blocked due to prohibited content: ${reason}`);
        }

        const scriptText = result.response.text();
        
        const scriptLines = scriptText.split('\n').filter(line => line.trim().startsWith('['));
        const finalScriptData = scriptLines.map((line) => {
            const match = line.match(/^\s*\[(\d{2}):(\d{2}):(\d{2})\]\s*\[v(\d)\]\s*(.*)\s*$/);
            if (!match) return null;

            const id = crypto.createHash('sha256').update(line).digest('hex');
            const [, hours, minutes, seconds, verbosity, text] = match;
            const timestamp = parseInt(hours, 10) * 3600 + parseInt(minutes, 10) * 60 + parseInt(seconds, 10);
            return { id, timestamp, text: text.trim(), verbosity: `v${verbosity}` };
        }).filter(Boolean);

        // 3. Finalize
        finalScriptData.sort((a, b) => a.timestamp - b.timestamp);
        const responsePayload = { videoId, title: videoTitle, duration: Math.round(totalDuration), script: finalScriptData };
        db.saveVideo(responsePayload);

        logger.info(`[${requestHash}] Successfully generated and cached script text for batch processing.`);
        
    } catch (error) {
        db.updateVideoStatus(videoId, 'failed');
        logger.error(new Error(`[${requestHash}] Error in batch processing: ${error.message}`));
    } finally {
        if (fs.existsSync(baseTempDir)) {
            await fs.promises.rm(baseTempDir, { recursive: true, force: true });
        }
        timeEnd(totalTimeLabel);
    }
};

module.exports = { processVideo, processVideoBatch };
