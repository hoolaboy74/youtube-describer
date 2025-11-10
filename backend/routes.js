const express = require('express');
const crypto = require('crypto');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { getYoutubeVideoId } = require('./utils');
const { processVideo, processVideoBatch } = require('./videoProcessor');
const logger = require('./logger');

const router = express.Router();
const ttsClient = new TextToSpeechClient();
const audioCacheDir = path.join(__dirname, 'public', 'audio');

const { google } = require('googleapis');

const youtube = google.youtube({
    version: 'v3',
    auth: process.env.GOOGLE_API_KEY,
});

// Endpoint for unified search
router.get('/search', async (req, res) => {
    const { query } = req.query;
    if (!query) {
        return res.status(400).json({ error: 'Query parameter is required' });
    }

    try {
        // Perform both searches in parallel
        const [dbResults, youtubeSearchResults] = await Promise.all([
            // 1. Search local database
            db.searchVideosByTitle(query),
            // 2. Search YouTube
            youtube.search.list({
                part: 'snippet',
                q: query,
                maxResults: 50, // The API has a max limit of 50 per request
                type: 'video',
            }),
        ]);

        const youtubeResults = youtubeSearchResults.data.items || [];

        // Get video details for duration and views
        const videoIds = youtubeResults.map(item => item.id.videoId).join(',');
        let videoDetails = [];
        if (videoIds) {
            const details = await youtube.videos.list({
                part: 'contentDetails,statistics',
                id: videoIds,
            });
            videoDetails = details.data.items || [];
        }

        const videoDetailsMap = new Map(videoDetails.map(item => [item.id, item]));

        // Format results to have a consistent structure
        const formattedDbResults = dbResults.map(v => ({
            id: v.videoId,
            title: v.title,
            thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            source: 'db'
        }));

        const formattedYoutubeResults = youtubeResults.map(item => {
            const videoDetail = videoDetailsMap.get(item.id.videoId);
            const duration = videoDetail?.contentDetails?.duration;
            const views = videoDetail?.statistics?.viewCount;

            // format duration from ISO 8601 to HH:MM:SS
            let durationFormatted = '0:00';
            if (duration) {
                const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
                if (match) {
                    const hours = (parseInt(match[1]) || 0);
                    const minutes = (parseInt(match[2]) || 0);
                    const seconds = (parseInt(match[3]) || 0);
                    if (hours > 0) {
                        durationFormatted = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
                    } else {
                        durationFormatted = `${minutes}:${String(seconds).padStart(2, '0')}`;
                    }
                }
            }

            return {
                id: item.id.videoId,
                title: item.snippet.title,
                thumbnail: item.snippet.thumbnails.high.url,
                channel: item.snippet.channelTitle,
                views: views ? parseInt(views) : 0,
                durationFormatted,
                source: 'youtube'
            };
        });

        res.json({
            dbResults: formattedDbResults,
            youtubeResults: formattedYoutubeResults,
        });

    } catch (error) {
        logger.error(`Search failed for query "${query}":`, error);
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
        logger.error(`Failed to fetch script for videoId ${videoId}:`, error);
        res.status(500).json({ error: 'Failed to fetch script' });
    }
});

// Public endpoint for financial summary
router.get('/financial-summary', (req, res) => {
    try {
        const summary = db.getAggregatedCosts();
        res.json(summary);
    } catch (error) {
        logger.error('[Public] Failed to fetch financial summary:', error);
        res.status(500).json({ error: 'Failed to fetch financial summary' });
    }
});

router.get('/cached-videos', (req, res) => {
    try {
        const videos = db.listVideos();
        res.json(videos);
    } catch (error) {
        logger.error('Failed to fetch cached videos:', error);
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
        logger.error(`Failed to check existence for videoId ${videoId}:`, error);
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
        logger.error('TTS API Error:', error);
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
        sendSse('backend_error', { message: 'Invalid or missing YouTube URL' });
        return res.end();
    }

    const videoId = getYoutubeVideoId(youtubeUrl);
    if (!videoId) {
        sendSse('backend_error', { message: 'Could not extract YouTube video ID from URL' });
        return res.end();
    }

    // Check financial balance before processing
    try {
        const financialSummary = db.getAggregatedCosts();
        if (financialSummary.balance <= 0) {
            logger.warn(`[Processing] Video processing blocked for ${videoId} due to insufficient funds. Balance: ${financialSummary.balance}`);
            sendSse('backend_error', { message: 'funds_depleted' });
            return res.end();
        }
    } catch (error) {
        logger.error(`[Processing] Failed to check financial balance for ${videoId}:`, error);
        sendSse('backend_error', { message: 'Failed to check server balance. Please try again later.' });
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
        logger.error(`[batch-${videoId.substring(0,8)}] Unhandled error in batch processing:`, err);
    });
});

// --- COMMENTS API ENDPOINTS ---

