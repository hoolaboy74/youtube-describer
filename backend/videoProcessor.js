

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

/**
 * Extracts frames from a video using a hybrid method of scene detection and periodic extraction.
 * @param {string} videoId - The YouTube video ID.
 * @param {string} youtubeUrl - The full YouTube URL.
 * @param {string} baseTempDir - The base temporary directory for processing.
 * @param {Function} sseHandler - The SSE handler for status updates.
 * @returns {Promise<{finalTimestamps: number[], allFrameFiles: string[]}>} - The final timestamps and paths to the extracted frames.
 */
const extractHybridFrames = async (videoId, youtubeUrl, baseTempDir, sseHandler) => {
    const requestHash = videoId.substring(0, 8);
    const videoPath = path.join(baseTempDir, 'video.mp4');
    
    // --- Step 1: Download video ONCE ---
    sseHandler?.('status_update', { message: '영상 다운로드 중 (최대 1분 소요)...' });
    const downloadLabel = `[${requestHash}] Download Time`;
    time(downloadLabel);
    
    const cookiePath = getRandomCookiePath();
    const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];
    const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

    await util.promisify(execFile)('yt-dlp', [
        '-f', 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]',
        '-o', videoPath,
        '--no-progress',
        ...cookieArgs,
        ...proxyArgs,
        youtubeUrl
    ]);
    timeEnd(downloadLabel);

    // --- Step 2 & 3: Get scene and periodic timestamps from the local file ---
    sseHandler?.('status_update', { message: '주요 장면 및 시간 분석 중...' });
    const timestampLabel = `[${requestHash}] Timestamp Gathering Time`;
    time(timestampLabel);

    const [sceneTimestamps, periodicTimestamps] = await Promise.all([
        new Promise((resolve, reject) => {
            const timestamps = [];
            const ffmpegProcess = spawn('ffmpeg', ['-i', videoPath, '-vf', "select='gt(scene,0.4)',showinfo", '-f', 'null', '-']);
            ffmpegProcess.stderr.on('data', data => {
                const timeMatches = data.toString().matchAll(/pts_time:(\d+\.?\d*)/g);
                for (const match of timeMatches) timestamps.push(parseFloat(match[1]));
            });
            ffmpegProcess.on('error', reject);
            ffmpegProcess.on('close', code => code === 0 ? resolve(timestamps) : reject(new Error(`ffmpeg (scene) exited with code ${code}`)));
        }),
        new Promise((resolve, reject) => {
            const timestamps = [];
            const ffmpegProcess = spawn('ffmpeg', ['-i', videoPath, '-vf', "fps=1/5,showinfo", '-f', 'null', '-']);
            ffmpegProcess.stderr.on('data', data => {
                const timeMatches = data.toString().matchAll(/pts_time:(\d+\.?\d*)/g);
                for (const match of timeMatches) timestamps.push(parseFloat(match[1]));
            });
            ffmpegProcess.on('error', reject);
            ffmpegProcess.on('close', code => code === 0 ? resolve(timestamps) : reject(new Error(`ffmpeg (periodic) exited with code ${code}`)));
        })
    ]);
    timeEnd(timestampLabel);
    logger.info(`[${requestHash}] Found ${sceneTimestamps.length} scene timestamps and ${periodicTimestamps.length} periodic timestamps.`);

    // --- Step 4: Merge and deduplicate timestamps ---
    const combined = [...sceneTimestamps, ...periodicTimestamps];
    combined.sort((a, b) => a - b);
    
    const finalTimestamps = [];
    if (combined.length > 0) {
        finalTimestamps.push(combined[0]);
        for (let i = 1; i < combined.length; i++) {
            if (combined[i] - finalTimestamps[finalTimestamps.length - 1] >= 5.0) {
                finalTimestamps.push(combined[i]);
            }
        }
    }
    logger.info(`[${requestHash}] Final timestamp count after deduplication: ${finalTimestamps.length}`);

    // --- Step 5: Extract final frames ---
    if (finalTimestamps.length === 0) {
        logger.warn(`[${requestHash}] No frames to process after deduplication. Exiting.`);
        return { finalTimestamps: [], allFrameFiles: [] };
    }
    sseHandler?.('status_update', { message: `최종 프레임 ${finalTimestamps.length}개 추출 중...` });
    const extractionLabel = `[${requestHash}] Final Frame Extraction Time`;
    time(extractionLabel);
    
    const selectFilter = finalTimestamps.map(t => `eq(t,${t})`).join('+');

    await new Promise((resolve, reject) => {
        const ffmpegProcess = spawn('ffmpeg', [
            '-i', videoPath, '-vf', `select='${selectFilter}',showinfo`, '-vsync', 'vfr', path.join(baseTempDir, 'frame-%04d.png')
        ]);
        let ffmpegStderr = '';
        ffmpegProcess.stderr.on('data', data => { ffmpegStderr += data.toString(); });
        ffmpegProcess.on('error', reject);
        ffmpegProcess.on('close', code => code === 0 ? resolve() : reject(new Error(`Final frame extraction failed with code ${code}. Stderr: ${ffmpegStderr}`)));
    });
    timeEnd(extractionLabel);

    const allFrameFiles = (await fs.promises.readdir(baseTempDir)).filter(f => f.endsWith('.png')).sort();
    return { finalTimestamps, allFrameFiles };
};


