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
const db = require('./database');
const { formatTime, invertSpeechTimestamps } = require('./utils');
const logger = require('./logger');

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error("GOOGLE_API_KEY is not defined in the environment");
}
const genAI = new GoogleGenerativeAI(API_KEY);

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
        if (cachedData && cachedData.script && cachedData.script.length > 0) {
            logger.info(`[${requestHash}] Cache hit for videoId: ${videoId}.`);
            if (sseHandler) {
                sseHandler('full_script', cachedData);
            }
            return;
        }

        await fs.promises.mkdir(baseTempDir, { recursive: true });

        // Step 1: Extract ALL data upfront (Title, VAD, Frames) - Sequentially for status updates
        logger.info(`[${requestHash}] Step 1: Starting initial data extraction...`);
        const extractionLabel = `[${requestHash}] Initial Data Extraction Time`;
        time(extractionLabel);

        if (sseHandler) sseHandler('status_update', { message: '영상 정보 확인 중...' });
        const videoTitle = await util.promisify(execFile)('yt-dlp', ['--get-title', '--encoding', 'utf-8', '--no-progress', '--cookies', 'cookies.txt', youtubeUrl]).then(result => result.stdout.trim());

        if (sseHandler) sseHandler('status_update', { message: '영상 음성 다운로드 및 분석 중...' });
        const audioPath = path.join(baseTempDir, 'audio.wav');
        const downloadedAudio = path.join(baseTempDir, 'audio_source.m4a');
        await util.promisify(execFile)('yt-dlp', ['-f', 'bestaudio', '-o', downloadedAudio, '--no-progress', '--cookies', 'cookies.txt', youtubeUrl]);
        const metadata = await util.promisify(ffmpeg.ffprobe)(downloadedAudio);
        const totalDuration = metadata.format.duration;
        await new Promise((resolve, reject) => {
            ffmpeg(downloadedAudio).toFormat('wav').audioFrequency(16000).audioChannels(1).on('end', resolve).on('error', reject).save(audioPath);
        });

        if (sseHandler) sseHandler('status_update', { message: '음성 없는 구간(VAD) 분석 중...' });
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
        const nonSpeechIntervals = invertSpeechTimestamps(speechTimestamps, totalDuration * 1000);

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
        logger.info(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, VAD Intervals: ${nonSpeechIntervals.length}, Total Frames: ${allTimestamps.length}`);
        
        // Ensure the parent video record exists before processing chunks.
        db.ensureVideoRecord({ videoId, title: videoTitle, duration: Math.round(totalDuration) });

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

            const chunkNonSpeechIntervals = nonSpeechIntervals.filter(i => i.start < chunkEndTime && i.end > chunkStartTime);
            const silentIntervalsString = chunkNonSpeechIntervals.map(interval => `${formatTime(interval.start)} ~ ${formatTime(interval.end)}`).join('\n');

            const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
            
            const basePrompt = '**영상 제목:** ' + videoTitle + '\n\n' +
                '**역할:**\n' +
                '"당신은 시각 장애인을 위한 유튜브 영상 화면 해설 전문가입니다. 제공된 영상의 키프레임, 타임스탬프, 음성 공백 구간 목록을 분석하여, 상세 수준(Verbosity)에 따라 영상의 시각적 정보를 설명하는 한국어 스크립트를 작성해 주세요."\n\n' +
                '**핵심 지시사항:**\n' +
                '1.  **모든 프레임 분석:** 제공된 모든 키프레임에 대해 해설을 생성하되, 각 해설의 중요도와 맥락에 따라 상세 수준(Verbosity Level)을 `[v1]`, `[v2]`, `[v3]`로 태그해 주세요.\n' +
                '2.  **상세 수준(Verbosity Level) 정의:**\n' +
                '    -   `[v1]`: **필수 해설.** 영상의 핵심적인 흐름을 이해하는 데 반드시 필요한 정보. **가급적** 음성 공백 구간에 맞춰 생성합니다.\n' +
                '    -   `[v2]`: **추가 해설.** 스토리를 더 풍부하게 이해하는 데 도움이 되는 추가적인 정보. 음성 공백을 크게 신경 쓰지 않아도 됩니다.\n' +
                '    -   `[v3]`: **상세 묘사.** 배경, 인물의 세세한 표정, 사물 등 모든 시각적 세부 정보.\n' +
                '3.  **형식 준수:** 각 설명은 `[hh:mm:ss][vN] <설명>` 형식이어야 합니다. (N은 1, 2, 3 중 하나)\n\n' +
                '**음성 공백 구간 (해설 삽입 권장 시간):**\n' +
                '\`\`\`\n' +
                silentIntervalsString + '\n' +
                '\`\`\`\n\n' +
                '**세부 지침:**\n' +
                '-   **객관성 유지:** 보이는 것을 그대로 묘사하고, 주관적인 해석이나 감정 표현은 피하세요.\n' +
                '-   **흐름 중시:** 이전 장면에 이어지는 맥락을 고려하여, 이야기가 연결되듯 자연스럽게 설명합니다.\n' +
                '-   **간결성:** 핵심 정보를 중심으로, 짧고 명확한 문장으로 설명합니다.\n\n' +
                '**출력 형식 예시:**\n' +
                '\`\`\`\n' +
                '[00:00:05][v3] 푸른 하늘 아래 넓은 초원이 펼쳐져 있다\n' +
                '[00:01:15][v2] 한 남자가 언덕을 걸어 올라간다\n' +
                '[00:02:12][v1] 남자가 정상에 도착해 갈색 가방을 내려놓는다\n' +
                '\`\`\`';

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

        logger.info(`[${requestHash}] Successfully generated script text.`);
        if (sseHandler) {
            sseHandler('end', { message: 'Processing complete.' });
        }
        
    } catch (error) {
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
        if (cachedData && cachedData.script && cachedData.script.length > 0) {
            logger.info(`[${requestHash}] Cache hit for videoId: ${videoId}. Batch processing not needed.`);
            return;
        }

        await fs.promises.mkdir(baseTempDir, { recursive: true });

        // Step 1: Extract ALL data upfront (Title, VAD, Frames)
        logger.info(`[${requestHash}] Step 1: Starting initial data extraction (Title, VAD, Frames)...`);
        const extractionLabel = `[${requestHash}] Initial Data Extraction Time`;
        time(extractionLabel);

        const [videoTitle, { nonSpeechIntervals, totalDuration }, allTimestamps] = await Promise.all([
            util.promisify(execFile)('yt-dlp', ['--get-title', '--encoding', 'utf-8', '--no-progress', '--cookies', 'cookies.txt', youtubeUrl]).then(result => result.stdout.trim()),
            (async () => {
                const audioPath = path.join(baseTempDir, 'audio.wav');
                const downloadedAudio = path.join(baseTempDir, 'audio_source.m4a');
                await util.promisify(execFile)('yt-dlp', ['-f', 'bestaudio', '-o', downloadedAudio, '--no-progress', '--cookies', 'cookies.txt', youtubeUrl]);
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
                        if (code === 0) return resolve();
                        reject(new Error(`ffmpeg frame extraction exited with code ${code}. Stderr: ${ffmpegStderr}`));
                    });
                });
                return extractedTimestamps;
            })()
        ]);

        timeEnd(extractionLabel);
        logger.info(`[${requestHash}] Initial data extraction complete. Title: ${videoTitle}, VAD Intervals: ${nonSpeechIntervals.length}, Total Frames: ${allTimestamps.length}`);

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
            throw new Error("No frames could be extracted or processed for the AI model.");
        }

        const silentIntervalsString = nonSpeechIntervals.map(interval => `${formatTime(interval.start)} ~ ${formatTime(interval.end)}`).join('\n');
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

        const prompt = '**영상 제목:** ' + videoTitle + '\n\n' +
            '**역할:**\n' +
            '"당신은 시각 장애인을 위한 유튜브 영상 화면 해설 전문가입니다. 제공된 영상의 키프레임, 타임스탬프, 음성 공백 구간 목록을 분석하여, 상세 수준(Verbosity)에 따라 영상의 시각적 정보를 설명하는 한국어 스크립트를 작성해 주세요."\n\n' +
            '**핵심 지시사항:**\n' +
            '1.  **모든 프레임 분석:** 제공된 모든 키프레임에 대해 해설을 생성하되, 각 해설의 중요도와 맥락에 따라 상세 수준(Verbosity Level)을 `[v1]`, `[v2]`, `[v3]`로 태그해 주세요.\n' +
            '2.  **상세 수준(Verbosity Level) 정의:**\n' +
            '    -   `[v1]`: **필수 해설.** 영상의 핵심적인 흐름을 이해하는 데 반드시 필요한 정보. **가급적** 음성 공백 구간에 맞춰 생성합니다.\n' +
            '    -   `[v2]`: **추가 해설.** 스토리를 더 풍부하게 이해하는 데 도움이 되는 추가적인 정보. 음성 공백을 크게 신경 쓰지 않아도 됩니다.\n' +
            '    -   `[v3]`: **상세 묘사.** 배경, 인물의 세세한 표정, 사물 등 모든 시각적 세부 정보.\n' +
            '3.  **형식 준수:** 각 설명은 `[hh:mm:ss][vN] <설명>` 형식이어야 합니다. (N은 1, 2, 3 중 하나)\n\n' +
            '**음성 공백 구간 (해설 삽입 권장 시간):**\n' +
            '\`\`\`\n' +
            silentIntervalsString + '\n' +
            '\`\`\`\n\n' +
            '**세부 지침:**\n' +
            '-   **객관성 유지:** 보이는 것을 그대로 묘사하고, 주관적인 해석이나 감정 표현은 피하세요.\n' +
            '-   **흐름 중시:** 이전 장면에 이어지는 맥락을 고려하여, 이야기가 연결되듯 자연스럽게 설명합니다.\n' +
            '-   **간결성:** 핵심 정보를 중심으로, 짧고 명확한 문장으로 설명합니다.\n\n' +
            '**출력 형식 예시:**\n' +
            '\`\`\`\n' +
            '[00:00:05][v3] 푸른 하늘 아래 넓은 초원이 펼쳐져 있다\n' +
            '[00:01:15][v2] 한 남자가 언덕을 걸어 올라간다\n' +
            '[00:02:12][v1] 남자가 정상에 도착해 갈색 가방을 내려놓는다\n' +
            '\`\`\`';

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
        logger.error(new Error(`[${requestHash}] Error in batch processing: ${error.message}`));
    } finally {
        if (fs.existsSync(baseTempDir)) {
            await fs.promises.rm(baseTempDir, { recursive: true, force: true });
        }
        timeEnd(totalTimeLabel);
    }
};

module.exports = { processVideo, processVideoBatch };
