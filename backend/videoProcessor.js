const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require("googleapis");
const fs = require('fs');
const path = require('path');
const util = require('util');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const db = require('./database');
const { formatTime, preprocessVtt, isValidYoutubeUrl } = require('./utils');
const logger = require('./logger');

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error("GOOGLE_API_KEY is not defined in the environment");
}
const genAI = new GoogleGenerativeAI(API_KEY);
const youtube = google.youtube({ version: 'v3', auth: API_KEY });

const processingLocks = new Set();
const timers = new Map();

const getRandomCookiePath = () => {
    const cookiesDir = path.join(__dirname, 'cookies');
    if (!fs.existsSync(cookiesDir)) {
        logger.warn('Cookies directory not found, falling back to default cookies.txt');
        const defaultCookiePath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(defaultCookiePath)) {
            logger.info('Using default cookie file: cookies.txt');
            return defaultCookiePath;
        }
        logger.warn('Default cookies.txt not found either. Proceeding without cookies.');
        return null;
    }

    const cookieFiles = fs.readdirSync(cookiesDir).filter(file => file.endsWith('_cookies.txt') && fs.statSync(path.join(cookiesDir, file)).size > 0);

    if (cookieFiles.length === 0) {
        logger.warn('No valid cookie files found in cookies directory, falling back to default cookies.txt');
        const defaultCookiePath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(defaultCookiePath)) {
            logger.info('Using default cookie file: cookies.txt');
            return defaultCookiePath;
        }
        logger.warn('Default cookies.txt not found either. Proceeding without cookies.');
        return null;
    }

    const randomCookieFile = cookieFiles[Math.floor(Math.random() * cookieFiles.length)];
    const cookiePath = path.join(cookiesDir, randomCookieFile);
    logger.info(`Using cookie file: ${randomCookieFile}`);
    return cookiePath;
};

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

    if (!isValidYoutubeUrl(youtubeUrl)) {
        logger.error(`[${requestHash}] Invalid YouTube URL provided: ${youtubeUrl}`);
        if (sseHandler) {
            sseHandler('backend_error', { message: 'Invalid YouTube URL' });
        }
        processingLocks.delete(videoId);
        return;
    }

    processingLocks.add(videoId);

    // Ensure a preliminary record exists in the DB to log failures against.
    try {
        db.ensurePreliminaryRecord(videoId);
    } catch (dbError) {
        logger.error(`[${requestHash}] Failed to create initial pending record for ${videoId}:`, dbError);
        // This is a critical DB error, so we shouldn't proceed.
        processingLocks.delete(videoId);
        if (sseHandler) {
            sseHandler('backend_error', { message: 'A critical database error occurred.' });
        }
        return;
    }

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

        if (videoDetails.snippet.liveBroadcastContent !== 'none') {
            const reason = `live_stream_not_supported: liveBroadcastContent is ${videoDetails.snippet.liveBroadcastContent}`;
            logger.warn(`[${requestHash}] Video processing blocked for ${videoId} because it is a live stream.`);
            db.updateVideoStatus(videoId, 'failed', reason);
            if (sseHandler) {
                sseHandler('backend_error', { message: 'live_stream_not_supported', details: 'Live streams cannot be processed.' });
            }
            return; // Stop processing
        }

        const durationLimitMinutes = parseInt(db.getSetting('videoDurationLimit') || '30', 10);
        if (durationLimitMinutes > 0) { // A limit of 0 means 'unlimited'
            const durationLimitSeconds = durationLimitMinutes * 60;
            if (totalDuration >= durationLimitSeconds) {
                const reason = `duration_exceeded: ${totalDuration}s > ${durationLimitSeconds}s`;
                logger.warn(`[${requestHash}] Video processing blocked for ${videoId} because its duration (${totalDuration}s) exceeds the limit of ${durationLimitSeconds}s.`);
                db.updateVideoStatus(videoId, 'failed', reason); // Explicitly mark as failed
                if (sseHandler) {
                    sseHandler('backend_error', { message: 'duration_exceeded', limit: durationLimitMinutes });
                }
                return; // Stop processing
            }
        }

        db.ensureVideoRecord({ videoId, title: videoTitle, duration: Math.round(totalDuration) });

        if (sseHandler) sseHandler('status_update', { message: '자막 정보 확인 중...' });

        const cookiePath = getRandomCookiePath();
        const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];
        const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

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
                ...cookieArgs,
                ...proxyArgs,
                youtubeUrl
            ]);
            
            if (fs.existsSync(subtitlePath)) {
                const rawVtt = fs.readFileSync(subtitlePath, 'utf-8');
                subtitleContent = preprocessVtt(rawVtt); // Convert timestamps to seconds
                logger.info(`[${requestHash}] Successfully loaded and preprocessed subtitles.`);
            } else {
                logger.warn(`[${requestHash}] yt-dlp did not create a subtitle file. Proceeding without subtitles.`);
            }
        } catch (error) {
            logger.warn(`[${requestHash}] Error fetching subtitles with yt-dlp: ${error.message}. Proceeding without subtitles.`);
        }


        if (sseHandler) sseHandler('status_update', { message: '주요 장면 프레임 추출 중...' });
        const allTimestamps = await new Promise((resolve, reject) => {
            const extractedTimestamps = [];
            let lastReportedProgress = -1; // For progress reporting

            const ytdlpArgs = ['-f', 'bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]', '-o', '-', '--no-progress', ...cookieArgs, ...proxyArgs, youtubeUrl];
            const ffmpegArgs = ['-i', '-', '-vf', "select='gt(scene,0.4)',showinfo", '-vsync', 'vfr', path.join(baseTempDir, 'frame-%04d.png')];
            const ytdlpProcess = spawn('yt-dlp', ytdlpArgs);
            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
            ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);
            let ffmpegStderr = '';
            ffmpegProcess.stderr.on('data', (data) => {
                const stderrChunk = data.toString();
                ffmpegStderr += stderrChunk;

                // For timestamp extraction from 'showinfo' filter
                const timeMatches = stderrChunk.matchAll(/pts_time:(\d+\.?\d*)/g);
                for (const match of timeMatches) {
                    extractedTimestamps.push(parseFloat(match[1]));
                }

                // For progress reporting from ffmpeg's default output
                const progressMatches = stderrChunk.matchAll(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/g);
                let lastMatch = null;
                for (const match of progressMatches) { lastMatch = match; }

                if (lastMatch) {
                    const hours = parseInt(lastMatch[1], 10);
                    const minutes = parseInt(lastMatch[2], 10);
                    const seconds = parseInt(lastMatch[3], 10);
                    const currentTime = hours * 3600 + minutes * 60 + seconds;

                    if (totalDuration > 0) {
                        const progress = Math.min(100, Math.round((currentTime / totalDuration) * 100));
                        if (progress > lastReportedProgress) {
                            lastReportedProgress = progress;
                            if (sseHandler) {
                                sseHandler('status_update', { message: `주요 장면 프레임 추출 중... (${progress}%)` });
                            }
                        }
                    }
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

        // 2. Process AI generation with full context in a single stream
        logger.info(`[${requestHash}] Step 2: Starting AI generation with full context...`);
        const aiLabel = `[${requestHash}] Full AI Process Time`;
        time(aiLabel);

        if (sseHandler) sseHandler('status_update', { message: 'AI로 전체 대본 생성 중...' });

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
            logger.warn(`[${requestHash}] No frames to process. Marking as complete with empty script.`);
            db.updateVideoStatus(videoId, 'completed');
            if (sseHandler) sseHandler('end', { message: 'Processing complete, no frames found.' });
            return;
        }

        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-pro",
            generationConfig: {
                temperature: 0.7
            }
        });

        const promptTemplatePath = path.join(__dirname, 'prompt_template.txt');
        let prompt = fs.readFileSync(promptTemplatePath, 'utf-8');
        prompt = prompt.replace('{{VIDEO_TITLE}}', videoTitle);
        prompt = prompt.replace('{{SUBTITLES}}', subtitleContent);

        const result = await model.generateContentStream([prompt, ...imageParts]);

        let scriptBuffer = '';
        let dbChunkBuffer = [];
        const fullScript = [];

        for await (const chunk of result.stream) {
            if (chunk.text) {
                scriptBuffer += chunk.text();
                
                let lastNewline = scriptBuffer.lastIndexOf('\n');
                if (lastNewline !== -1) {
                    const completeLines = scriptBuffer.substring(0, lastNewline).split('\n');
                    scriptBuffer = scriptBuffer.substring(lastNewline + 1);

                    const newScriptData = completeLines.map(line => {
                        const match = line.match(/^\s*\[(\d+)\]\s*\[v(\d)\]\s*(.*)\s*$/);
                        if (!match) return null;
                        const id = crypto.createHash('sha256').update(line).digest('hex');
                        const [, timestampStr, verbosity, text] = match;
                        const timestamp = parseInt(timestampStr, 10);
                        return { id, timestamp, text: text.trim(), verbosity: `v${verbosity}` };
                    }).filter(Boolean);

                    if (newScriptData.length > 0) {
                        if (sseHandler) {
                            sseHandler('script_chunk', newScriptData);
                        }
                        dbChunkBuffer.push(...newScriptData);
                        fullScript.push(...newScriptData);

                        if (dbChunkBuffer.length >= 10) {
                            db.saveVideoChunk({ videoId, scriptChunk: dbChunkBuffer });
                            dbChunkBuffer = [];
                        }
                    }
                }
            }
        }
        
        // Process any remaining text in the buffer
        if (scriptBuffer.trim()) {
             const finalLines = scriptBuffer.split('\n').map(line => {
                const match = line.match(/^\s*\[(\d{2}):(\d{2}):(\d{2})\]\s*\[v(\d)\]\s*(.*)\s*$/);
                if (!match) return null;
                const id = crypto.createHash('sha256').update(line).digest('hex');
                const [, hours, minutes, seconds, verbosity, text] = match;
                const timestamp = parseInt(hours, 10) * 3600 + parseInt(minutes, 10) * 60 + parseInt(seconds, 10);
                return { id, timestamp, text: text.trim(), verbosity: `v${verbosity}` };
            }).filter(Boolean);

            if (finalLines.length > 0) {
                if (sseHandler) sseHandler('script_chunk', finalLines);
                dbChunkBuffer.push(...finalLines);
                fullScript.push(...finalLines);
            }
        }

        // Save any remaining lines in the DB buffer
        if (dbChunkBuffer.length > 0) {
            db.saveVideoChunk({ videoId, scriptChunk: dbChunkBuffer });
        }

        // Log API cost after stream is complete
        try {
            const finalResponse = await result.response;
            const usageMetadata = finalResponse.usageMetadata;
            if (usageMetadata) {
                const { promptTokenCount, candidatesTokenCount, totalTokenCount } = usageMetadata;

                // Official Gemini 2.5 Pro pricing (per 1M tokens)
                let inputCostPerMillionTokens;
                let outputCostPerMillionTokens;

                if (totalTokenCount <= 200000) {
                    inputCostPerMillionTokens = 1.25; // <= 200k tokens tier
                    outputCostPerMillionTokens = 10.00; // <= 200k tokens tier
                } else {
                    inputCostPerMillionTokens = 2.50; // > 200k tokens tier
                    outputCostPerMillionTokens = 15.00; // > 200k tokens tier
                }

                const inputCost = (promptTokenCount / 1000000) * inputCostPerMillionTokens;
                const outputCost = (candidatesTokenCount / 1000000) * outputCostPerMillionTokens;
                const cost = inputCost + outputCost;

                db.addApiCost({
                    videoId,
                    model_used: 'gemini-2.5-pro',
                    image_tokens: promptTokenCount, // This is an approximation, includes text prompt
                    text_tokens: candidatesTokenCount,
                    cost
                });
                logger.info(`[${requestHash}] Logged API cost: ${cost.toFixed(6)} USD for ${totalTokenCount} tokens (Input: ${promptTokenCount}, Output: ${candidatesTokenCount}).`);
            }
        } catch (costError) {
            logger.error(`[${requestHash}] Failed to log API cost:`, costError);
        }

        // Final step: Clean up old scripts and insert the new, complete script atomically.
        // This ensures consistency, especially if the process was re-run.
        db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), script: fullScript });
        
        timeEnd(aiLabel);
        logger.info(`[${requestHash}] Successfully generated and streamed script text.`);
        if (sseHandler) {
            sseHandler('end', { message: 'Processing complete.' });
        }
        
    } catch (error) {
        db.updateVideoStatus(videoId, 'failed', error.message);
        logger.error(new Error(`[${requestHash}] Error processing request: ${error.message}`));
        if (sseHandler) {
            sseHandler('backend_error', { message: 'Failed to process video', details: error.message });
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
    if (!isValidYoutubeUrl(youtubeUrl)) {
        logger.error(`[${requestHash}] Invalid YouTube URL provided: ${youtubeUrl}`);
        return;
    }

    // Ensure a preliminary record exists in the DB to log failures against.
    try {
        db.ensurePreliminaryRecord(videoId);
    } catch (dbError) {
        logger.error(`[${requestHash}] Failed to create initial pending record for ${videoId}:`, dbError);
        return; // Don't proceed if DB fails
    }

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

        const cookiePath = getRandomCookiePath();
        const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];
        const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

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
                        ...cookieArgs,
                        ...proxyArgs,
                        youtubeUrl
                    ]);
                    
                    if (fs.existsSync(subtitlePath)) {
                        logger.info(`[${requestHash}] Successfully loaded subtitles using yt-dlp for batch.`);
                        const rawVtt = fs.readFileSync(subtitlePath, 'utf-8');
                        return preprocessVtt(rawVtt); // Convert timestamps to seconds
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
                    const ytdlpArgs = ['-f', 'bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]', '-o', '-', '--no-progress', ...cookieArgs, ...proxyArgs, youtubeUrl];
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

        if (videoDetails.snippet.liveBroadcastContent !== 'none') {
            const reason = `live_stream_not_supported: liveBroadcastContent is ${videoDetails.snippet.liveBroadcastContent}`;
            logger.warn(`[${requestHash}] Batch processing blocked for ${videoId} because it is a live stream.`);
            db.updateVideoStatus(videoId, 'failed', reason);
            return; // Stop batch processing
        }

        const durationLimitMinutes = parseInt(db.getSetting('videoDurationLimit') || '30', 10);
        if (durationLimitMinutes > 0) { // A limit of 0 means 'unlimited'
            const durationLimitSeconds = durationLimitMinutes * 60;
            if (totalDuration >= durationLimitSeconds) {
                const reason = `duration_exceeded: ${totalDuration}s > ${durationLimitSeconds}s`;
                logger.warn(`[${requestHash}] Batch processing blocked for ${videoId} because its duration (${totalDuration}s) exceeds the limit of ${durationLimitSeconds}s.`);
                db.updateVideoStatus(videoId, 'failed', reason);
                return; // Stop batch processing
            }
        }

        timeEnd(extractionLabel);
        logger.info(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, Total Frames: ${allTimestamps.length}`);

        // Ensure record exists and is marked as processing
        db.ensureVideoRecord({ videoId, title: videoTitle, duration: Math.round(totalDuration) });

        // 2. Process AI generation for the entire video
        logger.info(`[${requestHash}] Step 2: Starting AI generation with full context for batch...`);
        const aiLabel = `[${requestHash}] Full AI Process Time`;
        time(aiLabel);

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
            // If no frames, we still consider it 'completed' but with an empty script.
            logger.warn(`[${requestHash}] No frames to process. Marking as complete with empty script.`);
            db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), script: [] });
            return; // Exit early
        }

        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-pro",
            generationConfig: {
                temperature: 0.7
            }
        });

        const promptTemplatePath = path.join(__dirname, 'prompt_template.txt');
        let prompt = fs.readFileSync(promptTemplatePath, 'utf-8');

        prompt = prompt.replace('{{VIDEO_TITLE}}', videoTitle);
        prompt = prompt.replace('{{SUBTITLES}}', subtitleContent);

        const result = await model.generateContent([prompt, ...imageParts]);

        // Log API cost
        try {
            const usageMetadata = result.response.usageMetadata;
            if (usageMetadata) {
                const { promptTokenCount, candidatesTokenCount, totalTokenCount } = usageMetadata;
                
                // Official Gemini 2.5 Pro pricing (per 1M tokens)
                let inputCostPerMillionTokens;
                let outputCostPerMillionTokens;

                if (totalTokenCount <= 200000) {
                    inputCostPerMillionTokens = 1.25; // <= 200k tokens tier
                    outputCostPerMillionTokens = 10.00; // <= 200k tokens tier
                } else {
                    inputCostPerMillionTokens = 2.50; // > 200k tokens tier
                    outputCostPerMillionTokens = 15.00; // > 200k tokens tier
                }

                const inputCost = (promptTokenCount / 1000000) * inputCostPerMillionTokens;
                const outputCost = (candidatesTokenCount / 1000000) * outputCostPerMillionTokens;
                const cost = inputCost + outputCost;

                db.addApiCost({
                    videoId,
                    model_used: 'gemini-2.5-pro',
                    image_tokens: promptTokenCount,
                    text_tokens: candidatesTokenCount,
                    cost
                });
                logger.info(`[${requestHash}] Logged API cost for batch: ${cost.toFixed(6)} USD for ${totalTokenCount} tokens (Input: ${promptTokenCount}, Output: ${candidatesTokenCount}).`);
            }
        } catch (costError) {
            logger.error(`[${requestHash}] Failed to log API cost for batch:`, costError);
        }
        
        if (result.response.promptFeedback && result.response.promptFeedback.blockReason) {
            const reason = result.response.promptFeedback.blockReason;
            logger.error(`[${requestHash}] AI request was blocked. Reason: ${reason}`);
            throw new Error(`The AI prompt was blocked due to prohibited content: ${reason}`);
        }

        const scriptText = result.response.text();
        
        const scriptLines = scriptText.split('\n').filter(line => line.trim().startsWith('['));
        const finalScriptData = scriptLines.map((line) => {
            const match = line.match(/^\s*\[(\d+)\]\s*\[v(\d)\]\s*(.*)\s*$/);
            if (!match) return null;

            const id = crypto.createHash('sha256').update(line).digest('hex');
            const [, timestampStr, verbosity, text] = match;
            const timestamp = parseInt(timestampStr, 10);
            return { id, timestamp, text: text.trim(), verbosity: `v${verbosity}` };
        }).filter(Boolean);

        // 3. Finalize
        finalScriptData.sort((a, b) => a.timestamp - b.timestamp);
        const responsePayload = { videoId, title: videoTitle, duration: Math.round(totalDuration), script: finalScriptData };
        db.saveVideo(responsePayload);

        timeEnd(aiLabel);
        logger.info(`[${requestHash}] Successfully generated and cached script text for batch processing.`);
        
    } catch (error) {
        db.updateVideoStatus(videoId, 'failed', error.message);
        logger.error(new Error(`[${requestHash}] Error in batch processing: ${error.message}`));
    } finally {
        if (fs.existsSync(baseTempDir)) {
            await fs.promises.rm(baseTempDir, { recursive: true, force: true });
        }
        timeEnd(totalTimeLabel);
    }
};

module.exports = { processVideo, processVideoBatch };