const processVideo = async (videoId, youtubeUrl, sseHandler = null) => {
    const requestHash = sseHandler ? videoId.substring(0, 8) : `batch-${videoId.substring(0, 8)}`;

    if (processingLocks.has(videoId)) {
        logger.warn(`[${requestHash}] Duplicate request for ${videoId}. The process is already running.`);
        sseHandler?.('duplicate_request', { message: 'This video is already being processed.' });
        return;
    }

    if (!isValidYoutubeUrl(youtubeUrl)) {
        logger.error(`[${requestHash}] Invalid YouTube URL provided: ${youtubeUrl}`);
        sseHandler?.('backend_error', { message: 'Invalid YouTube URL' });
        processingLocks.delete(videoId);
        return;
    }

    processingLocks.add(videoId);

    try {
        db.ensurePreliminaryRecord(videoId);
    } catch (dbError) {
        logger.error(`[${requestHash}] Failed to create initial pending record for ${videoId}:`, dbError);
        processingLocks.delete(videoId);
        sseHandler?.('backend_error', { message: 'A critical database error occurred.' });
        return;
    }

    const totalTimeLabel = `[${requestHash}] Total Process Time`;
    logger.info(`[${requestHash}] Starting processing for ${youtubeUrl}`);
    time(totalTimeLabel);

    const baseTempDir = path.join(__dirname, 'temp', videoId);

    try {
        const cachedData = db.getVideo(videoId);
        if (cachedData?.script?.length > 0 && cachedData.status === 'completed') {
            logger.info(`[${requestHash}] Cache hit for videoId: ${videoId}.`);
            sseHandler?.('full_script', cachedData);
            return;
        }

        await fs.promises.mkdir(baseTempDir, { recursive: true });
        
        sseHandler?.('status_update', { message: '영상 정보 확인 중...' });
        
        const cookiePath = getRandomCookiePath();
        const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];
        const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

        const { stdout } = await util.promisify(execFile)('yt-dlp', [
            '-j', '-f', 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]',
            '--no-progress', ...cookieArgs, ...proxyArgs, youtubeUrl
        ]);
        const videoInfo = JSON.parse(stdout);

        const { title: videoTitle, duration: totalDuration, filesize } = videoInfo;

        if (videoInfo.is_live) {
            const reason = `live_stream_not_supported: is_live is true`;
            logger.warn(`[${requestHash}] Video processing blocked for ${videoId} because it is a live stream.`);
            db.updateVideoStatus(videoId, 'failed', reason);
            sseHandler?.('backend_error', { message: 'live_stream_not_supported', details: 'Live streams cannot be processed.' });
            return;
        }

        const durationLimitMinutes = parseInt(db.getSetting('videoDurationLimit') || '30', 10);
        if (durationLimitMinutes > 0 && totalDuration >= durationLimitMinutes * 60) {
            const reason = `duration_exceeded: ${totalDuration}s > ${durationLimitMinutes * 60}s`;
            logger.warn(`[${requestHash}] Video processing blocked for ${videoId} due to duration.`);
            db.updateVideoStatus(videoId, 'failed', reason);
            sseHandler?.('backend_error', { message: 'duration_exceeded', limit: durationLimitMinutes });
            return;
        }

        db.ensureVideoRecord({ videoId, title: videoTitle, duration: Math.round(totalDuration), filesize });

        sseHandler?.('status_update', { message: '자막 정보 확인 중...' });

        let subtitleContent = '';
        const subtitlePath = path.join(baseTempDir, 'subtitles.ko.vtt');
        try {
            await util.promisify(execFile)('yt-dlp', [
                '--write-auto-sub', '--sub-lang', 'ko', '--sub-format', 'vtt',
                '--output', `${baseTempDir}/subtitles`, '--skip-download',
                '--no-progress', ...cookieArgs, ...proxyArgs, youtubeUrl
            ]);
            
            if (fs.existsSync(subtitlePath)) {
                const rawVtt = fs.readFileSync(subtitlePath, 'utf-8');
                subtitleContent = preprocessVtt(rawVtt);
                logger.info(`[${requestHash}] Successfully loaded and preprocessed subtitles.`);
            } else {
                logger.warn(`[${requestHash}] yt-dlp did not create a subtitle file. Proceeding without subtitles.`);
            }
        } catch (error) {
            logger.warn(`[${requestHash}] Error fetching subtitles: ${error.message}.`);
        }

        // --- NEW HYBRID FRAME EXTRACTION ---
        const { finalTimestamps, allFrameFiles } = await extractHybridFrames(videoId, youtubeUrl, baseTempDir, sseHandler);
        logger.info(`[${requestHash}] Hybrid extraction complete. Total Frames: ${finalTimestamps.length}`);
        
        sseHandler?.('start', { videoId, title: videoTitle });

        // --- AI Generation ---
        sseHandler?.('status_update', { message: 'AI로 전체 대본 생성 중...' });
        const aiLabel = `[${requestHash}] Full AI Process Time`;
        time(aiLabel);

        const imageParts = [];
        for (let i = 0; i < finalTimestamps.length; i++) {
            const timestamp = finalTimestamps[i];
            const frameFile = allFrameFiles[i];
            if (frameFile) {
                const framePath = path.join(baseTempDir, frameFile);
                if (fs.existsSync(framePath)) {
                    imageParts.push({ inlineData: { data: Buffer.from(fs.readFileSync(framePath)).toString("base64"), mimeType: 'image/png' } });
                    imageParts.push({ text: `Timestamp: [${Math.round(timestamp)}]` });
                }
            }
        }
        
        if (imageParts.length === 0) {
            logger.warn(`[${requestHash}] No frames to process. Marking as complete with empty script.`);
            db.updateVideoStatus(videoId, 'completed');
            sseHandler?.('end', { message: 'Processing complete, no frames found.' });
            return;
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro", generationConfig: { temperature: 0.7 } });
        const promptTemplatePath = path.join(__dirname, 'prompt_template.txt');
        let prompt = fs.readFileSync(promptTemplatePath, 'utf-8');
        prompt = prompt.replace('{{VIDEO_TITLE}}', videoTitle).replace('{{SUBTITLES}}', subtitleContent);

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
                        return { id: crypto.createHash('sha256').update(line).digest('hex'), timestamp: parseInt(match[1], 10), text: match[3].trim(), verbosity: `v${match[2]}` };
                    }).filter(Boolean);

                    if (newScriptData.length > 0) {
                        sseHandler?.('script_chunk', newScriptData);
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
        
        if (scriptBuffer.trim()) {
             const finalLines = scriptBuffer.split('\n').map(line => {
                const match = line.match(/^\s*\[(\d{2}):(\d{2}):(\d{2})\]\s*\[v(\d)\]\s*(.*)\s*$/);
                if (!match) return null;
                const timestamp = parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseInt(match[3], 10);
                return { id: crypto.createHash('sha256').update(line).digest('hex'), timestamp, text: match[5].trim(), verbosity: `v${match[4]}` };
            }).filter(Boolean);

            if (finalLines.length > 0) {
                sseHandler?.('script_chunk', finalLines);
                dbChunkBuffer.push(...finalLines);
                fullScript.push(...finalLines);
            }
        }

        if (dbChunkBuffer.length > 0) db.saveVideoChunk({ videoId, scriptChunk: dbChunkBuffer });

        try {
            const finalResponse = await result.response;
            const usageMetadata = finalResponse.usageMetadata;
            if (usageMetadata) {
                const { promptTokenCount, candidatesTokenCount, totalTokenCount } = usageMetadata;
                const inputCost = (promptTokenCount / 1000000) * (totalTokenCount <= 200000 ? 1.25 : 2.50);
                const outputCost = (candidatesTokenCount / 1000000) * (totalTokenCount <= 200000 ? 10.00 : 15.00);
                db.addApiCost({ videoId, model_used: 'gemini-2.5-pro', image_tokens: promptTokenCount, text_tokens: candidatesTokenCount, cost: inputCost + outputCost });
                logger.info(`[${requestHash}] Logged API cost: ${(inputCost + outputCost).toFixed(6)} USD`);
            }
        } catch (costError) {
            logger.error(`[${requestHash}] Failed to log API cost:`, costError);
        }

        db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), filesize, script: fullScript });
        
        timeEnd(aiLabel);
        logger.info(`[${requestHash}] Successfully generated and streamed script text.`);
        sseHandler?.('end', { message: 'Processing complete.' });
        
    } catch (error) {
        db.updateVideoStatus(videoId, 'failed', error.message);
        logger.error(new Error(`[${requestHash}] Error processing request: ${error.message}`), error);
        sseHandler?.('backend_error', { message: 'Failed to process video', details: 'An unexpected error occurred.' });
    } finally {
        if (fs.existsSync(baseTempDir)) {
            await fs.promises.rm(baseTempDir, { recursive: true, force: true });
        }
        processingLocks.delete(videoId);
        timeEnd(totalTimeLabel);
    }
};

