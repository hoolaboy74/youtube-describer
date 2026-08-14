#!/usr/bin/env node

const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');
const util = require('util');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const db = require('./database'); // Require the whole module
require('dotenv').config({ path: path.join(__dirname, '.env') });

const analyzer = require('./modules/analyzer');
const describer = require('./modules/describer');
const synchronizer = require('./modules/synchronizer');

const CHUNK_DURATION_MIN = 15;
const CHUNK_DURATION_SEC = CHUNK_DURATION_MIN * 60;
const FRAME_INTERVAL = 2; 

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
    console.error("Error: GOOGLE_API_KEY is not defined in .env file.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(API_KEY);
const exec = util.promisify(execFile);

// --- Metadata Helper ---
const getMetadata = async (url) => {
    try {
        const cookiePath = path.join(__dirname, 'cookies.txt');
        const cookieArgs = fs.existsSync(cookiePath) ? ['--cookies', cookiePath] : [];
        const { stdout } = await exec('python3', [
            '-m', 'yt_dlp', 
            '--dump-json', 
            '--no-playlist', 
            '--plugin-dirs', path.join(__dirname, 'yt_dlp_plugins'), 
            '--remote-components', 'ejs:github', 
            '--no-check-certificate', 
            '--impersonate', 'safari', 
            ...cookieArgs, 
            url
        ], { maxBuffer: 1024 * 1024 * 10 });
        const data = JSON.parse(stdout);
        
        const videoId = data.id;
        const title = data.title;
        const duration = data.duration;
        
        // 1. Check official language metadata
        let audioLanguage = data.language || data.default_audio_language;

        // 2. Heuristic: Check for Hangul characters in title
        // Corrected Regex: Removed pipes inside [] which were matching literal '|'
        const hasHangul = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(title);
        
        // 3. Double Check: If metadata claims 'ko' but title has NO Hangul, suspect mislabeling
        if (audioLanguage === 'ko' && !hasHangul) {
            audioLanguage = 'en';
        }
        
        if (!audioLanguage) {
            if (hasHangul) {
                audioLanguage = 'ko';
            } else {
                audioLanguage = 'en'; // Default to foreign if no Hangul found
            }
        }

        return { videoId, title, duration, audioLanguage };
    } catch (e) {
        throw new Error(`Failed to extract metadata: ${e.message}`);
    }
};

const preprocessVtt = (vttContent) => {
    const lines = vttContent.split('\n');
    const result = [];
    const timeRegex = /(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})/; 

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.includes('-->')) {
            const match = line.match(timeRegex);
            if (match) {
                const hours = parseInt(match[1], 10);
                const minutes = parseInt(match[2], 10);
                const seconds = parseInt(match[3], 10);
                const totalSeconds = hours * 3600 + minutes * 60 + seconds;
                
                let textLines = [];
                let j = i + 1;
                while (j < lines.length) {
                    const nextLine = lines[j].trim();
                    if (nextLine === '' || nextLine.includes('-->') || nextLine === 'WEBVTT' || nextLine.match(/^\d+$/)) {
                        break;
                    }
                    let cleanLine = nextLine.replace(/<[^>]*>/g, '')
                                            .replace(/\s*\[.*?\]/g, '')
                                            .replace(/\s*\(.*?\)/g, '')
                                            .replace(/[♪♫♬]/g, '')
                                            .trim();
                    if (cleanLine) textLines.push(cleanLine);
                    j++;
                }
                if (textLines.length > 0) {
                    result.push({ seconds: totalSeconds, text: textLines.join(' ') });
                }
            }
        }
    }
    return result;
};

