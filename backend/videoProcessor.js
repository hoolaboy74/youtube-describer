const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require("googleapis");
const fs = require('fs');
const path = require('path');
const util = require('util');
const os = require('os');
const { execFile, spawn, execSync } = require('child_process');
const crypto = require('crypto');
const db = require('./database');
const { formatTime, preprocessVtt, isValidYoutubeUrl } = require('./utils');
const logger = require('./logger');

let isSafariImpersonateSupported = false;
try {
    const output = execSync('yt-dlp --list-impersonate-targets', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = output.split('\n');
    const safariLine = lines.find(line => line.includes('Safari') || line.includes('safari'));
    if (safariLine && !safariLine.toLowerCase().includes('unavailable')) {
        isSafariImpersonateSupported = true;
    }
} catch (e) {
    try {
        execSync('yt-dlp --impersonate safari -s --playlist-items 0 ""', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        isSafariImpersonateSupported = true;
    } catch (err) {
        const stderr = err.stderr ? err.stderr.toString() : '';
        const stdout = err.stdout ? err.stdout.toString() : '';
        const errorMsg = stderr + stdout;
        if (errorMsg.includes('Impersonate target') || errorMsg.includes('missing dependencies') || errorMsg.includes('curl_cffi')) {
            isSafariImpersonateSupported = false;
        } else {
            isSafariImpersonateSupported = true;
        }
    }
}

if (isSafariImpersonateSupported) {
    logger.info('[Impersonate] yt-dlp supports Safari impersonation.');
} else {
    logger.warn('[Impersonate] yt-dlp Safari impersonation is NOT supported by the environment. Bypassing impersonation.');
}
const impersonateArgs = isSafariImpersonateSupported ? ['--impersonate', 'safari'] : [];

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error("GOOGLE_API_KEY is not defined in the environment");
}
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";
const genAI = new GoogleGenerativeAI(API_KEY);
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || API_KEY;
const youtube = google.youtube({ version: 'v3', auth: YOUTUBE_API_KEY });

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

const processingLocks = new Set();
const timers = new Map();

const getPoToken = async () => {
    return new Promise((resolve) => {
        const denoPath = 'deno'; // Assumes deno is in PATH
        const scriptPath = path.join(__dirname, 'get_pot.ts');
        
        // Add --unsafely-ignore-certificate-errors to handle SSL issues in some dev environments
        const child = spawn(denoPath, ['run', '--allow-net', '--unsafely-ignore-certificate-errors', scriptPath]);
        let output = '';
        
        child.stdout.on('data', (data) => { output += data.toString(); });
        child.on('close', (code) => {
            if (code !== 0) {
                logger.warn(`Deno PO Token generator exited with code ${code}`);
                return resolve(null);
            }
            try {
                const parsed = JSON.parse(output);
                if (parsed.error) {
                    logger.warn(`Deno PO Token error: ${parsed.error}`);
                    return resolve(null);
                }
                resolve(parsed);
            } catch (e) {
                logger.warn(`Failed to parse PO Token output: ${output}`);
                resolve(null);
            }
        });
        
        // Timeout after 10 seconds
        setTimeout(() => {
            if (child.exitCode === null) {
                child.kill();
                logger.warn('PO Token generation timed out');
                resolve(null);
            }
        }, 10000);
    });
};

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
 * Parallel Keyframe Extraction using FFmpeg Time-Chunking
 */
async function extractKeyframesHybrid({ tempVideoPath, tempVideoFilename, baseTempDir, totalDuration, requestHash, sseHandler }) {
    if (!fs.existsSync(tempVideoPath)) {
        throw new Error('Video file download failed or file not found.');
    }

    logger.info(`[${requestHash}] Starting hybrid keyframe extraction (duration: ${totalDuration}s)`);

    // Step 1: Fast I-frame extraction with showinfo
    // sse status update omitted for high-speed extraction
    const rawTimestamps = await new Promise((resolve, reject) => {
        const extractedTimestamps = [];
        let chunkStderr = '';

        const ffmpegArgs = [
            '-loglevel', 'info',
            '-skip_frame', 'nokey', // I-frame only decoding to reduce CPU load by 90%
            '-i', tempVideoFilename,
            '-vf', "fps=1/2,scale=640:-1,showinfo",
            '-vsync', '0',
            '-q:v', '5',
            `frame_raw_%04d.jpg`
        ];

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { cwd: baseTempDir });

        ffmpegProcess.stderr.on('data', (data) => {
            const stderrChunk = data.toString();
            chunkStderr += stderrChunk;
            if (chunkStderr.length > 10000) {
                chunkStderr = chunkStderr.substring(chunkStderr.length - 10000);
            }
            
            const timeMatches = stderrChunk.matchAll(/pts_time:(\d+\.?\d*)/g);
            for (const match of timeMatches) {
                extractedTimestamps.push(parseFloat(match[1]));
            }

            // progress report omitted since extraction takes < 1.5 seconds
        });

        ffmpegProcess.on('error', (err) => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
        ffmpegProcess.on('close', (code) => {
            if (code === 0 || chunkStderr.includes('Nothing was written into output file') || chunkStderr.includes('No filtered frames')) {
                resolve(extractedTimestamps.sort((a, b) => a - b));
            } else {
                reject(new Error(`ffmpeg exited with code ${code}. Stderr: ${chunkStderr}`));
            }
        });
    });

    // Step 2: Gap Detection
    logger.info(`[${requestHash}] Raw I-frame extraction complete. Detected ${rawTimestamps.length} frames. Scanning for gaps...`);
    const gapTargetTimes = [];
    for (let target = 0; target < totalDuration; target += 2) {
        const closest = rawTimestamps.find(t => Math.abs(t - target) <= 1.0);
        if (!closest) {
            gapTargetTimes.push(target);
        }
    }

    // Step 3: Backfill Execution
    if (gapTargetTimes.length > 0) {
        logger.info(`[${requestHash}] Found ${gapTargetTimes.length} missing frame slots: ${gapTargetTimes.join(', ')}. Starting backfill...`);
        // sse status update omitted for fast backfill

        const backfillPromises = gapTargetTimes.map((time, idx) => {
            return new Promise((resolveBackfill, rejectBackfill) => {
                const ffmpegArgs = [
                    '-loglevel', 'quiet',
                    '-ss', time.toFixed(3), // Fast Seeking
                    '-i', tempVideoFilename,
                    '-vf', "scale=640:-1",
                    '-vframes', '1',
                    '-q:v', '5',
                    `frame_backfill_${idx}_%04d.jpg`
                ];

                const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { cwd: baseTempDir });
                ffmpegProcess.on('error', (err) => rejectBackfill(err));
                ffmpegProcess.on('close', (code) => {
                    if (code === 0) resolveBackfill({ time, idx });
                    else rejectBackfill(new Error(`Backfill failed for ${time}s`));
                });
            });
        });

        await Promise.all(backfillPromises);
    }

    // Step 4: Re-index unified frames sequentially to frame-%04d.jpg & prepare return timestamps
    const files = fs.readdirSync(baseTempDir);
    const rawFiles = files.filter(f => f.startsWith('frame_raw_') && f.endsWith('.jpg')).sort();
    const backfillFiles = files.filter(f => f.startsWith('frame_backfill_') && f.endsWith('.jpg')).sort();

    // Map time to file paths for unified sorting
    const unifiedList = [];
    rawFiles.forEach((file, idx) => {
        const t = rawTimestamps[idx] !== undefined ? rawTimestamps[idx] : idx * 2.0;
        unifiedList.push({ file, time: t });
    });

    backfillFiles.forEach(file => {
        const match = file.match(/frame_backfill_(\d+)_/);
        if (match) {
            const idx = parseInt(match[1], 10);
            const t = gapTargetTimes[idx];
            if (t !== undefined) {
                unifiedList.push({ file, time: t });
            }
        }
    });

    // Chronological sorting
    unifiedList.sort((a, b) => a.time - b.time);

    const finalTimestamps = [];
    unifiedList.forEach((item, index) => {
        const srcPath = path.join(baseTempDir, item.file);
        const dstFilename = `frame-${String(index + 1).padStart(4, '0')}.jpg`;
        const dstPath = path.join(baseTempDir, dstFilename);

        if (fs.existsSync(srcPath)) {
            fs.renameSync(srcPath, dstPath);
        }
        finalTimestamps.push(item.time);
    });

    // Clean up remaining temp files just in case
    const remainingTempFiles = fs.readdirSync(baseTempDir).filter(f => (f.startsWith('frame_raw_') || f.startsWith('frame_backfill_')) && f.endsWith('.jpg'));
    for (const file of remainingTempFiles) {
        try { fs.unlinkSync(path.join(baseTempDir, file)); } catch (e) {}
    }

    logger.info(`[${requestHash}] Hybrid extraction complete. Total frames unified: ${finalTimestamps.length}`);
    // sse status update omitted for high-speed extraction

    return finalTimestamps;
}

