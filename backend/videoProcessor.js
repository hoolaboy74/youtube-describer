const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require("googleapis");
const fs = require('fs');
const path = require('path');
const util = require('util');
const os = require('os');
const { execFile, spawn, execSync } = require('child_process');
const db = require('./database');
const { formatTime, preprocessVtt, isValidYoutubeUrl } = require('./utils');
const logger = require('./logger');
const audioLanguageDetector = require('./modules/audioLanguageDetector');
const { loadPolicyPrompt, POLICY_VERSION } = require('./modules/promptPolicy');
const {
    parseLegacyLine,
    validateEvents,
    toLegacyScriptEvent,
    findDialogueInterval
} = require('./modules/canonicalOutput');

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
    const promptTokens = promptTokenCount || 0;
    const candidatesTokens = candidatesTokenCount || 0;
    const totalTokens = totalTokenCount || (promptTokens + candidatesTokens);
    
    const modelLower = modelName ? modelName.toLowerCase() : "";
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

    const inputCost = (promptTokens / 1000000) * (totalTokens <= 200000 ? inputRate : inputRateOverLimit);
    const outputCost = (candidatesTokens / 1000000) * (totalTokens <= 200000 ? outputRate : outputRateOverLimit);
    const totalCost = inputCost + outputCost;
    return isNaN(totalCost) ? 0 : totalCost;
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
        logger.info(`[${requestHash}] Found ${gapTargetTimes.length} missing frame slots. Starting backfill (concurrency limit: 3)...`);
        
        const chunkLimit = 3;
        for (let i = 0; i < gapTargetTimes.length; i += chunkLimit) {
            const chunk = gapTargetTimes.slice(i, i + chunkLimit);
            const chunkPromises = chunk.map((time, idx) => {
                const globalIdx = i + idx;
                return new Promise((resolveBackfill) => {
                    const ffmpegArgs = [
                        '-loglevel', 'quiet',
                        '-ss', time.toFixed(3), // Fast Seeking
                        '-i', tempVideoFilename,
                        '-vf', "scale=640:-1",
                        '-vframes', '1',
                        '-q:v', '5',
                        `frame_backfill_${globalIdx}_%04d.jpg`
                    ];

                    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { cwd: baseTempDir });
                    ffmpegProcess.on('error', (err) => {
                        logger.warn(`[${requestHash}] Backfill spawn error for ${time}s (ignored): ${err.message}`);
                        resolveBackfill(null);
                    });
                    ffmpegProcess.on('close', (code) => {
                        if (code === 0) {
                            resolveBackfill({ time, idx: globalIdx });
                        } else {
                            logger.warn(`[${requestHash}] Backfill failed for ${time}s (ignored) with code ${code}`);
                            resolveBackfill(null);
                        }
                    });
                });
            });
            await Promise.all(chunkPromises);
        }
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

function nearestFrameEvidence(timestamp, context) {
    const frames = Array.isArray(context.frameEvidence)
        ? context.frameEvidence
        : (Array.isArray(context.frames) ? context.frames : []);
    if (frames.length === 0) return [];
    const usable = frames.filter(frame => frame && Number.isFinite(Number(frame.timestamp)));
    if (usable.length === 0) return [];
    const nearest = usable.reduce((best, frame) => (
        Math.abs(Number(frame.timestamp) - Number(timestamp)) < Math.abs(Number(best.timestamp) - Number(timestamp))
            ? frame
            : best
    ));
    return [{
        id: String(nearest.id || nearest.frameId || `frame-${Math.round(nearest.timestamp)}`),
        timestamp: Number(nearest.timestamp),
        ...(nearest.visibleText ? { visibleText: nearest.visibleText } : {})
    }];
}

