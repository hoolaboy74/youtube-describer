// run_comparison_test.js
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { GoogleGenerativeAI } = require("@google/generative-ai");
const util = require('util');
const { execFile, spawn } = require('child_process');
const { performance } = require('perf_hooks');

// --- Basic Setup ---
const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error("GOOGLE_API_KEY is not defined in the environment");
}
const genAI = new GoogleGenerativeAI(API_KEY);

const preprocessVtt = (vttContent) => {
    return vttContent
        .replace(/<v[^>]*>[^<]*<\/v>/g, '') // Remove speaker tags
        .replace(/(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/g, (match, start, end) => {
            const toSeconds = (time) => {
                const parts = time.split(/[:.]/);
                return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]) + parseFloat(`0.${parts[3]}`);
            };
            return `(${toSeconds(start).toFixed(3)}s) --> (${toSeconds(end).toFixed(3)}s)`;
        })
        .replace(/<[^>]*>/g, '') // Remove all other HTML tags
        .replace(/\s*\n\s*/g, '\n') // Condense multiple newlines
        .trim();
};

const getRandomCookiePath = () => {
    const cookiesDir = path.join(__dirname, 'cookies');
    if (!fs.existsSync(cookiesDir)) return null;
    const cookieFiles = fs.readdirSync(cookiesDir).filter(file => file.endsWith('_cookies.txt') && fs.statSync(path.join(cookiesDir, file)).size > 0);
    if (cookieFiles.length === 0) return null;
    const randomCookieFile = cookieFiles[Math.floor(Math.random() * cookieFiles.length)];
    return path.join(cookiesDir, randomCookieFile);
};


/**
 * Runs a full processing test for a given YouTube URL and ffmpeg filter.
 * @param {string} youtubeUrl - The URL of the YouTube video.
 * @param {string} ffmpegFilter - The ffmpeg select filter to use for frame extraction.
 * @param {string} outputFilename - The file to save the generated script to.
 * @returns {Promise<number>} - The total duration of the process in seconds.
 */
