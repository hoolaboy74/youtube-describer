const express = require('express');
const crypto = require('crypto');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { getYoutubeVideoId } = require('./utils');
const { processVideo, processVideoBatch } = require('./videoProcessor');

const router = express.Router();
const ttsClient = new TextToSpeechClient();
const audioCacheDir = path.join(__dirname, 'public', 'audio');

const Youtube = require('youtube-sr').default;

// Endpoint for unified search
router.get('/search', async (req, res) => {
    const { query } = req.query;
    if (!query) {
        return res.status(400).json({ error: 'Query parameter is required' });
    }

    try {
        // Perform both searches in parallel
        const [dbResults, youtubeResults] = await Promise.all([
            // 1. Search local database
            db.searchVideosByTitle(query),
            // 2. Search YouTube
            Youtube.search(query, { limit: 20, type: 'video' })
        ]);

        // Format results to have a consistent structure
        const formattedDbResults = dbResults.map(v => ({
            id: v.videoId,
            title: v.title,
            // You might want to store thumbnails in the DB in the future
            thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            source: 'db' // Add source identifier
        }));

        const formattedYoutubeResults = youtubeResults.map(v => ({
            id: v.id,
            title: v.title,
            thumbnail: v.thumbnail?.url, // Safely access thumbnail
            channel: v.channel?.name,
            views: v.views,
            durationFormatted: v.durationFormatted,
            source: 'youtube' // Add source identifier
        }));

        res.json({
            dbResults: formattedDbResults,
            youtubeResults: formattedYoutubeResults,
        });

    } catch (error) {
        console.error(`Search failed for query "${query}":`, error);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Endpoint to get the list of all cached videos
router.get('/script/:videoId', (req, res) => {
    const { videoId } = req.params;
    try {
        const videoData = db.getVideo(videoId);
        if (videoData) {
            res.json(videoData);
        } else {
            res.status(404).json({ error: 'Script not found for the given video ID' });
        }
    } catch (error) {
        console.error(`Failed to fetch script for videoId ${videoId}:`, error);
        res.status(500).json({ error: 'Failed to fetch script' });
    }
});

router.get('/cached-videos', (req, res) => {
    try {
        const videos = db.listVideos();
        res.json(videos);
    } catch (error) {
        console.error('Failed to fetch cached videos:', error);
        res.status(500).json({ error: 'Failed to fetch cached videos' });
    }
});

// Endpoint to check if a video exists
router.get('/video-exists/:videoId', (req, res) => {
    const { videoId } = req.params;
    try {
        const videoData = db.getVideo(videoId);
        res.json({ exists: !!videoData });
    } catch (error) {
        console.error(`Failed to check existence for videoId ${videoId}:`, error);
        res.status(500).json({ error: 'Failed to check video existence' });
    }
});

// Endpoint for On-Demand Hybrid TTS Caching
router.post('/tts', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const hash = crypto.createHash('sha256').update(text).digest('hex');
        const prefix1 = hash.substring(0, 2);
        const prefix2 = hash.substring(2, 4);
        const ttsCacheDir = path.join(audioCacheDir, 'tts_cache');
        const cacheDirPath = path.join(ttsCacheDir, prefix1, prefix2);
        const audioFilename = `${hash}.mp3`;
        const audioFilePath = path.join(cacheDirPath, audioFilename);

        if (fs.existsSync(audioFilePath)) {

            return res.sendFile(audioFilePath);
        }


        await fs.promises.mkdir(cacheDirPath, { recursive: true });

        const [ttsResponse] = await ttsClient.synthesizeSpeech({
            input: { text },
            voice: { languageCode: 'ko-KR', name: 'ko-KR-Wavenet-A' },
            audioConfig: { audioEncoding: 'MP3' },
        });

        await fs.promises.writeFile(audioFilePath, ttsResponse.audioContent, 'binary');


        res.set('Content-Type', 'audio/mpeg');
        res.send(ttsResponse.audioContent);

    } catch (error) {
        console.error('TTS API Error:', error);
        res.status(500).json({ error: 'Failed to synthesize speech' });
    }
});

// --- MAIN PROCESSING API ENDPOINT (SSE) ---
router.get('/process', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendSse = (eventName, data) => {
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const { youtubeUrl } = req.query;
    if (!youtubeUrl || typeof youtubeUrl !== 'string') {
        sendSse('error', { message: 'Invalid or missing YouTube URL' });
        return res.end();
    }

    const videoId = getYoutubeVideoId(youtubeUrl);
    if (!videoId) {
        sendSse('error', { message: 'Could not extract YouTube video ID from URL' });
        return res.end();
    }

    // Use the refactored processor
    await processVideo(videoId, youtubeUrl, sendSse);
    res.end();
});

// --- BATCH PROCESSING API ENDPOINT ---
router.post('/batch-process', (req, res) => {
    const { youtubeUrl } = req.body;
    if (!youtubeUrl || typeof youtubeUrl !== 'string') {
        return res.status(400).json({ message: 'Invalid or missing YouTube URL' });
    }

    const videoId = getYoutubeVideoId(youtubeUrl);
    if (!videoId) {
        return res.status(400).json({ message: 'Could not extract YouTube video ID from URL' });
    }

    // Immediately respond to the client
    res.status(202).json({ message: `Batch processing started for video ID: ${videoId}` });

    // Start processing in the background (fire-and-forget)
    processVideoBatch(videoId, youtubeUrl).catch(err => {
        console.error(`[batch-${videoId.substring(0,8)}] Unhandled error in batch processing:`, err);
    });
});

module.exports = router;