function provenanceForModelCandidate(candidate, context) {
    const timestamp = Number(candidate.timestamp);
    const frameEvidence = nearestFrameEvidence(timestamp, context);
    if (candidate.tag === 'v1' || candidate.tag === 'v2' || candidate.tag === 'v3') {
        return { kind: 'visual', frameEvidence };
    }
    if (candidate.tag === 'txt') {
        const screenText = Array.isArray(context.screenTextEvidence)
            ? context.screenTextEvidence.find(item => Number(item.timestamp) === timestamp)
            : null;
        return {
            kind: 'screen_text',
            frameEvidence,
            ...(screenText && screenText.text ? { visibleTextEvidence: screenText.text } : {})
        };
    }
    if (candidate.tag === 'trans') {
        const dialogueTrack = Array.isArray(context.dialogueTrack) ? context.dialogueTrack : [];
        const interval = findDialogueInterval(
            timestamp,
            dialogueTrack,
            context.dialogueTimestampTolerance
        );
        if (!interval) return null;
        const audioLanguage = String(context.audioLanguage || context.audioClassification || 'unknown').toLowerCase();
        return {
            kind: 'foreign_dialogue',
            dialogueInterval: {
                ...interval,
                start: Number(interval.start),
                end: Number(interval.end),
                confirmed: interval.confirmed !== false,
                foreign: interval.foreign === true || ['foreign', 'mixed'].includes(audioLanguage)
            }
        };
    }
    return null;
}

function canonicalizeModelOutput(rawText, context = {}) {
    const lines = String(rawText || '').split(/\r?\n/);
    const candidates = lines.map(rawLine => {
        const parsed = parseLegacyLine(rawLine, {
            duration: context.duration,
            audioLanguage: context.audioLanguage,
            audioClassification: context.audioClassification,
            dialogueTrack: context.dialogueTrack
        });
        return {
            timestamp: parsed.timestamp,
            text: parsed.text,
            tag: parsed.tag,
            provenance: provenanceForModelCandidate(parsed, context),
            audioLanguage: context.audioLanguage || context.audioClassification,
            rawLine: rawLine.slice(0, 1000)
        };
    });
    const validation = validateEvents(candidates, {
        ...context,
        policyVersion: POLICY_VERSION,
        duration: context.duration,
        audioLanguage: context.audioLanguage || context.audioClassification,
        dialogueTrack: context.dialogueTrack
    });
    validation.events.forEach((event, index) => {
        event.rawLine = candidates[index].rawLine;
    });
    return {
        ...validation,
        accepted: validation.accepted.slice().sort((a, b) => a.timestamp - b.timestamp),
        policyVersion: POLICY_VERSION
    };
}

