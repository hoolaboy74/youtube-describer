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

    try {
        db.ensurePreliminaryRecord(videoId);
    } catch (dbError) {
        logger.error(`[${requestHash}] Failed to create initial pending record for ${videoId}:`, dbError);
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

        logger.info(`[${requestHash}] Step 1: Starting initial data extraction...`);
        const extractionLabel = `[${requestHash}] Initial Data Extraction Time`;
        time(extractionLabel);

        if (sseHandler) sseHandler('status_update', { message: '영상 정보 확인 중...' });

        const cookiePath = getRandomCookiePath();
        const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];
        const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

        // YT-DLP Call 1: Get video metadata
        const { stdout } = await util.promisify(execFile)('yt-dlp', [
            '-j',
            '-f', 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]',
            '--no-progress',
            ...cookieArgs,
            ...proxyArgs,
            youtubeUrl
        ]);
        const videoInfo = JSON.parse(stdout);

        const videoTitle = videoInfo.title;
        const totalDuration = videoInfo.duration;
        const filesize = videoInfo.filesize || videoInfo.filesize_approx || 0;
        const autoSubtitleInfo = videoInfo.automatic_captions?.ko;

        if (videoInfo.is_live) {
            const reason = `live_stream_not_supported`;
            db.updateVideoStatus(videoId, 'failed', reason);
            throw new Error('Live streams cannot be processed.');
        }

        const durationLimitMinutes = parseInt(db.getSetting('videoDurationLimit') || '30', 10);
        if (durationLimitMinutes > 0 && totalDuration >= durationLimitMinutes * 60) {
            const reason = `duration_exceeded`;
            db.updateVideoStatus(videoId, 'failed', reason);
            throw new Error(`Video duration (${totalDuration}s) exceeds the limit of ${durationLimitMinutes} minutes.`);
        }

        db.ensureVideoRecord({ videoId, title: videoTitle, duration: Math.round(totalDuration), filesize });
        
        let subtitleContent = '';
        const subtitleFilename = autoSubtitleInfo ? `${videoInfo.id}.ko.vtt` : null;
        const subtitlePath = subtitleFilename ? path.join(baseTempDir, subtitleFilename) : null;
        
        if (sseHandler) sseHandler('status_update', { message: '프레임/자막 처리 중...' });

        // YT-DLP Call 2: Stream video for frames AND download subtitles
        const allTimestamps = await new Promise((resolve, reject) => {
            const extractedTimestamps = [];
            let lastReportedProgress = -1;

            const ytdlpArgs = [
                '-f', 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]',
                '-o', '-',
                '--no-progress',
                '--write-auto-sub',
                '--sub-lang', 'ko',
                ...cookieArgs,
                ...proxyArgs,
                youtubeUrl
            ];
            
            const ffmpegArgs = ['-i', '-', '-vf', "select='isnan(prev_selected_t)+gt(scene,0.4)+gte(t-prev_selected_t,5)',showinfo", '-vsync', 'vfr', path.join(baseTempDir, 'frame-%04d.png')];
            
            const ytdlpProcess = spawn('yt-dlp', ytdlpArgs, { cwd: baseTempDir }); // Set CWD to temp directory
            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
            
            ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);
            
            let ffmpegStderr = '';
            ffmpegProcess.stderr.on('data', (data) => {
                const stderrChunk = data.toString();
                ffmpegStderr += stderrChunk;

                const timeMatches = stderrChunk.matchAll(/pts_time:(\d+\.?\d*)/g);
                for (const match of timeMatches) {
                    extractedTimestamps.push(parseFloat(match[1]));
                }

                if (sseHandler && totalDuration > 0) {
                    const progressMatches = stderrChunk.matchAll(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/g);
                    let lastMatch = null;
                    for (const match of progressMatches) { lastMatch = match; }

                    if (lastMatch) {
                        const currentTime = parseInt(lastMatch[1], 10) * 3600 + parseInt(lastMatch[2], 10) * 60 + parseInt(lastMatch[3], 10);
                        const progress = Math.min(100, Math.round((currentTime / totalDuration) * 100));
                        if (progress > lastReportedProgress) {
                            lastReportedProgress = progress;
                            sseHandler('status_update', { message: `${progress}%` });
                        }
                    }
                }
            });

            ytdlpProcess.on('error', (err) => reject(new Error(`yt-dlp spawn error: ${err.message}`)));
            ffmpegProcess.on('error', (err) => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
            
            ffmpegProcess.on('close', (code) => {
                if (code === 0) resolve(extractedTimestamps.sort((a, b) => a - b));
                else reject(new Error(`ffmpeg frame extraction exited with code ${code}. Stderr: ${ffmpegStderr}`));
            });
        });
        
        if (subtitlePath && fs.existsSync(subtitlePath)) {
            subtitleContent = preprocessVtt(fs.readFileSync(subtitlePath, 'utf-8'));
            logger.info(`[${requestHash}] Successfully loaded and preprocessed subtitles.`);
        } else {
            logger.warn(`[${requestHash}] Subtitle file not found. Proceeding without subtitles.`);
        }

        timeEnd(extractionLabel);
        logger.info(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, Total Frames: ${allTimestamps.length}`);
        
        if (sseHandler) sseHandler('start', { videoId, title: videoTitle });

        logger.info(`[${requestHash}] Step 2: Starting AI generation...`);
        const aiLabel = `[${requestHash}] Full AI Process Time`;
        time(aiLabel);

        if (sseHandler) sseHandler('status_update', { message: 'AI로 전체 대본 생성 중...' });

        const allFrameFiles = (await fs.promises.readdir(baseTempDir)).filter(f => f.endsWith('.png')).sort();
        const imageParts = [];

        for (let i = 0; i < allTimestamps.length; i++) {
            const timestamp = allTimestamps[i];
            const frameFile = allFrameFiles[i];
            if (frameFile && fs.existsSync(path.join(baseTempDir, frameFile))) {
                imageParts.push({ inlineData: { data: Buffer.from(await fs.promises.readFile(path.join(baseTempDir, frameFile))).toString("base64"), mimeType: 'image/png' } });
                imageParts.push({ text: `Timestamp: [${Math.round(timestamp)}]` });
            }
        }

        if (imageParts.length === 0) {
            logger.warn(`[${requestHash}] No frames to process. Marking as complete with empty script.`);
            db.updateVideoStatus(videoId, 'completed');
            if (sseHandler) sseHandler('end', { message: 'Processing complete, no frames found.' });
            return;
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro", generationConfig: { temperature: 0.7 } });
        const promptTemplatePath = path.join(__dirname, 'prompt_template.txt');
        let prompt = fs.readFileSync(promptTemplatePath, 'utf-8');
        prompt = prompt.replace('{{VIDEO_TITLE}}', videoTitle).replace('{{SUBTITLES}}', subtitleContent);

        const result = await model.generateContentStream([prompt, ...imageParts]);
        const fullScript = [];
        let scriptBuffer = '';
        let dbChunkBuffer = [];

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
                        if (sseHandler) sseHandler('script_chunk', newScriptData);
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
                const match = line.match(/^\s*\[(\d+)\]\s*\[v(\d)\]\s*(.*)\s*$/);
                if (!match) return null;
                return { id: crypto.createHash('sha256').update(line).digest('hex'), timestamp: parseInt(match[1], 10), text: match[3].trim(), verbosity: `v${match[2]}` };
            }).filter(Boolean);
            if (finalLines.length > 0) {
                if (sseHandler) sseHandler('script_chunk', finalLines);
                dbChunkBuffer.push(...finalLines);
                fullScript.push(...finalLines);
            }
        }

        if (dbChunkBuffer.length > 0) {
            db.saveVideoChunk({ videoId, scriptChunk: dbChunkBuffer });
        }
        
        const finalResponse = await result.response;
        const usageMetadata = finalResponse.usageMetadata;
        if (usageMetadata) {
            const { promptTokenCount, candidatesTokenCount, totalTokenCount } = usageMetadata;
            let inputCost = (promptTokenCount / 1000000) * (totalTokenCount <= 200000 ? 1.25 : 2.50);
            let outputCost = (candidatesTokenCount / 1000000) * (totalTokenCount <= 200000 ? 10.00 : 15.00);
            db.addApiCost({ videoId, model_used: 'gemini-2.5-pro', image_tokens: promptTokenCount, text_tokens: candidatesTokenCount, cost: inputCost + outputCost });
            logger.info(`[${requestHash}] Logged API cost: ${(inputCost + outputCost).toFixed(6)} USD`);
        }

        db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), filesize, script: fullScript });
        timeEnd(aiLabel);
        if (sseHandler) sseHandler('end', { message: 'Processing complete.' });
        
    } catch (error) {
        db.updateVideoStatus(videoId, 'failed', error.message);
        logger.error(new Error(`[${requestHash}] Error processing request: ${error.message}`));
        if (sseHandler) {
            let clientMessage = 'An unexpected error occurred.';
            if (error.message.includes('duration')) clientMessage = error.message;
            if (error.message.includes('Live stream')) clientMessage = 'Live streams cannot be processed.';
            sseHandler('backend_error', { message: 'Failed to process video', details: clientMessage });
        }
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
        if (cachedData && cachedData.status === 'completed') {
            logger.info(`[${requestHash}] Cache hit for videoId: ${videoId}. Batch processing not needed.`);
            return;
        }

        await fs.promises.mkdir(baseTempDir, { recursive: true });

        logger.info(`[${requestHash}] Step 1: Starting initial data extraction...`);
        const extractionLabel = `[${requestHash}] Initial Data Extraction Time`;
        time(extractionLabel);

        const cookiePath = getRandomCookiePath();
        const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];
        const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

        // YT-DLP Call 1: Get metadata
        const { stdout: stdoutJson } = await util.promisify(execFile)('yt-dlp', ['-j', '-f', 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]', '--no-progress', ...cookieArgs, ...proxyArgs, youtubeUrl]);
        const videoInfo = JSON.parse(stdoutJson);

        const videoTitle = videoInfo.title;
        const totalDuration = videoInfo.duration;
        const filesize = videoInfo.filesize || videoInfo.filesize_approx || 0;
        const autoSubtitleInfo = videoInfo.automatic_captions?.ko;

        if (videoInfo.is_live) throw new Error('Live streams cannot be processed.');
        const durationLimitMinutes = parseInt(db.getSetting('videoDurationLimit') || '30', 10);
        if (durationLimitMinutes > 0 && totalDuration >= durationLimitMinutes * 60) {
            throw new Error(`Video duration (${totalDuration}s) exceeds the limit of ${durationLimitMinutes} minutes.`);
        }

        db.ensureVideoRecord({ videoId, title: videoTitle, duration: Math.round(totalDuration), filesize });

        let subtitleContent = '';
        const subtitleFilename = autoSubtitleInfo ? `${videoInfo.id}.ko.vtt` : null;
        const subtitlePath = subtitleFilename ? path.join(baseTempDir, subtitleFilename) : null;
        
        // YT-DLP Call 2: Stream video AND download subtitles
        const allTimestamps = await new Promise((resolve, reject) => {
            const ytdlpArgs = ['-f', 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]', '-o', '-', '--no-progress', '--write-auto-sub', '--sub-lang', 'ko', ...cookieArgs, ...proxyArgs, youtubeUrl];
            const ffmpegArgs = ['-i', '-', '-vf', "select='isnan(prev_selected_t)+gt(scene,0.4)+gte(t-prev_selected_t,5)',showinfo", '-vsync', 'vfr', path.join(baseTempDir, 'frame-%04d.png')];
            const ytdlpProcess = spawn('yt-dlp', ytdlpArgs, { cwd: baseTempDir });
            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
            ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);
            let ffmpegStderr = '';
            const extractedTimestamps = [];
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
                if (code === 0) resolve(extractedTimestamps.sort((a,b) => a - b));
                else reject(new Error(`ffmpeg frame extraction exited with code ${code}. Stderr: ${ffmpegStderr}`));
            });
        });

        if (subtitlePath && fs.existsSync(subtitlePath)) {
            subtitleContent = preprocessVtt(fs.readFileSync(subtitlePath, 'utf-8'));
            logger.info(`[${requestHash}] Successfully loaded subtitles for batch.`);
        } else {
            logger.warn(`[${requestHash}] Subtitle file not found for batch.`);
        }

        timeEnd(extractionLabel);
        logger.info(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, Total Frames: ${allTimestamps.length}`);

        logger.info(`[${requestHash}] Step 2: Starting AI generation...`);
        const aiLabel = `[${requestHash}] Full AI Process Time`;
        time(aiLabel);

        const allFrameFiles = (await fs.promises.readdir(baseTempDir)).filter(f => f.endsWith('.png')).sort();
        const imageParts = [];

        for (let i = 0; i < allTimestamps.length; i++) {
            const timestamp = allTimestamps[i];
            const frameFile = allFrameFiles[i];
            if (frameFile && fs.existsSync(path.join(baseTempDir, frameFile))) {
                imageParts.push({ inlineData: { data: Buffer.from(await fs.promises.readFile(path.join(baseTempDir, frameFile))).toString("base64"), mimeType: 'image/png' } });
                imageParts.push({ text: `Timestamp: [${Math.round(timestamp)}]` });
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

        const usageMetadata = result.response.usageMetadata;
        if (usageMetadata) {
            const { promptTokenCount, candidatesTokenCount, totalTokenCount } = usageMetadata;
            let inputCost = (promptTokenCount / 1000000) * (totalTokenCount <= 200000 ? 1.25 : 2.50);
            let outputCost = (candidatesTokenCount / 1000000) * (totalTokenCount <= 200000 ? 10.00 : 15.00);
            db.addApiCost({ videoId, model_used: 'gemini-2.5-pro', image_tokens: promptTokenCount, text_tokens: candidatesTokenCount, cost: inputCost + outputCost });
            logger.info(`[${requestHash}] Logged API cost for batch: ${(inputCost + outputCost).toFixed(6)} USD`);
        }
        
        if (result.response.promptFeedback && result.response.promptFeedback.blockReason) {
            throw new Error(`The AI prompt was blocked due to prohibited content: ${result.response.promptFeedback.blockReason}`);
        }

        const scriptText = result.response.text();
        const scriptLines = scriptText.split('\n').filter(line => line.trim().startsWith('['));
        const finalScriptData = scriptLines.map((line) => {
            const match = line.match(/^\s*\[(\d+)\]\s*\[v(\d)\]\s*(.*)\s*$/);
            if (!match) return null;
            return { id: crypto.createHash('sha256').update(line).digest('hex'), timestamp: parseInt(match[1], 10), text: match[3].trim(), verbosity: `v${match[2]}` };
        }).filter(Boolean);

        finalScriptData.sort((a, b) => a.timestamp - b.timestamp);
        db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), filesize, script: finalScriptData });

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