const processVideoBatch = async (videoId, youtubeUrl) => {
    const requestHash = `batch-${videoId.substring(0, 8)}`;
    if (!isValidYoutubeUrl(youtubeUrl)) {
        logger.error(`[${requestHash}] Invalid YouTube URL provided: ${youtubeUrl}`);
        return;
    }

    try {
        db.ensurePreliminaryRecord(videoId);
    } catch (dbError) {
        logger.error(`[${requestHash}] Failed to create initial pending record for ${videoId}:`, dbError);
        return;
    }

    const totalTimeLabel = `[${requestHash}] Total Batch Process Time`;
    logger.info(`[${requestHash}] Starting batch processing for ${youtubeUrl}`);
    time(totalTimeLabel);

    const baseTempDir = path.join(__dirname, 'temp', videoId);

    try {
        const cachedData = db.getVideo(videoId);
        if (cachedData?.status === 'completed') {
            logger.info(`[${requestHash}] Cache hit for videoId: ${videoId}. Batch processing not needed.`);
            return;
        }

        await fs.promises.mkdir(baseTempDir, { recursive: true });

        const cookiePath = getRandomCookiePath();
        const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];
        const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

        const { stdout: stdoutJson } = await util.promisify(execFile)('yt-dlp', [
            '-j', '-f', 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]',
            '--no-progress', ...cookieArgs, ...proxyArgs, youtubeUrl
        ]);
        const videoInfo = JSON.parse(stdoutJson);

        const { title: videoTitle, duration: totalDuration, filesize } = videoInfo;

        if (videoInfo.is_live) {
            const reason = `live_stream_not_supported: is_live is true`;
            logger.warn(`[${requestHash}] Batch processing blocked for ${videoId} because it is a live stream.`);
            db.updateVideoStatus(videoId, 'failed', reason);
            return;
        }

        const durationLimitMinutes = parseInt(db.getSetting('videoDurationLimit') || '30', 10);
        if (durationLimitMinutes > 0 && totalDuration >= durationLimitMinutes * 60) {
            const reason = `duration_exceeded: ${totalDuration}s > ${durationLimitMinutes * 60}s`;
            logger.warn(`[${requestHash}] Batch processing blocked for ${videoId} due to duration.`);
            db.updateVideoStatus(videoId, 'failed', reason);
            return;
        }
        
        let subtitleContent = '';
        const subtitlePath = path.join(baseTempDir, 'subtitles.ko.vtt');
        try {
            await util.promisify(execFile)('yt-dlp', [
                '--write-auto-sub', '--sub-lang', 'ko', '--sub-format', 'vtt',
                '--output', `${baseTempDir}/subtitles`, '--skip-download',
                '--no-progress', ...cookieArgs, ...proxyArgs, youtubeUrl
            ]);
            if (fs.existsSync(subtitlePath)) {
                const rawVtt = fs.readFileSync(subtitlePath, 'utf-8');
                subtitleContent = preprocessVtt(rawVtt);
            }
        } catch(e){
             logger.warn(`[${requestHash}] Could not fetch subtitles for batch: ${e.message}.`);
        }

        db.ensureVideoRecord({ videoId, title: videoTitle, duration: Math.round(totalDuration), filesize });

        // --- NEW HYBRID FRAME EXTRACTION ---
        const { finalTimestamps, allFrameFiles } = await extractHybridFrames(videoId, youtubeUrl, baseTempDir, null);
        logger.info(`[${requestHash}] Hybrid extraction complete. Total Frames: ${finalTimestamps.length}`);

        const imageParts = [];
        for (let i = 0; i < finalTimestamps.length; i++) {
            const timestamp = finalTimestamps[i];
            const frameFile = allFrameFiles[i];
            if (frameFile) {
                const framePath = path.join(baseTempDir, frameFile);
                if (fs.existsSync(framePath)) {
                    imageParts.push({ inlineData: { data: Buffer.from(fs.readFileSync(framePath)).toString("base64"), mimeType: 'image/png' } });
                    imageParts.push({ text: `Timestamp: [${Math.round(timestamp)}]` });
                }
            }
        }

        if (imageParts.length === 0) {
            logger.warn(`[${requestHash}] No frames to process. Marking as complete with empty script.`);
            db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), script: [] });
            return;
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro", generationConfig: { temperature: 0.7 } });
        const promptTemplatePath = path.join(__dirname, 'prompt_template.txt');
        let prompt = fs.readFileSync(promptTemplatePath, 'utf-8');
        prompt = prompt.replace('{{VIDEO_TITLE}}', videoTitle).replace('{{SUBTITLES}}', subtitleContent);

        const result = await model.generateContent([prompt, ...imageParts]);
        
        try {
            const usageMetadata = result.response.usageMetadata;
            if (usageMetadata) {
                const { promptTokenCount, candidatesTokenCount, totalTokenCount } = usageMetadata;
                const inputCost = (promptTokenCount / 1000000) * (totalTokenCount <= 200000 ? 1.25 : 2.50);
                const outputCost = (candidatesTokenCount / 1000000) * (totalTokenCount <= 200000 ? 10.00 : 15.00);
                db.addApiCost({ videoId, model_used: 'gemini-2.5-pro', image_tokens: promptTokenCount, text_tokens: candidatesTokenCount, cost: inputCost + outputCost });
                logger.info(`[${requestHash}] Logged API cost for batch: ${(inputCost + outputCost).toFixed(6)} USD`);
            }
        } catch (costError) {
            logger.error(`[${requestHash}] Failed to log API cost for batch:`, costError);
        }
        
        if (result.response.promptFeedback?.blockReason) {
            throw new Error(`The AI prompt was blocked due to prohibited content: ${result.response.promptFeedback.blockReason}`);
        }

        const scriptText = result.response.text();
        const scriptLines = scriptText.split('\n').filter(line => line.trim().startsWith('['));
        const finalScriptData = scriptLines.map(line => {
            const match = line.match(/^\s*\[(\d+)\]\s*\[v(\d)\]\s*(.*)\s*$/);
            if (!match) return null;
            return { id: crypto.createHash('sha256').update(line).digest('hex'), timestamp: parseInt(match[1], 10), text: match[3].trim(), verbosity: `v${match[2]}` };
        }).filter(Boolean);

        finalScriptData.sort((a, b) => a.timestamp - b.timestamp);
        db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), filesize, script: finalScriptData });

        logger.info(`[${requestHash}] Successfully generated and cached script text for batch processing.`);
        
    } catch (error) {
        db.updateVideoStatus(videoId, 'failed', error.message);
        logger.error(new Error(`[${requestHash}] Error in batch processing: ${error.message}`), error);
    } finally {
        if (fs.existsSync(baseTempDir)) {
            await fs.promises.rm(baseTempDir, { recursive: true, force: true });
        }
        timeEnd(totalTimeLabel);
    }
};

module.exports = { processVideo, processVideoBatch };