function publishCanonicalOutput({ videoId, canonical: providedCanonical, rawText, context, sseHandler, requestHash, video }) {
    const canonical = providedCanonical || canonicalizeModelOutput(rawText, context);
    const diagnostics = [...canonical.quarantined, ...canonical.rejected];
    db.saveCanonicalScriptChunk({ videoId, events: canonical.accepted });
    if (diagnostics.length > 0) {
        db.saveQuarantinedScriptEvents({ videoId, candidates: diagnostics });
    }
    const legacyEvents = canonical.accepted.map(toLegacyScriptEvent);
    if (sseHandler && legacyEvents.length > 0) {
        sseHandler('script_chunk', legacyEvents);
    }
    if (canonical.accepted.length > 0) {
        if (video) {
            db.saveVideo({
                ...video,
                videoId,
                script: canonical.accepted,
                audioLanguage: video.audioLanguage || context.audioLanguage || context.audioClassification
            });
        }
        db.updateVideoStatus(videoId, 'completed');
    } else {
        db.updateVideoStatus(videoId, 'failed', 'canonical_output_unavailable');
        logger.warn(`[${requestHash}] No accepted canonical events; output remains unplayable.`);
    }
    return { ...canonical, legacyEvents };
}

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
                        '-f', 'best[height<=360][vcodec!=none][acodec!=none]/best[height<=360]',
                        '-o', tempVideoFilename,
                        '--force-ipv4',
                        '--legacy-server-connect',
                        '--no-check-certificate',
                        '--plugin-dirs', path.join(__dirname, 'yt_dlp_plugins'),
                        '--remote-components', 'ejs:github',
                        '--js-runtimes', 'node',
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
                        const hasVideo = fs.existsSync(tempVideoPath) && fs.statSync(tempVideoPath).size > 0;
                        if (code === 0 || (hasVideo && stderrData.includes('subtitle'))) {
                            resolve();
                        } else {
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

        // FFmpeg & Whisper: Process keyframe extraction and audio language detection in parallel
        logger.info(`[${requestHash}] Starting hybrid keyframe extraction and audio language detection in parallel...`);
        const [allTimestamps, audioLanguage] = await Promise.all([
            extractKeyframesHybrid({
                tempVideoPath,
                tempVideoFilename,
                baseTempDir,
                totalDuration,
                requestHash,
                sseHandler
            }),
            audioLanguageDetector.detectLanguage(tempVideoPath, totalDuration, requestHash)
        ]);
        
        // Load only a source-language dialogue track. For foreign/unknown audio,
        // a Korean VTT is commonly YouTube's translated caption track, not
        // evidence of Korean speech, so it must never win over the original VTT.
        const subtitleSelection = selectDialogueSubtitle(
            fs.readdirSync(baseTempDir).filter(f => f.endsWith('.vtt')),
            audioLanguage
        );
        let dialogueTrack = [];
        if (subtitleSelection) {
            dialogueTrack = parseVttToDialogueTrack(
                path.join(baseTempDir, subtitleSelection.file),
                subtitleSelection.sourceLanguage,
                subtitleSelection
            );
            logger.info(`[${requestHash}] ${subtitleSelection.logLabel}: ${subtitleSelection.file}`);
        } else {
            logger.info(`[${requestHash}] No usable original-language subtitles found for ${audioLanguage}; dialogue track is empty.`);
        }

        timeEnd(extractionLabel);
        logger.info(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, Total Frames: ${allTimestamps.length}, Dialogue Count: ${dialogueTrack.length}`);
        
        if (sseHandler) sseHandler('start', { videoId, title: videoTitle, audioLanguage });

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

        const policy = await loadPolicyPrompt({
            replacements: {
                VIDEO_TITLE: videoTitle,
                AUDIO_CLASSIFICATION: audioLanguage,
                AUDIO_LANGUAGE: audioLanguage,
                DIALOGUE_TRACK: JSON.stringify(dialogueTrack, null, 2)
            }
        });
        const prompt = policy.prompt;
        const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: { temperature: 0.7, mediaResolution: "MEDIA_RESOLUTION_LOW" } });

        const result = await model.generateContentStream([prompt, ...imageParts]);
        let rawModelText = '';
        for await (const chunk of result.stream) {
            if (chunk.text) {
                rawModelText += chunk.text();
            }
        }
        const canonical = canonicalizeModelOutput(rawModelText, {
            duration: Math.floor(totalDuration),
            audioLanguage,
            dialogueTrack,
            dialogueTimestampTolerance: 1,
            frameEvidence: allTimestamps.map(timestamp => ({ timestamp }))
        });
        const canonicalOutput = publishCanonicalOutput({
            videoId,
            canonical,
            sseHandler,
            requestHash,
            video: {
                title: videoTitle,
                duration: Math.round(totalDuration),
                filesize,
                audioLanguage
            }
        });
        
        const finalResponse = await result.response;
        const usageMetadata = finalResponse.usageMetadata;
        if (usageMetadata) {
            const promptTokenCount = usageMetadata.promptTokenCount || 0;
            const candidatesTokenCount = usageMetadata.candidatesTokenCount || 0;
            const totalTokenCount = usageMetadata.totalTokenCount || (promptTokenCount + candidatesTokenCount);
            const cost = calculateApiCost(MODEL_NAME, promptTokenCount, candidatesTokenCount, totalTokenCount);
            db.addApiCost({ videoId, model_used: MODEL_NAME, image_tokens: promptTokenCount, text_tokens: candidatesTokenCount, cost: isNaN(cost) ? 0 : cost });
            logger.info(`[${requestHash}] Logged API cost: ${(isNaN(cost) ? 0 : cost).toFixed(6)} USD`);
        }

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

        const videoResponse = await youtube.videos.list({
            part: 'snippet,contentDetails,status',
            id: videoId
        });

        if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
            throw new Error('Invalid or missing YouTube URL for batch');
        }

        const videoItem = videoResponse.data.items[0];
        const videoTitle = videoItem.snippet.title;
        const durationIso = videoItem.contentDetails.duration;
        const totalDuration = parseISO8601Duration(durationIso);

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
                        '-f', 'best[height<=360][vcodec!=none][acodec!=none]/best[height<=360]',
                        '-o', tempVideoFilename,
                        '--force-ipv4',
                        '--legacy-server-connect',
                        '--no-check-certificate',
                        '--plugin-dirs', path.join(__dirname, 'yt_dlp_plugins'),
                        '--remote-components', 'ejs:github',
                        '--js-runtimes', 'node',
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
                        const hasVideo = fs.existsSync(tempVideoPath) && fs.statSync(tempVideoPath).size > 0;
                        if (code === 0 || (hasVideo && stderrData.includes('subtitle'))) {
                            resolve();
                        } else {
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

        // FFmpeg & Whisper: Process keyframe extraction and audio language detection in parallel
        logger.info(`[${requestHash}] Starting hybrid keyframe extraction and audio language detection in parallel (batch)...`);
        const [allTimestamps, audioLanguage] = await Promise.all([
            extractKeyframesHybrid({
                tempVideoPath,
                tempVideoFilename,
                baseTempDir,
                totalDuration,
                requestHash,
                sseHandler: null
            }),
            audioLanguageDetector.detectLanguage(tempVideoPath, totalDuration, requestHash)
        ]);

        // Keep batch subtitle selection identical to the interactive path.
        const subtitleSelection = selectDialogueSubtitle(
            fs.readdirSync(baseTempDir).filter(f => f.endsWith('.vtt')),
            audioLanguage
        );
        let dialogueTrack = [];
        if (subtitleSelection) {
            dialogueTrack = parseVttToDialogueTrack(
                path.join(baseTempDir, subtitleSelection.file),
                subtitleSelection.sourceLanguage,
                subtitleSelection
            );
            logger.info(`[${requestHash}] ${subtitleSelection.logLabel} (batch): ${subtitleSelection.file}`);
        } else {
            logger.info(`[${requestHash}] No usable original-language subtitles found for ${audioLanguage} (batch); dialogue track is empty.`);
        }

        timeEnd(extractionLabel);
        logger.info(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, Total Frames: ${allTimestamps.length}, Dialogue Count: ${dialogueTrack.length}`);

        logger.info(`[${requestHash}] Step 2: Starting AI generation (batch)...`);
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
            db.saveVideo({ videoId, title: videoTitle, duration: Math.round(totalDuration), script: [], audioLanguage });
            return;
        }

        const policy = await loadPolicyPrompt({
            replacements: {
                VIDEO_TITLE: videoTitle,
                AUDIO_CLASSIFICATION: audioLanguage,
                AUDIO_LANGUAGE: audioLanguage,
                DIALOGUE_TRACK: JSON.stringify(dialogueTrack, null, 2)
            }
        });
        const prompt = policy.prompt;
        const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: { temperature: 0.7, mediaResolution: "MEDIA_RESOLUTION_LOW" } });

        const result = await model.generateContent([prompt, ...imageParts]);

        const usageMetadata = result.response.usageMetadata;
        if (usageMetadata) {
            const promptTokenCount = usageMetadata.promptTokenCount || 0;
            const candidatesTokenCount = usageMetadata.candidatesTokenCount || 0;
            const totalTokenCount = usageMetadata.totalTokenCount || (promptTokenCount + candidatesTokenCount);
            const cost = calculateApiCost(MODEL_NAME, promptTokenCount, candidatesTokenCount, totalTokenCount);
            db.addApiCost({ videoId, model_used: MODEL_NAME, image_tokens: promptTokenCount, text_tokens: candidatesTokenCount, cost: isNaN(cost) ? 0 : cost });
            logger.info(`[${requestHash}] Logged API cost for batch: ${(isNaN(cost) ? 0 : cost).toFixed(6)} USD`);
        }
        
        if (result.response.promptFeedback && result.response.promptFeedback.blockReason) {
            throw new Error(`The AI prompt was blocked due to prohibited content: ${result.response.promptFeedback.blockReason}`);
        }

        const scriptText = result.response.text();
        const canonical = canonicalizeModelOutput(scriptText, {
            duration: Math.floor(totalDuration),
            audioLanguage,
            dialogueTrack,
            dialogueTimestampTolerance: 1,
            frameEvidence: allTimestamps.map(timestamp => ({ timestamp }))
        });
        const canonicalOutput = publishCanonicalOutput({
            videoId,
            canonical,
            requestHash,
            video: {
                title: videoTitle,
                duration: Math.round(totalDuration),
                filesize,
                audioLanguage
            }
        });

        timeEnd(aiLabel);
        logger.info(`[${requestHash}] Successfully generated and cached ${canonicalOutput.accepted.length} canonical events for batch processing.`);
        
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