// Helper to parse ISO 8601 duration
const parseISO8601Duration = (duration) => {
    const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
    if (!match) return 0;
    const hours = (parseInt(match[1], 10) || 0);
    const minutes = (parseInt(match[2], 10) || 0);
    const seconds = (parseInt(match[3], 10) || 0);
    return hours * 3600 + minutes * 60 + seconds;
};

const processVideo = async (videoId, youtubeUrl, sseHandler = null, userId = null) => {
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
    let cookiePath = null;

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

        cookiePath = getRandomCookiePath();
        const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];
        const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

        // 1. Use Official YouTube API for Metadata (Fast & Safe)
        const videoResponse = await youtube.videos.list({
            part: 'snippet,contentDetails,status',
            id: videoId
        });

        if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
            const reason = 'Invalid or missing YouTube URL';
            db.updateVideoStatus(videoId, 'failed', reason);
            throw new Error(reason);
        }

        const videoItem = videoResponse.data.items[0];
        
        if (videoItem.status && videoItem.status.embeddable === false) {
            const reason = 'embed_disabled';
            db.updateVideoStatus(videoId, 'failed', reason);
            throw new Error('This video cannot be embedded and played on external sites.');
        }

        const videoTitle = videoItem.snippet.title;
        const durationIso = videoItem.contentDetails.duration;
        const totalDuration = parseISO8601Duration(durationIso);
        let filesize = 0; // API doesn't provide filesize, will be updated after download if possible
        const autoSubtitleInfo = null; // Will be checked during download

        if (videoItem.snippet.liveBroadcastContent === 'live') {
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

        // 시각장애인 미인증 회원에 대한 5분(300초) 제한 검사
        let isBlindUser = false;
        if (userId) {
            const user = db.getUserById(userId);
            if (user && user.is_blind === 1) {
                isBlindUser = true;
            }
        }

        if (userId && !isBlindUser && totalDuration > 300) {
            const reason = `unverified_user_duration_exceeded`;
            db.updateVideoStatus(videoId, 'failed', reason);
            throw new Error('unverified_user_duration_exceeded');
        }

        db.ensureVideoRecord({ videoId, title: videoTitle, duration: Math.round(totalDuration), filesize, requested_by: userId });
        
        let subtitleContent = '';
        // Filename logic remains same, but we check existence later
        const subtitleFilename = `${videoId}.ko.vtt`; 
        const subtitlePath = path.join(baseTempDir, subtitleFilename);
        
        if (sseHandler) sseHandler('status_update', { message: '영상 다운로드 중...' });

        // YT-DLP Call: Download video using default downloader
        const tempVideoFilename = `${videoId}.mp4`;
        const tempVideoPath = path.join(baseTempDir, tempVideoFilename);

        let downloadSuccess = false;
        let downloadAttempt = 1;
        let currentCookiePath = getRandomCookiePath();
        const usedCookiePaths = []; // Track already attempted cookies to avoid duplicates

        while (!downloadSuccess && downloadAttempt <= 2) {
            const isRetry = downloadAttempt === 2;
            
            if (isRetry) {
                logger.info(`[${requestHash}] Attempt 2: Cleaning up and retrying download...`);
                if (sseHandler) sseHandler('status_update', { message: '대체 자격증명으로 우회 재시도 중...' });
                
                // Clean up any partial files from attempt 1 to ensure a fresh session
                try {
                    const files = await fs.promises.readdir(baseTempDir);
                    for (const file of files) {
                        await fs.promises.unlink(path.join(baseTempDir, file));
                    }
                } catch (cleanupErr) {
                    logger.warn(`[${requestHash}] Minor error during retry cleanup: ${cleanupErr.message}`);
                }

                // Record the failed cookie
                if (currentCookiePath) {
                    usedCookiePaths.push(currentCookiePath);
                }

                // Select a new valid cookie excluding already attempted ones
                const cookiesDir = path.join(__dirname, 'cookies');
                let nextCookiePath = null;
                if (fs.existsSync(cookiesDir)) {
                    const cookieFiles = fs.readdirSync(cookiesDir)
                        .filter(file => file.endsWith('_cookies.txt') && fs.statSync(path.join(cookiesDir, file)).size > 0)
                        .map(file => path.join(cookiesDir, file))
                        .filter(p => !usedCookiePaths.includes(p));
                    
                    if (cookieFiles.length > 0) {
                        nextCookiePath = cookieFiles[Math.floor(Math.random() * cookieFiles.length)];
                        logger.info(`[${requestHash}] Attempt 2: Selecting alternative cookie: ${path.basename(nextCookiePath)}`);
                    } else {
                        logger.warn(`[${requestHash}] Attempt 2: No alternative cookies available. Retrying without cookies.`);
                    }
                }
                currentCookiePath = nextCookiePath;
            }

            const activeCookiePath = currentCookiePath;
            const cookieArgs = activeCookiePath ? ['--cookies', activeCookiePath] : [];
            
            try {
                await new Promise((resolve, reject) => {
                    const ytdlpArgs = [
                        '-f', 'bestvideo[height<=360][acodec=none][ext=mp4]/bestvideo[height<=360][acodec=none]/bestvideo[height<=360]/best[height<=360]',
                        '-o', tempVideoFilename,
                        '--force-ipv4',
                        '--legacy-server-connect',
                        '--no-check-certificate',
                        '--plugin-dirs', path.join(__dirname, 'yt_dlp_plugins'),
                        '--remote-components', 'ejs:github',
                        ...impersonateArgs,
                        '--newline', 
                        '--write-auto-sub',
                        '--write-sub',
                        '--sub-lang', 'ko,en',
                        ...cookieArgs,
                        ...proxyArgs,
                        youtubeUrl
                    ];

                    const ytdlpPath = 'yt-dlp';
                    logger.info(`[${requestHash}] Executing YT-DLP: ${ytdlpPath} ${ytdlpArgs.join(' ')}`);
                    const downloadProcess = spawn(ytdlpPath, ytdlpArgs, { cwd: baseTempDir });
                    let lastProgress = -1;
                    let stdoutBuffer = '';
                    let stderrData = '';

                    downloadProcess.stdout.on('data', (data) => {
                        const dataStr = data.toString();
                        stdoutBuffer += dataStr;
                        
                        // Monitor for POT Provider challenge solving
                        if (dataStr.includes('bgutil') || dataStr.includes('PO Token') || dataStr.includes('Generating a')) {
                            logger.info(`[${requestHash}] YT-DLP POT provider: ${dataStr.trim()}`);
                        }

                        let match;
                        while ((match = stdoutBuffer.match(/[\r\n]/))) {
                            const lineEndIndex = match.index;
                            const line = stdoutBuffer.substring(0, lineEndIndex);
                            if (stdoutBuffer[lineEndIndex] === '\r' && stdoutBuffer[lineEndIndex + 1] === '\n') {
                                stdoutBuffer = stdoutBuffer.substring(lineEndIndex + 2);
                            } else {
                                stdoutBuffer = stdoutBuffer.substring(lineEndIndex + 1);
                            }

                            if (line.includes('[download]') && line.includes('%')) {
                                const match = line.match(/(\d+\.?\d*)%/);
                                if (match) {
                                    const progress = parseFloat(match[1]);
                                    if (!isNaN(progress)) {
                                        if (progress < lastProgress && progress < 5) lastProgress = -1;
                                        if (Math.floor(progress) > lastProgress || progress === 100) {
                                            lastProgress = Math.floor(progress);
                                            if (sseHandler) sseHandler('status_update', { message: `${Math.round(progress)}%` });
                                        }
                                    }
                                }
                            }
                        }
                    });

                    downloadProcess.stderr.on('data', (data) => {
                        const dataStr = data.toString();
                        stderrData += dataStr;
                        if (dataStr.includes('bgutil') || dataStr.includes('PO Token') || dataStr.includes('Generating a')) {
                            logger.info(`[${requestHash}] YT-DLP POT provider: ${dataStr.trim()}`);
                        }
                    });

                    downloadProcess.on('close', (code) => {
                        if (code === 0) resolve();
                        else {
                            const stderrLower = stderrData.toLowerCase();
                            const isBotError = stderrLower.includes('confirm you’re not a bot') || 
                                               stderrLower.includes('cookies are no longer valid') || 
                                               stderrLower.includes('http error 403') ||
                                               stderrLower.includes('login required') ||
                                               stderrLower.includes('sign in to confirm');
                            if (downloadAttempt === 1 && isBotError && activeCookiePath) {
                                const invalidPath = activeCookiePath + '.invalid';
                                logger.warn(`[${requestHash}] Bot detected with cookie ${path.basename(activeCookiePath)}. Invalidating and retrying with alternative cookie...`);
                                try { fs.renameSync(activeCookiePath, invalidPath); } catch (e) {}
                                reject({ type: 'bot_detected', message: stderrData });
                            } else {
                                reject(new Error(`yt-dlp download failed with code ${code}. Stderr: ${stderrData}`));
                            }
                        }
                    });

                    downloadProcess.on('error', (err) => reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)));
                });
                downloadSuccess = true;
            } catch (err) {
                if (err.type === 'bot_detected' && downloadAttempt === 1) {
                    downloadAttempt++;
                    continue;
                }
                throw err;
            }
        }

        // Update filesize after download
        if (fs.existsSync(tempVideoPath)) {
            filesize = fs.statSync(tempVideoPath).size;
            logger.info(`[${requestHash}] Downloaded video size: ${(filesize / 1024 / 1024).toFixed(2)} MB`);
        }

        // sse status update omitted for high-speed extraction

        // FFmpeg: Process the downloaded local file using hybrid extraction
        const allTimestamps = await extractKeyframesHybrid({
            tempVideoPath,
            tempVideoFilename,
            baseTempDir,
            totalDuration,
            requestHash,
            sseHandler
        });
        
        // Load subtitle: Prioritize Korean, fallback to English
        let finalSubtitlePath = null;
        const potentialSubtitles = fs.readdirSync(baseTempDir).filter(f => f.endsWith('.vtt'));
        
        const koSub = potentialSubtitles.find(f => f.includes('.ko.'));
        if (koSub) {
            finalSubtitlePath = path.join(baseTempDir, koSub);
            logger.info(`[${requestHash}] Found Korean subtitles: ${koSub}`);
        } else {
            // Support en, en-US, en-en, etc.
            const enSub = potentialSubtitles.find(f => f.includes('.en.') || f.includes('.en-'));
            if (enSub) {
                finalSubtitlePath = path.join(baseTempDir, enSub);
                logger.info(`[${requestHash}] Korean subtitles not found. Using English fallback: ${enSub}`);
            }
        }

        if (finalSubtitlePath && fs.existsSync(finalSubtitlePath)) {
            subtitleContent = preprocessVtt(fs.readFileSync(finalSubtitlePath, 'utf-8'));
            logger.info(`[${requestHash}] Successfully loaded and preprocessed subtitles.`);
        } else {
            logger.warn(`[${requestHash}] No suitable subtitle file found (tried ko, en). Proceeding without subtitles.`);
        }

        timeEnd(extractionLabel);
        logger.info(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, Total Frames: ${allTimestamps.length}`);
        
        if (sseHandler) sseHandler('start', { videoId, title: videoTitle });

        logger.info(`[${requestHash}] Step 2: Starting AI generation...`);
        const aiLabel = `[${requestHash}] Full AI Process Time`;
        time(aiLabel);

        if (sseHandler) sseHandler('status_update', { message: 'AI로 전체 대본 생성 중...' });

        const allFrameFiles = (await fs.promises.readdir(baseTempDir)).filter(f => f.endsWith('.jpg')).sort();
        const imageParts = [];

        for (let i = 0; i < allTimestamps.length; i++) {
            const timestamp = allTimestamps[i];
            const frameFile = allFrameFiles[i];
            if (frameFile && fs.existsSync(path.join(baseTempDir, frameFile))) {
                imageParts.push({ inlineData: { data: Buffer.from(await fs.promises.readFile(path.join(baseTempDir, frameFile))).toString("base64"), mimeType: 'image/jpeg' } });
                imageParts.push({ text: `Timestamp: [${Math.round(timestamp)}]` });
            }
        }

        if (imageParts.length === 0) {
            logger.warn(`[${requestHash}] No frames to process. Marking as complete with empty script.`);
            db.updateVideoStatus(videoId, 'completed');
            if (sseHandler) sseHandler('end', { message: 'Processing complete, no frames found.' });
            return;
        }

        const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: { temperature: 0.7, mediaResolution: "MEDIA_RESOLUTION_LOW" } });
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
                        // More flexible regex to handle AI's numeric-ish timestamps like [7...]
                        const match = line.match(/^\s*\[(\d+)[^\]]*\]\s*\[(v\d|txt)\]\s*(.*)\s*$/);
                        if (!match) return null;
                        let timestamp = parseInt(match[1], 10);
                        if (timestamp === 0) timestamp = 1;
                        if (timestamp > totalDuration + 2) return null;
                        timestamp = Math.min(timestamp, Math.floor(totalDuration));
                        return { id: crypto.createHash('sha256').update(line).digest('hex'), timestamp, text: match[3].trim(), verbosity: match[2] === 'txt' ? 'text' : match[2] };
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
                // More flexible regex to handle AI's numeric-ish timestamps like [7...]
                const match = line.match(/^\s*\[(\d+)[^\]]*\]\s*\[(v\d|txt)\]\s*(.*)\s*$/);
                if (!match) return null;
                let timestamp = parseInt(match[1], 10);
                if (timestamp === 0) timestamp = 1;
                if (timestamp > totalDuration + 2) return null;
                timestamp = Math.min(timestamp, Math.floor(totalDuration));
                return { id: crypto.createHash('sha256').update(line).digest('hex'), timestamp, text: match[3].trim(), verbosity: match[2] === 'txt' ? 'text' : match[2] };
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
            const cost = calculateApiCost(MODEL_NAME, promptTokenCount, candidatesTokenCount, totalTokenCount);
            db.addApiCost({ videoId, model_used: MODEL_NAME, image_tokens: promptTokenCount, text_tokens: candidatesTokenCount, cost });
            logger.info(`[${requestHash}] Logged API cost: ${cost.toFixed(6)} USD`);
        }

        db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), filesize, script: fullScript });
        timeEnd(aiLabel);
        if (sseHandler) sseHandler('end', { message: 'Processing complete.' });
        
    } catch (error) {
        const errorMessage = error.message || 'Unknown error';
        db.updateVideoStatus(videoId, 'failed', errorMessage);
        logger.error(new Error(`[${requestHash}] Error processing request: ${errorMessage}`));
        
        if (sseHandler) {
            let errorPayload;
            const lowerErrorMessage = errorMessage.toLowerCase();

            if (lowerErrorMessage.includes('unverified_user_duration_exceeded')) {
                errorPayload = {
                    message: 'unverified_user_duration_exceeded',
                    details: '시각장애인 인증을 완료하지 않은 회원은 5분 이하의 영상만 해설을 생성할 수 있습니다.'
                };
            } else if (lowerErrorMessage.includes('exceeds the limit')) {
                const limitMatch = errorMessage.match(/limit of (\d+)/);
                errorPayload = {
                    message: 'duration_exceeded',
                    details: errorMessage,
                    limit: limitMatch ? parseInt(limitMatch[1], 10) : 30
                };
            } else if (lowerErrorMessage.includes('live streams')) {
                errorPayload = {
                    message: 'live_stream_not_supported',
                    details: 'Live streams cannot be processed.'
                };
            } else if (lowerErrorMessage.includes('embedded')) {
                errorPayload = {
                    message: 'embed_disabled',
                    details: 'This video cannot be embedded.'
                };
            } else if (lowerErrorMessage.includes('blocked') || lowerErrorMessage.includes('prohibited_content')) {
                errorPayload = {
                    message: 'gemini_rejection',
                    details: 'The content was blocked by the generative AI.',
                };
            } else if (lowerErrorMessage.includes('overloaded') || lowerErrorMessage.includes('unavailable') || lowerErrorMessage.includes('429') || lowerErrorMessage.includes('quota') || lowerErrorMessage.includes('exhausted')) {
                errorPayload = {
                    message: 'gemini_unavailable',
                    details: 'The generative AI service is temporarily unavailable or experiencing issues.',
                };
            } else {
                errorPayload = {
                    message: 'video_processing_failed',
                    details: errorMessage
                };
            }
            sseHandler('backend_error', errorPayload);
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
    let cookiePath = null;

    try {
        const cachedData = db.getVideo(videoId);
        if (cachedData && cachedData.status === 'completed') {
            logger.info(`[${requestHash}] Cache hit for videoId: ${videoId}. Batch processing not needed.`);
            return;
        }

        await fs.promises.mkdir(baseTempDir, { recursive: true });

        const tempVideoFilename = `${videoId}.mp4`;
        const tempVideoPath = path.join(baseTempDir, tempVideoFilename);
        let filesize = 0;
        const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

        logger.info(`[${requestHash}] Step 1: Starting initial data extraction...`);
        const extractionLabel = `[${requestHash}] Initial Data Extraction Time`;
        time(extractionLabel);

        let downloadSuccess = false;
        let downloadAttempt = 1;
        let currentCookiePath = getRandomCookiePath();
        const usedCookiePaths = []; // Track already attempted cookies to avoid duplicates

        while (!downloadSuccess && downloadAttempt <= 2) {
            const isRetry = downloadAttempt === 2;
            
            if (isRetry) {
                logger.info(`[${requestHash}] Attempt 2: Cleaning up and retrying batch download...`);

                // Clean up any partial files from attempt 1 to ensure a fresh session
                try {
                    const files = await fs.promises.readdir(baseTempDir);
                    for (const file of files) {
                        await fs.promises.unlink(path.join(baseTempDir, file));
                    }
                } catch (cleanupErr) {
                    logger.warn(`[${requestHash}] Minor error during batch retry cleanup: ${cleanupErr.message}`);
                }

                // Record the failed cookie
                if (currentCookiePath) {
                    usedCookiePaths.push(currentCookiePath);
                }

                // Select a new valid cookie excluding already attempted ones
                const cookiesDir = path.join(__dirname, 'cookies');
                let nextCookiePath = null;
                if (fs.existsSync(cookiesDir)) {
                    const cookieFiles = fs.readdirSync(cookiesDir)
                        .filter(file => file.endsWith('_cookies.txt') && fs.statSync(path.join(cookiesDir, file)).size > 0)
                        .map(file => path.join(cookiesDir, file))
                        .filter(p => !usedCookiePaths.includes(p));
                    
                    if (cookieFiles.length > 0) {
                        nextCookiePath = cookieFiles[Math.floor(Math.random() * cookieFiles.length)];
                        logger.info(`[${requestHash}] Attempt 2: Selecting alternative cookie (batch): ${path.basename(nextCookiePath)}`);
                    } else {
                        logger.warn(`[${requestHash}] Attempt 2: No alternative cookies available. Retrying without cookies.`);
                    }
                }
                currentCookiePath = nextCookiePath;
            }

            const activeCookiePath = currentCookiePath;
            const cookieArgs = activeCookiePath ? ['--cookies', activeCookiePath] : [];

            try {
                await new Promise((resolve, reject) => {
                    const ytdlpArgs = [
                        '-f', 'bestvideo[height<=360][acodec=none][ext=mp4]/bestvideo[height<=360][acodec=none]/bestvideo[height<=360]/best[height<=360]',
                        '-o', tempVideoFilename,
                        '--force-ipv4',
                        '--legacy-server-connect',
                        '--no-check-certificate',
                        '--plugin-dirs', path.join(__dirname, 'yt_dlp_plugins'),
                        '--remote-components', 'ejs:github',
                        ...impersonateArgs,
                        '--no-progress',
                        '--write-auto-sub',
                        '--write-auto-sub',
                        '--write-sub',
                        '--sub-lang', 'ko,en',
                        ...cookieArgs,
                        ...proxyArgs,
                        youtubeUrl
                    ];

                    const ytdlpPath = 'yt-dlp';
                    logger.info(`[${requestHash}] Executing YT-DLP: ${ytdlpPath} ${ytdlpArgs.join(' ')}`);
                    const downloadProcess = spawn(ytdlpPath, ytdlpArgs, { cwd: baseTempDir });
                    let stderrData = '';

                    downloadProcess.stdout.on('data', (data) => {
                        const dataStr = data.toString();
                        if (dataStr.includes('bgutil') || dataStr.includes('PO Token') || dataStr.includes('Generating a')) {
                            logger.info(`[${requestHash}] YT-DLP POT provider (batch): ${dataStr.trim()}`);
                        }
                    });

                    downloadProcess.stderr.on('data', (data) => {
                        const dataStr = data.toString();
                        stderrData += dataStr;
                        if (dataStr.includes('bgutil') || dataStr.includes('PO Token') || dataStr.includes('Generating a')) {
                            logger.info(`[${requestHash}] YT-DLP POT provider (batch): ${dataStr.trim()}`);
                        }
                    });

                    downloadProcess.on('close', (code) => {
                        if (code === 0) resolve();
                        else {
                            const isBotError = stderrData.includes('confirm you’re not a bot') || 
                                               stderrData.includes('cookies are no longer valid') || 
                                               stderrData.includes('HTTP Error 403');
                            if (downloadAttempt === 1 && isBotError && activeCookiePath) {
                                const invalidPath = activeCookiePath + '.invalid';
                                logger.warn(`[${requestHash}] Bot detected in batch with cookie ${path.basename(activeCookiePath)}. Invalidating and retrying with alternative cookie...`);
                                try { fs.renameSync(activeCookiePath, invalidPath); } catch (e) {}
                                reject({ type: 'bot_detected', message: stderrData });
                            } else {
                                reject(new Error(`yt-dlp batch download failed with code ${code}. Stderr: ${stderrData}`));
                            }
                        }
                    });

                    downloadProcess.on('error', (err) => reject(new Error(`Failed to spawn yt-dlp in batch: ${err.message}`)));
                });
                downloadSuccess = true;
            } catch (err) {
                if (err.type === 'bot_detected' && downloadAttempt === 1) {
                    downloadAttempt++;
                    continue;
                }
                throw err;
            }
        }

        // Update filesize after download
        if (fs.existsSync(tempVideoPath)) {
            filesize = fs.statSync(tempVideoPath).size;
            logger.info(`[${requestHash}] Downloaded video size: ${(filesize / 1024 / 1024).toFixed(2)} MB`);
        }

        // FFmpeg: Process the downloaded local file using hybrid extraction
        const allTimestamps = await extractKeyframesHybrid({
            tempVideoPath,
            tempVideoFilename,
            baseTempDir,
            totalDuration,
            requestHash,
            sseHandler: null
        });

        // Load subtitle for batch: Prioritize Korean, fallback to English
        let finalSubtitlePath = null;
        const potentialSubtitles = fs.readdirSync(baseTempDir).filter(f => f.endsWith('.vtt'));
        
        const koSub = potentialSubtitles.find(f => f.includes('.ko.'));
        if (koSub) {
            finalSubtitlePath = path.join(baseTempDir, koSub);
            logger.info(`[${requestHash}] Found Korean subtitles (batch): ${koSub}`);
        } else {
            // Support en, en-US, en-en, etc.
            const enSub = potentialSubtitles.find(f => f.includes('.en.') || f.includes('.en-'));
            if (enSub) {
                finalSubtitlePath = path.join(baseTempDir, enSub);
                logger.info(`[${requestHash}] Korean subtitles not found in batch. Using English fallback: ${enSub}`);
            }
        }

        if (finalSubtitlePath && fs.existsSync(finalSubtitlePath)) {
            subtitleContent = preprocessVtt(fs.readFileSync(finalSubtitlePath, 'utf-8'));
            logger.info(`[${requestHash}] Successfully loaded subtitles for batch.`);
        } else {
            logger.warn(`[${requestHash}] No suitable subtitle file found for batch (tried ko, en).`);
        }

        timeEnd(extractionLabel);
        logger.info(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, Total Frames: ${allTimestamps.length}`);

        logger.info(`[${requestHash}] Step 2: Starting AI generation...`);
        const aiLabel = `[${requestHash}] Full AI Process Time`;
        time(aiLabel);

        const allFrameFiles = (await fs.promises.readdir(baseTempDir)).filter(f => f.endsWith('.jpg')).sort();
        const imageParts = [];

        for (let i = 0; i < allTimestamps.length; i++) {
            const timestamp = allTimestamps[i];
            const frameFile = allFrameFiles[i];
            if (frameFile && fs.existsSync(path.join(baseTempDir, frameFile))) {
                imageParts.push({ inlineData: { data: Buffer.from(await fs.promises.readFile(path.join(baseTempDir, frameFile))).toString("base64"), mimeType: 'image/jpeg' } });
                imageParts.push({ text: `Timestamp: [${Math.round(timestamp)}]` });
            }
        }

        if (imageParts.length === 0) {
            logger.warn(`[${requestHash}] No frames to process. Marking as complete with empty script.`);
            db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), script: [] });
            return;
        }

        const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: { temperature: 0.7, mediaResolution: "MEDIA_RESOLUTION_LOW" } });
        const promptTemplatePath = path.join(__dirname, 'prompt_template.txt');
        let prompt = fs.readFileSync(promptTemplatePath, 'utf-8');
        prompt = prompt.replace('{{VIDEO_TITLE}}', videoTitle).replace('{{SUBTITLES}}', subtitleContent);

        const result = await model.generateContent([prompt, ...imageParts]);

        const usageMetadata = result.response.usageMetadata;
        if (usageMetadata) {
            const { promptTokenCount, candidatesTokenCount, totalTokenCount } = usageMetadata;
            const cost = calculateApiCost(MODEL_NAME, promptTokenCount, candidatesTokenCount, totalTokenCount);
            db.addApiCost({ videoId, model_used: MODEL_NAME, image_tokens: promptTokenCount, text_tokens: candidatesTokenCount, cost });
            logger.info(`[${requestHash}] Logged API cost for batch: ${cost.toFixed(6)} USD`);
        }
        
        if (result.response.promptFeedback && result.response.promptFeedback.blockReason) {
            throw new Error(`The AI prompt was blocked due to prohibited content: ${result.response.promptFeedback.blockReason}`);
        }

        const scriptText = result.response.text();
        const scriptLines = scriptText.split('\n');

        const finalScriptData = scriptLines.map((line) => {
            // More flexible regex to handle AI's numeric-ish timestamps like [7...]
            const match = line.match(/^\s*\[(\d+)[^\]]*\]\s*\[(v\d|txt)\]\s*(.*)\s*$/);
            if (!match) return null;
            let timestamp = parseInt(match[1], 10);
            if (timestamp === 0) timestamp = 1;
            
            // Safety check: ignore timestamps that exceed total video duration significantly
            if (timestamp > totalDuration + 2) {
                logger.warn(`[${requestHash}] Ignoring out-of-bounds timestamp: ${timestamp} (Max: ${totalDuration})`);
                return null;
            }
            timestamp = Math.min(timestamp, Math.floor(totalDuration));
            
            return { id: crypto.createHash('sha256').update(line).digest('hex'), timestamp, text: match[3].trim(), verbosity: match[2] === 'txt' ? 'text' : match[2] };
        }).filter(Boolean);

        finalScriptData.sort((a, b) => a.timestamp - b.timestamp);
        db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), filesize, script: finalScriptData });

        timeEnd(aiLabel);
        logger.info(`[${requestHash}] Successfully generated and cached script text for batch processing.`);
        
    } catch (error) {
        db.updateVideoStatus(videoId, 'failed', error.message);
        logger.error(new Error(`[${requestHash}] Error in batch processing: ${error.message}`));
        
        // Invalidate cookie on auth error
        if (cookiePath && (error.message.includes('Sign in to confirm') || error.message.includes('cookies are no longer valid'))) {
            const invalidPath = cookiePath + '.invalid';
            logger.warn(`[${requestHash}] Authentication error detected. Renaming cookie file to ${path.basename(invalidPath)}`);
            try {
                fs.renameSync(cookiePath, invalidPath);
            } catch (renameError) {
                logger.error(`[${requestHash}] Failed to rename invalid cookie file:`, renameError);
            }
        }
    } finally {
        if (fs.existsSync(baseTempDir)) {
            await fs.promises.rm(baseTempDir, { recursive: true, force: true });
        }
        timeEnd(totalTimeLabel);
    }
};

module.exports = { processVideo, processVideoBatch, extractKeyframesHybrid };