const runTest = async (youtubeUrl, ffmpegFilter, outputFilename) => {
    const startTime = performance.now();
    const videoId = new URL(youtubeUrl).searchParams.get('v') || youtubeUrl.split('/').pop().split('?').shift();
    const requestHash = `${outputFilename.split('_')[1]}-${videoId.substring(0, 4)}`;
    
    console.log(`[${requestHash}] Starting test with filter: "${ffmpegFilter}"`);

    const baseTempDir = path.join(__dirname, 'temp', `${videoId}_${requestHash}`);

    try {
        await fs.promises.mkdir(baseTempDir, { recursive: true });

        // --- Step 1: Data Extraction ---
        console.log(`[${requestHash}] Extracting video info, subtitles, and frames...`);
        const extractionStartTime = performance.now();

        const cookiePath = getRandomCookiePath();
        const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];
        const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

        const { stdout: stdoutJson } = await util.promisify(execFile)('yt-dlp', [
            '-j',
            '-f', 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]',
            '--no-progress',
            ...cookieArgs,
            ...proxyArgs,
            youtubeUrl
        ]);
        const videoInfo = JSON.parse(stdoutJson);
        const videoTitle = videoInfo.title;

        // Get Subtitles
        let subtitleContent = '';
        const subtitlePath = path.join(baseTempDir, 'subtitles.ko.vtt');
        try {
            await util.promisify(execFile)('yt-dlp', [
                '--write-auto-sub', '--sub-lang', 'ko', '--sub-format', 'vtt',
                '--output', `${baseTempDir}/subtitles`, '--skip-download', '--no-progress',
                ...cookieArgs, ...proxyArgs, youtubeUrl
            ]);
            if (fs.existsSync(subtitlePath)) {
                subtitleContent = preprocessVtt(fs.readFileSync(subtitlePath, 'utf-8'));
            }
        } catch (e) {
            console.warn(`[${requestHash}] Could not fetch subtitles: ${e.message}`);
        }

        // Get Frames
        const allTimestamps = await new Promise((resolve, reject) => {
            const extractedTimestamps = [];
            const ytdlpProcess = spawn('yt-dlp', ['-f', 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]', '-o', '-', '--no-progress', ...cookieArgs, ...proxyArgs, youtubeUrl]);
            const ffmpegProcess = spawn('ffmpeg', ['-i', '-', '-vf', `${ffmpegFilter},showinfo`, '-vsync', 'vfr', path.join(baseTempDir, 'frame-%04d.png')]);
            
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

        const extractionDuration = ((performance.now() - extractionStartTime) / 1000).toFixed(2);
        console.log(`[${requestHash}] Data extraction complete in ${extractionDuration}s. Extracted ${allTimestamps.length} frames.`);

        // --- Step 2: AI Generation ---
        if (allTimestamps.length === 0) {
            console.log(`[${requestHash}] No frames extracted. Skipping AI generation.`);
            await fs.promises.writeFile(outputFilename, 'No frames were extracted with this method.');
            return ((performance.now() - startTime) / 1000).toFixed(2);
        }

        console.log(`[${requestHash}] Starting AI generation...`);
        const aiStartTime = performance.now();

        const allFrameFiles = (await fs.promises.readdir(baseTempDir)).filter(f => f.endsWith('.png')).sort();
        const imageParts = [];
        for (let i = 0; i < allTimestamps.length; i++) {
            const timestamp = allTimestamps[i];
            const frameFile = allFrameFiles[i];
            if (frameFile) {
                const framePath = path.join(baseTempDir, frameFile);
                if (fs.existsSync(framePath)) {
                    imageParts.push({ inlineData: { data: Buffer.from(fs.readFileSync(framePath)).toString("base64"), mimeType: 'image/png' } });
                    imageParts.push({ text: `Timestamp: [${Math.round(timestamp)}]` });
                }
            }
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro", generationConfig: { temperature: 0.7 } });
        const promptTemplate = fs.readFileSync(path.join(__dirname, 'prompt_template.txt'), 'utf-8');
        let prompt = promptTemplate.replace('{{VIDEO_TITLE}}', videoTitle).replace('{{SUBTITLES}}', subtitleContent);

        const result = await model.generateContent([prompt, ...imageParts]);
        const scriptText = result.response.text();
        
        await fs.promises.writeFile(outputFilename, scriptText);
        
        const aiDuration = ((performance.now() - aiStartTime) / 1000).toFixed(2);
        console.log(`[${requestHash}] AI generation complete in ${aiDuration}s.`);

    } catch (error) {
        console.error(`[${requestHash}] An error occurred during the test:`, error);
    } finally {
        if (fs.existsSync(baseTempDir)) {
            await fs.promises.rm(baseTempDir, { recursive: true, force: true });
        }
    }

    const totalDuration = ((performance.now() - startTime) / 1000);
    console.log(`[${requestHash}] Test finished. Total time: ${totalDuration.toFixed(2)}s. Result saved to ${outputFilename}`);
    return totalDuration;
};


const main = async () => {
    console.log("--- Starting Frame Extraction Comparison Test ---");
    const youtubeUrl = "https://youtu.be/85U99Jvd66w?si=7XltXYJOqfAI-B5p";

    // --- Test 1: Old Method ---
    const oldFilter = "select='gt(scene,0.4)'";
    const oldOutput = "comparison_old_method.txt";
    const oldDuration = await runTest(youtubeUrl, oldFilter, oldOutput);
    
    console.log("\n" + "-".repeat(50) + "\n");

    // --- Test 2: New Method ---
    const newFilter = "select='gt(scene,0.4)+gte(t-prev_selected_t,5)'";
    const newOutput = "comparison_new_method.txt";
    const newDuration = await runTest(youtubeUrl, newFilter, newOutput);

    console.log("\n" + "--- Test Summary ---");
    console.log(`Video URL: ${youtubeUrl}`);
    console.log("\n--- OLD METHOD ---");
    console.log(`Filter: ${oldFilter}`);
    console.log(`Execution Time: ${oldDuration.toFixed(2)} seconds`);
    console.log(`Output File: ${oldOutput}`);
    
    console.log("\n--- NEW METHOD ---");
    console.log(`Filter: ${newFilter}`);
    console.log(`Execution Time: ${newDuration.toFixed(2)} seconds`);
    console.log(`Output File: ${newOutput}`);
    console.log("\nComparison complete. Please check the generated text files.");
};

main().catch(console.error);