function parseVttToDialogueTrack(vttPath, sourceLang, options = {}) {
    if (!fs.existsSync(vttPath)) return [];
    const content = fs.readFileSync(vttPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const track = [];
    let currentItem = null;

    for (const line of lines) {
        if (line.includes('-->')) {
            if (currentItem && currentItem.sourceText) {
                track.push(currentItem);
            }
            const parts = line.split('-->');
            const start = parseTimestamp(parts[0].trim());
            const end = parseTimestamp(parts[1].trim().split(/\s+/, 1)[0]);
            currentItem = {
                start,
                end,
                sourceLanguage: sourceLang,
                sourceText: '',
                source: 'youtube_caption',
                confirmed: options.confirmed !== false,
                ...(options.foreign === true || sourceLang !== 'ko' ? { foreign: true } : {}),
                ...(options.sourceRole ? { sourceRole: options.sourceRole } : {})
            };
        } else if (currentItem && line.trim() && !line.startsWith('NOTE') && !line.startsWith('STYLE')) {
            const cleanText = line.replace(/<[^>]*>/g, '').trim();
            if (cleanText) {
                currentItem.sourceText = currentItem.sourceText ? currentItem.sourceText + ' ' + cleanText : cleanText;
            }
        }
    }
    if (currentItem && currentItem.sourceText) {
        track.push(currentItem);
    }
    return track;
}

function subtitleMatchesLanguage(filename, language) {
    const normalized = String(filename || '').toLowerCase();
    const languageCode = String(language || '').toLowerCase();
    return new RegExp(`\\.${languageCode}(?:[-_.]|\\.vtt$)`, 'i').test(normalized);
}

/**
 * Select the VTT that represents the audio source, not a translated display
 * track. yt-dlp can download both `en` and `ko`; for foreign/unknown audio,
 * choosing `ko.vtt` first turns YouTube's Korean translation into misleading
 * dialogue evidence and prevents safe [trans] provenance.
 */
function selectDialogueSubtitle(potentialSubtitles, audioLanguage) {
    const subtitles = Array.isArray(potentialSubtitles)
        ? potentialSubtitles.filter(file => typeof file === 'string' && file.toLowerCase().endsWith('.vtt'))
        : [];
    const find = language => subtitles.find(file => subtitleMatchesLanguage(file, language));
    const normalizedAudio = String(audioLanguage || 'unknown').toLowerCase();

    if (normalizedAudio === 'korean') {
        const file = find('ko') || find('en');
        return file ? {
            file,
            sourceLanguage: subtitleMatchesLanguage(file, 'ko') ? 'ko' : 'en',
            sourceRole: 'original_dialogue',
            logLabel: 'korean video: loaded source subtitles'
        } : null;
    }

    // English is the current supported foreign source language. A Korean VTT
    // is intentionally not a fallback here because it may be auto-translated.
    const file = find('en');
    return file ? {
        file,
        sourceLanguage: 'en',
        foreign: true,
        sourceRole: 'original_dialogue',
        logLabel: normalizedAudio === 'mixed'
            ? 'mixed video: loaded English source subtitles'
            : 'foreign/unknown video: loaded English source subtitles'
    } : null;
}

function parseTimestamp(timeStr) {
    const parts = timeStr.split(':');
    let secs = 0;
    if (parts.length === 3) {
        secs = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
        secs = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(secs.toFixed(2));
}

function getLevenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

function getSimilarity(a, b) {
    const dist = getLevenshteinDistance(a, b);
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    return 1.0 - (dist / maxLen);
}

module.exports = {
    processVideo,
    processVideoBatch,
    extractKeyframesHybrid,
    parseVttToDialogueTrack,
    selectDialogueSubtitle,
    getSimilarity,
    canonicalizeModelOutput,
    publishCanonicalOutput
};