// GET all comments for a video
router.get('/comments/:videoId', (req, res) => {
    try {
        const { videoId } = req.params;
        const comments = db.getComments(videoId);
        res.json(comments);
    } catch (error) {
        logger.error(`Failed to fetch comments for video ${req.params.videoId}:`, error);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

// POST a new comment
router.post('/comments', (req, res) => {
    try {
        const { videoId, nickname, password, content } = req.body;
        if (!videoId || !nickname || !password || !content) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const newCommentId = db.addComment({ videoId, nickname, password, content });
        const newComment = db.getCommentById(newCommentId);
        // Return the newly created comment (without password)
        res.status(201).json({
            id: newComment.id,
            videoId: newComment.videoId,
            nickname: newComment.nickname,
            content: newComment.content,
            createdAt: newComment.createdAt
        });
    } catch (error) {
        logger.error('Failed to add comment:', error);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// PUT (update) a comment
router.put('/comments/:commentId', (req, res) => {
    try {
        const { commentId } = req.params;
        const { password, content } = req.body;

        if (!password || !content) {
            return res.status(400).json({ error: 'Password and content are required' });
        }

        const comment = db.getCommentById(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const isPasswordValid = db.verifyPassword(comment.password, password);
        if (!isPasswordValid) {
            return res.status(403).json({ error: 'Invalid password' });
        }

        const success = db.updateComment({ commentId, content });
        if (success) {
            res.status(200).json({ message: 'Comment updated successfully' });
        } else {
            res.status(500).json({ error: 'Failed to update comment' });
        }
    } catch (error) {
        logger.error(`Failed to update comment ${req.params.commentId}:`, error);
        res.status(500).json({ error: 'Failed to update comment' });
    }
});

// DELETE a comment
router.delete('/comments/:commentId', (req, res) => {
    try {
        const { commentId } = req.params;
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'Password is required' });
        }

        const comment = db.getCommentById(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const isPasswordValid = db.verifyPassword(comment.password, password);
        if (!isPasswordValid) {
            return res.status(403).json({ error: 'Invalid password' });
        }

        const success = db.deleteComment(commentId);
        if (success) {
            res.status(200).json({ message: 'Comment deleted successfully' });
        } else {
            res.status(500).json({ error: 'Failed to delete comment' });
        }
    } catch (error) {
        logger.error(`Failed to delete comment ${req.params.commentId}:`, error);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

// --- ADMIN API ENDPOINTS ---

// Simple password authentication middleware for admin routes
const adminAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const expectedPassword = 'momcenter!@#';

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7); // "Bearer ".length
        if (token === expectedPassword) {
            return next();
        }
    }
    logger.warn(`[Admin] Unauthorized access attempt to ${req.originalUrl}`);
    res.status(401).json({ error: 'Unauthorized' });
};

// Apply the middleware to all /admin routes
const adminRouter = express.Router();
adminRouter.use(adminAuth);

// GET cost summary
adminRouter.get('/summary', (req, res) => {
    try {
        const summary = db.getAggregatedCosts();
        res.json(summary);
    } catch (error) {
        logger.error('[Admin] Failed to fetch cost summary:', error);
        res.status(500).json({ error: 'Failed to fetch cost summary' });
    }
});

// GET all donations
adminRouter.get('/donations', (req, res) => {
    try {
        const donations = db.listDonations();
        res.json(donations);
    } catch (error) {
        logger.error('[Admin] Failed to fetch donations:', error);
        res.status(500).json({ error: 'Failed to fetch donations' });
    }
});

// POST a new donation
adminRouter.post('/donations', (req, res) => {
    try {
        const { donator_name, amount, donation_date, message } = req.body;
        if (!donator_name || amount === null || amount === undefined || !donation_date) {
            return res.status(400).json({ error: 'Missing required fields for donation' });
        }
        const newDonationId = db.addDonation({ donator_name, amount: parseInt(amount), donation_date, message });
        res.status(201).json({ id: newDonationId });
    } catch (error) {
        logger.error('[Admin] Failed to add donation:', error);
        res.status(500).json({ error: 'Failed to add donation' });
    }
});

// DELETE a donation
adminRouter.delete('/donations/:id', (req, res) => {
    try {
        const { id } = req.params;
        const success = db.deleteDonation(id);
        if (success) {
            res.status(200).json({ message: 'Donation deleted successfully' });
        } else {
            res.status(404).json({ error: 'Donation not found' });
        }
    } catch (error) {
        logger.error(`[Admin] Failed to delete donation ${req.params.id}:`, error);
        res.status(500).json({ error: 'Failed to delete donation' });
    }
});

// GET all API costs
adminRouter.get('/costs', (req, res) => {
    try {
        const costs = db.listApiCosts();
        res.json(costs);
    } catch (error) {
        logger.error('[Admin] Failed to fetch API costs:', error);
        res.status(500).json({ error: 'Failed to fetch API costs' });
    }
});

// Mount the admin router
router.use('/admin', adminRouter);


module.exports = router;