const main = async () => {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error("Usage: node process_video_cli.js <YOUTUBE_URL> [--part <PART_NUM>]");
        process.exit(1);
    }

    const VIDEO_URL = args[0];
    const partIndex = args.indexOf('--part');
    const TARGET_PART = partIndex !== -1 ? parseInt(args[partIndex + 1]) : null;
    const isFeatured = args.indexOf('--featured') !== -1 ? 1 : 0;

    console.log(`[CLI] Initializing CHAIN PROCESS for: ${VIDEO_URL}`);
    if (isFeatured) console.log('[CLI] This video will be marked as FEATURED.');

    let meta;
    try {
        console.log('[CLI] Fetching metadata...');
        meta = await getMetadata(VIDEO_URL);
        console.log(`[CLI] Video ID: ${meta.videoId}`);
        console.log(`[CLI] Title: ${meta.title}`);
        console.log(`[CLI] Detected Audio Language: ${meta.audioLanguage} ${meta.audioLanguage === 'ko' ? '(Korean)' : '(Foreign)'}`);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }

    const VIDEO_ID = meta.videoId;
    const VIDEO_TITLE = meta.title;
    const totalDuration = meta.duration;
    const isKoreanVideo = meta.audioLanguage === 'ko';

    const TEMP_DIR = path.join(__dirname, 'temp', `proc_${VIDEO_ID}`);
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    // 0. Database Cleanup (Skip if partial)
    if (!TARGET_PART) {
        try {
            db.db.prepare('DELETE FROM scripts WHERE videoId = ?').run(VIDEO_ID);
            db.db.prepare('DELETE FROM videos WHERE videoId = ?').run(VIDEO_ID);
        } catch(e) {}
        
        try {
            db.db.prepare(`
              INSERT INTO videos (videoId, title, duration, filesize, status, is_featured)
              VALUES (?, ?, ?, ?, 'processing', ?)
              ON CONFLICT(videoId) DO UPDATE SET
                title = excluded.title,
                duration = excluded.duration,
                filesize = excluded.filesize,
                status = 'processing',
                is_featured = excluded.is_featured
            `).run(VIDEO_ID, VIDEO_TITLE, Math.round(totalDuration), 0, isFeatured);
        } catch(e) { console.error('DB Init Error:', e.message); }
    }

    const fullVideoPath = path.join(TEMP_DIR, 'full.mp4');
    
    // Subtitle Strategy:
    // Korean Video -> Get 'ko'
    // Foreign Video -> Get all major (en, ja, fr...) to find original
    const subArgs = ['--write-sub', '--write-auto-sub'];
    if (isKoreanVideo) {
        subArgs.push('--sub-lang', 'ko');
    } else {
        subArgs.push('--sub-lang', 'en,ja,fr,es,de,it,ru,zh,vi,th,id');
    }

    if (!fs.existsSync(fullVideoPath)) {
        console.log(`[CLI] Step 1: Downloading full video & ${isKoreanVideo ? 'Korean' : 'Source'} subtitles...`);
        try {
            const cookiePath = path.join(__dirname, 'cookies.txt');
            const cookieArgs = fs.existsSync(cookiePath) ? ['--cookies', cookiePath] : [];
            const ytdlpArgs = [
                '-m', 'yt_dlp',
                '-f', 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]', 
                '-o', fullVideoPath,
                '--force-ipv4',
                '--no-check-certificate',
                '--plugin-dirs', path.join(__dirname, 'yt_dlp_plugins'),
                '--remote-components', 'ejs:github',
                '--impersonate', 'safari',
                ...cookieArgs,
                ...subArgs,
                VIDEO_URL
            ];
            console.log(`[CLI] Executing: python3 ${ytdlpArgs.join(' ')}`);
            await exec('python3', ytdlpArgs, { cwd: TEMP_DIR });
            console.log('[CLI] Download complete.');
        } catch (err) { 
            console.error('[CLI] Download Failed:', err.message); 
            process.exit(1);
        }
    }

    let allSubtitles = [];
    let detectedLang = meta.audioLanguage;

    const files = fs.readdirSync(TEMP_DIR);
    let subFile;
    if (isKoreanVideo) {
        subFile = files.find(f => f.endsWith('.ko.vtt'));
    } else {
        // Strategy for Foreign Video:
        // 1. Preferred Languages (en, ja)
        subFile = files.find(f => f.endsWith('.en.vtt')) || files.find(f => f.endsWith('.ja.vtt'));
        
        // 2. If not found, pick ANY non-Korean vtt file (excluding live chat)
        // We pick the largest file, assuming it has the most dialogue.
        if (!subFile) {
            const candidateFiles = files.filter(f => f.endsWith('.vtt') && !f.endsWith('.live_chat.vtt') && !f.endsWith('.ko.vtt'));
            if (candidateFiles.length > 0) {
                // Sort by size descending
                candidateFiles.sort((a, b) => {
                    return fs.statSync(path.join(TEMP_DIR, b)).size - fs.statSync(path.join(TEMP_DIR, a)).size;
                });
                subFile = candidateFiles[0];
            }
        }
        
        // 3. Last resort: If only Korean subs exist (rare for foreign video but possible), use it?
        // No, better to use visual-only than reading Korean subs as "translation input" which might confuse AI.
        // But wait, if it's a foreign movie with ONLY Korean subs, we should probably read them as [ocr] or [trans]?
        // Let's stick to the plan: Foreign video needs Foreign subs for translation. 
        // If we feed Korean subs to AI saying "Translate this", AI might just repeat it.
        // Actually, if we have Korean subs for a foreign movie, that is PERFECT! It's already translated!
        // But our current prompt logic says "If Foreign, Translate". 
        // Let's add a special check for this case later. For now, let's try to get foreign subs.
        
        if (subFile) {
            const parts = subFile.split('.');
            if (parts.length >= 3) detectedLang = parts[parts.length - 2];
        }
    }

    if (subFile) {
        console.log(`[CLI] Selected Subtitle: ${subFile} (Ref Lang: ${detectedLang})`);
        allSubtitles = preprocessVtt(fs.readFileSync(path.join(TEMP_DIR, subFile), 'utf-8'));
    } else {
        console.log('[CLI] No useful subtitle found. Audio description will rely on visuals only.');
    }

    let analysisResult = null;
    const chunks = Math.ceil(totalDuration / CHUNK_DURATION_SEC);

    for (let i = 0; i < chunks; i++) {
        if (TARGET_PART && (i + 1) !== TARGET_PART) continue;

        const startTime = i * CHUNK_DURATION_SEC;
        const endTime = Math.min((i + 1) * CHUNK_DURATION_SEC, totalDuration);
        
        try {
             db.db.prepare('DELETE FROM scripts WHERE videoId = ? AND timestamp >= ? AND timestamp < ?').run(VIDEO_ID, startTime, endTime);
             if (TARGET_PART) console.log(`[CLI] Cleared previous DB records for range ${startTime}s - ${endTime}s`);
        } catch (e) { console.warn('[CLI] DB clear warning:', e.message); }

        const chunkName = `chunk_${i}`;
        const chunkPath = path.join(TEMP_DIR, `${chunkName}.mp4`);
        
        console.log(`\n=== Processing Part ${i+1}/${chunks} (${Math.floor(startTime/60)}m - ${Math.floor(endTime/60)}m) ===`);

        if (!fs.existsSync(chunkPath)) {
            await exec('ffmpeg', [
                '-ss', startTime,
                '-i', fullVideoPath,
                '-t', (endTime - startTime),
                '-c', 'copy', '-y', chunkPath
            ]);
        }

        const chunkSubtitles = allSubtitles.filter(s => s.seconds >= startTime && s.seconds < endTime);
        const subText = chunkSubtitles.map(s => `[${s.seconds}] ${s.text}`).join('\n');

        const frameDir = path.join(TEMP_DIR, `frames_${chunkName}`);
        if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir);

        const extractedTimestamps = [];
        await new Promise((resolve, reject) => {
            const ffmpegArgs = ['-i', chunkPath, '-vf', `select='isnan(prev_selected_t)+gte(t-prev_selected_t,${FRAME_INTERVAL})',showinfo`, '-vsync', 'vfr', '-q:v', '2', path.join(frameDir, 'frame-%04d.jpg')];
            const p = spawn('ffmpeg', ffmpegArgs);
            p.stderr.on('data', d => {
                 const matches = d.toString().matchAll(/pts_time:(\d+\.?\d*)/g);
                 for (const m of matches) extractedTimestamps.push(parseFloat(m[1]) + startTime);
            });
            p.on('close', c => c === 0 ? resolve() : reject(new Error("ffmpeg failed")));
        });

        const reReadFiles = fs.readdirSync(frameDir).filter(f => f.endsWith('.jpg')).sort();
        const extractedFrames = [];
        for(let k=0; k<extractedTimestamps.length; k++) {
            if (reReadFiles[k]) {
                extractedFrames.push({
                    path: path.join(frameDir, reReadFiles[k]),
                    timestamp: extractedTimestamps[k]
                });
            }
        }

        if (extractedFrames.length === 0) continue;

        if (!analysisResult) {
            console.log('\n[Chain] Step 1: Analyzing Video...');
            analysisResult = await analyzer.analyzeVideo(genAI, VIDEO_TITLE, extractedFrames);
        }

        console.log(`\n[Chain] Step 2: Describing Segment (Audio Lang: ${meta.audioLanguage})...`);
        const rawDraft = await describer.describeSegment(genAI, analysisResult, VIDEO_TITLE, extractedFrames, subText, meta.audioLanguage);
        
        console.log('\n[Chain] Step 3: Synchronizing & Editing...');
        const finalJson = await synchronizer.synchronizeScript(genAI, rawDraft, subText);

        const finalScriptData = finalJson.map((item) => {
            return { 
                id: crypto.createHash('sha256').update(item.text + item.timestamp).digest('hex'), 
                timestamp: item.timestamp, 
                text: item.text, 
                verbosity: item.type === 'text' ? 'text' : 'v2' 
            };
        });

        if (finalScriptData.length > 0) {
            db.saveVideoChunk({ videoId: VIDEO_ID, scriptChunk: finalScriptData });
            console.log(`[CLI] Saved ${finalScriptData.length} lines for Part ${i+1}.`);
        }
        
        fs.unlinkSync(chunkPath);
        fs.rmSync(frameDir, { recursive: true, force: true });
    }

    console.log(`\n[CLI] All processing complete for ${VIDEO_ID}`);
    db.updateVideoStatus(VIDEO_ID, 'completed');
};

main();
