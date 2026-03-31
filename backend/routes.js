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
// Initialize Google Cloud Text-to-Speech Client
// Use 'rest' fallback only if custom CA certs are present (local dev environment)
const ttsClientOptions = process.env.NODE_EXTRA_CA_CERTS ? { fallback: 'rest' } : {};
const ttsClient = new TextToSpeechClient(ttsClientOptions);
const audioCacheDir = path.join(__dirname, 'public', 'audio');

const YouTube = require('youtube-sr').default;

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
            // 2. Search YouTube using youtube-sr
            YouTube.search(query, { limit: 50, type: 'video' }),
        ]);

        // Format results to have a consistent structure
        const formattedDbResults = dbResults.map(v => ({
            id: v.videoId,
            title: v.title,
            thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            source: 'db'
        }));

        const formattedYoutubeResults = youtubeSearchResults.map(item => {
            // format duration from milliseconds to HH:MM:SS
            let durationFormatted = '0:00';
            if (item.duration) {
                const totalSeconds = Math.floor(item.duration / 1000);
                const hours = Math.floor(totalSeconds / 3600);
                const minutes = Math.floor((totalSeconds % 3600) / 60);
                const seconds = totalSeconds % 60;

                if (hours > 0) {
                    durationFormatted = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
                } else {
                    durationFormatted = `${minutes}:${String(seconds).padStart(2, '0')}`;
                }
            }

            return {
                id: item.id,
                title: item.title,
                thumbnail: item.thumbnail?.url,
                channel: item.channel?.name,
                views: item.views,
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
        const settings = db.getAllSettings(); // 모든 설정을 한번에 가져옴
        res.json({ 
            ...summary, 
            exchangeRate: settings.exchangeRate || '1400', 
            processingPaused: settings.processingPaused || 'false',
            noticeTitle: settings.notice_title || '',
            noticeContent: settings.notice_content || '',
        });
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
    logger.error('Error fetching cached videos:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/featured-videos', (req, res) => {
  try {
    const videos = db.getFeaturedVideos();
    res.json(videos);
  } catch (error) {
    logger.error('Error fetching featured videos:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to get a list of random videos for recommendation
router.get('/videos/random', (req, res) => {
    try {
        const videos = db.getRandomVideos(3); // Get 3 random videos
        res.json(videos);
    } catch (error) {
        logger.error('Failed to fetch random videos:', error);
        res.status(500).json({ error: 'Failed to fetch random videos' });
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

    try {
        // --- Check Service Settings First ---
        const processingPaused = db.getSetting('processingPaused');
        if (processingPaused === 'true') {
            logger.warn('[Processing] Blocked: Service is paused by admin.');
            sendSse('backend_error', { message: 'service_paused' });
            return res.end();
        }

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

        // Check financial balance
        const financialSummary = db.getAggregatedCosts();
        if (financialSummary.balance <= 0) {
            logger.warn(`[Processing] Video processing blocked for ${videoId} due to insufficient funds. Balance: ${financialSummary.balance}`);
            sendSse('backend_error', { message: 'funds_depleted' });
            return res.end();
        }

        // Use the refactored processor, which now includes the duration check
        await processVideo(videoId, youtubeUrl, sendSse);
        res.end();

    } catch (error) {
        // Catch errors from initial checks (e.g., DB error)
        logger.error('[Process Endpoint] Initial check failed:', error);
        sendSse('backend_error', { message: 'An unexpected error occurred on the server.' });
        return res.end();
    }
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

// --- BOARD (게시판) API ENDPOINTS ---
const boardRouter = express.Router();

// GET all posts
boardRouter.get('/posts', (req, res) => {
    try {
        const { sortBy, page, limit } = req.query;
        const posts = db.getPosts({ 
            sortBy: sortBy || 'newest',
            page: parseInt(page || '1', 10),
            limit: parseInt(limit || '15', 10)
        });
        res.json(posts);
    } catch (error) {
        logger.error('[Board] Failed to fetch posts:', error);
        res.status(500).json({ error: 'Failed to fetch posts' });
    }
});

// GET a single post by ID
boardRouter.get('/posts/:id', (req, res) => {
    try {
        const { id } = req.params;
        const post = db.getPost(id);
        if (post) {
            res.json(post);
        } else {
            res.status(404).json({ error: 'Post not found' });
        }
    } catch (error) {
        logger.error(`[Board] Failed to fetch post ${req.params.id}:`, error);
        res.status(500).json({ error: 'Failed to fetch post' });
    }
});

// POST a new post
boardRouter.post('/posts', (req, res) => {
    try {
        const { title, content, nickname, password, is_notice = false, adminPassword } = req.body;
        
        if (!title || !content || !nickname || !password) {
            return res.status(400).json({ error: '제목, 내용, 닉네임, 비밀번호는 필수입니다.' });
        }

        let isNoticeBool = Boolean(is_notice);

        if (isNoticeBool) {
            const actualAdminPassword = db.getSetting('admin_password') || 'momcenter!@#';
            if (adminPassword !== actualAdminPassword) {
                return res.status(403).json({ error: '관리자 암호가 올바르지 않아 공지글로 등록할 수 없습니다.' });
            }
        }

        const newPostId = db.createPost({ title, content, nickname, password, is_notice: isNoticeBool });
        const newPost = db.getPost(newPostId);
        res.status(201).json(newPost);
    } catch (error) {
        logger.error('[Board] Failed to create post:', error);
        res.status(500).json({ error: '글 작성 중 서버 오류가 발생했습니다.' });
    }
});

// PUT (update) a post
boardRouter.put('/posts/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, password } = req.body;

        if (!password || !title || !content) {
            return res.status(400).json({ error: 'Password, title, and content are required' });
        }

        const post = db.getPostWithPassword(id);
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const isPasswordValid = db.verifyPassword(post.password, password);
        if (!isPasswordValid) {
            return res.status(403).json({ error: 'Invalid password' });
        }

        const success = db.updatePost({ id, title, content });
        if (success) {
            res.status(200).json({ message: 'Post updated successfully' });
        } else {
            res.status(500).json({ error: 'Failed to update post' });
        }
    } catch (error) {
        logger.error(`[Board] Failed to update post ${req.params.id}:`, error);
        res.status(500).json({ error: 'Failed to update post' });
    }
});

// DELETE a post
boardRouter.delete('/posts/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'Password is required' });
        }

        const post = db.getPostWithPassword(id);
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const isPasswordValid = db.verifyPassword(post.password, password);
        if (!isPasswordValid) {
            return res.status(403).json({ error: 'Invalid password' });
        }

        const success = db.deletePost(id);
        if (success) {
            res.status(200).json({ message: 'Post deleted successfully' });
        } else {
            res.status(500).json({ error: 'Failed to delete post' });
        }
    } catch (error) {
        logger.error(`[Board] Failed to delete post ${req.params.id}:`, error);
        res.status(500).json({ error: 'Failed to delete post' });
    }
});

// POST a new comment on a post
boardRouter.post('/posts/:id/comments', (req, res) => {
    try {
        const { id: postId } = req.params;
        const { nickname, password, content } = req.body;
        if (!nickname || !password || !content) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const newCommentId = db.createPostComment({ postId, nickname, password, content });
        const newComment = db.getPostCommentById(newCommentId);
        res.status(201).json({
            id: newComment.id,
            postId: newComment.postId,
            nickname: newComment.nickname,
            content: newComment.content,
            createdAt: newComment.createdAt
        });
    } catch (error) {
        logger.error(`[Board] Failed to add comment to post ${req.params.id}:`, error);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// PUT (update) a comment on a post
boardRouter.put('/comments/:commentId', (req, res) => {
    try {
        const { commentId } = req.params;
        const { password, content } = req.body;

        if (!password || !content) {
            return res.status(400).json({ error: 'Password and content are required' });
        }

        const comment = db.getPostCommentById(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const isPasswordValid = db.verifyPassword(comment.password, password);
        if (!isPasswordValid) {
            return res.status(403).json({ error: 'Invalid password' });
        }

        const success = db.updatePostComment({ commentId, content });
        if (success) {
            res.status(200).json({ message: 'Comment updated successfully' });
        } else {
            res.status(500).json({ error: 'Failed to update comment' });
        }
    } catch (error) {
        logger.error(`[Board] Failed to update comment ${req.params.commentId}:`, error);
        res.status(500).json({ error: 'Failed to update comment' });
    }
});

// DELETE a comment on a post
boardRouter.delete('/comments/:commentId', (req, res) => {
    try {
        const { commentId } = req.params;
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'Password is required' });
        }

        const comment = db.getPostCommentById(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const isPasswordValid = db.verifyPassword(comment.password, password);
        if (!isPasswordValid) {
            return res.status(403).json({ error: 'Invalid password' });
        }

        const success = db.deletePostComment(commentId);
        if (success) {
            res.status(200).json({ message: 'Comment deleted successfully' });
        } else {
            res.status(500).json({ error: 'Failed to delete comment' });
        }
    } catch (error) {
        logger.error(`[Board] Failed to delete comment ${req.params.commentId}:`, error);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

// Mount the board router
router.use('/board', boardRouter);


// --- AUTH & ADMIN API ENDPOINTS ---

// Standalone login endpoint, not protected by adminAuth
router.post('/login', (req, res) => {
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ error: 'Password is required' });
    }
    
    const expectedPassword = db.getSetting('admin_password') || 'momcenter!@#';
    
    if (password === expectedPassword) {
        // In a real app, you'd return a JWT here.
        // For this app, we just confirm the password is correct.
        logger.info('[Auth] Admin login successful.');
        res.status(200).json({ message: 'Login successful' });
    } else {
        logger.warn('[Auth] Admin login failed: incorrect password.');
        res.status(401).json({ error: 'Incorrect password' });
    }
});


// Simple password authentication middleware for admin routes
const adminAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    // Get password from DB. Fallback to a default if not set.
    const expectedPassword = db.getSetting('admin_password') || 'momcenter!@#';

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

// GET all settings
adminRouter.get('/settings', (req, res) => {
    try {
        const settings = db.getAllSettings();
        res.json(settings);
    } catch (error) {
        logger.error('[Admin] Failed to fetch settings:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// PUT (update) password
adminRouter.put('/change-password', (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 모두 입력해야 합니다.' });
        }

        const actualCurrentPassword = db.getSetting('admin_password');
        if (currentPassword !== actualCurrentPassword) {
            return res.status(403).json({ error: '현재 비밀번호가 일치하지 않습니다.' });
        }

        db.updateSetting({ key: 'admin_password', value: newPassword });
        logger.info('[Admin] Admin password updated successfully.');
        res.status(200).json({ message: '비밀번호가 성공적으로 변경되었습니다.' });

    } catch (error) {
        logger.error('[Admin] Failed to change password:', error);
        res.status(500).json({ error: '비밀번호 변경 중 서버 오류가 발생했습니다.' });
    }
});

// PUT (update) settings
adminRouter.put('/settings', (req, res) => {
    try {
        const settingsToUpdate = req.body;
        // Do not allow password change through this endpoint
        if (settingsToUpdate.admin_password) {
            delete settingsToUpdate.admin_password;
        }

        for (const key in settingsToUpdate) {
            if (Object.hasOwnProperty.call(settingsToUpdate, key)) {
                const value = settingsToUpdate[key];
                db.updateSetting({ key, value: String(value) });
            }
        }
        logger.info('[Admin] Settings updated successfully.');
        res.status(200).json({ message: 'Settings updated successfully' });
    } catch (error) {
        logger.error('[Admin] Failed to update settings:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

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
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '20', 10);
        const search = req.query.search || null;
        const result = db.listDonations({ page, limit, search });
        res.json(result);
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
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '20', 10);
        const search = req.query.search || null;
        const sortBy = req.query.sortBy || 'createdAt';
        const sortOrder = req.query.sortOrder || 'DESC';
        const result = db.listApiCosts({ page, limit, search, sortBy, sortOrder });
        res.json(result);
    } catch (error) {
        logger.error('[Admin] Failed to fetch API costs:', error);
        res.status(500).json({ error: 'Failed to fetch API costs' });
    }
});

// GET all videos for admin (with pagination and filtering)
adminRouter.get('/videos', (req, res) => {
    try {
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '20', 10);
        const search = req.query.search || null;
        const status = req.query.status || null;

        const result = db.listAllVideosForAdmin({ page, limit, search, status });
        res.json(result);
    } catch (error) {
        logger.error('[Admin] Failed to fetch all videos:', error);
        res.status(500).json({ error: 'Failed to fetch all videos' });
    }
});

// DELETE a video
adminRouter.delete('/videos/:videoId', (req, res) => {
    try {
        const { videoId } = req.params;
        const result = db.deleteVideo(videoId);
        if (result.changes > 0) {
            logger.info(`[Admin] Deleted video ${videoId} successfully.`);
            res.status(200).json({ message: 'Video deleted successfully' });
        } else {
            res.status(404).json({ error: 'Video not found' });
        }
    } catch (error) {
        logger.error(`[Admin] Failed to delete video ${req.params.videoId}:`, error);
        res.status(500).json({ error: 'Failed to delete video' });
    }
});

// GET all comments for admin (with pagination and filtering)
adminRouter.get('/comments', (req, res) => {
    try {
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '20', 10);
        const search = req.query.search || null;

        const result = db.listAllCommentsForAdmin({ page, limit, search });
        res.json(result);
    } catch (error) {
        logger.error('[Admin] Failed to fetch all comments:', error);
        res.status(500).json({ error: 'Failed to fetch all comments' });
    }
});

// DELETE a comment by ID (admin)
adminRouter.delete('/comments/:id', (req, res) => {
    try {
        const { id } = req.params;
        const success = db.deleteCommentByIdAdmin(id);
        if (success) {
            logger.info(`[Admin] Deleted comment ${id} successfully.`);
            res.status(200).json({ message: 'Comment deleted successfully' });
        } else {
            res.status(404).json({ error: 'Comment not found' });
        }
    } catch (error) {
        logger.error(`[Admin] Failed to delete comment ${req.params.id}:`, error);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

// GET dashboard stats
adminRouter.get('/dashboard-stats', (req, res) => {
    try {
        const stats = db.getDashboardStats();
        res.json(stats);
    } catch (error) {
        logger.error('[Admin] Failed to fetch dashboard stats:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard stats' });
    }
});

// --- ADMIN BOARD API ENDPOINTS ---

// GET all posts for admin (with pagination and filtering)
adminRouter.get('/board/posts', (req, res) => {
    try {
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '20', 10);
        const search = req.query.search || null;

        const result = db.listAllPostsForAdmin({ page, limit, search });
        res.json(result);
    } catch (error) {
        logger.error('[Admin] Failed to fetch all board posts:', error);
        res.status(500).json({ error: 'Failed to fetch all board posts' });
    }
});

// DELETE a board post by ID (admin)
adminRouter.delete('/board/posts/:id', (req, res) => {
    try {
        const { id } = req.params;
        const success = db.deletePostByIdAdmin(id);
        if (success) {
            logger.info(`[Admin] Deleted board post ${id} successfully.`);
            res.status(200).json({ message: 'Board post deleted successfully' });
        } else {
            res.status(404).json({ error: 'Board post not found' });
        }
    } catch (error) {
        logger.error(`[Admin] Failed to delete board post ${req.params.id}:`, error);
        res.status(500).json({ error: 'Failed to delete board post' });
    }
});

// GET all board comments for admin (with pagination and filtering)
adminRouter.get('/board/comments', (req, res) => {
    try {
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '20', 10);
        const search = req.query.search || null;

        const result = db.listAllPostCommentsForAdmin({ page, limit, search });
        res.json(result);
    } catch (error) {
        logger.error('[Admin] Failed to fetch all board comments:', error);
        res.status(500).json({ error: 'Failed to fetch all board comments' });
    }
});

// DELETE a board comment by ID (admin)
adminRouter.delete('/board/comments/:id', (req, res) => {
    try {
        const { id } = req.params;
        const success = db.deletePostCommentByIdAdmin(id);
        if (success) {
            logger.info(`[Admin] Deleted board comment ${id} successfully.`);
            res.status(200).json({ message: 'Board comment deleted successfully' });
        } else {
            res.status(404).json({ error: 'Board comment not found' });
        }
    } catch (error) {
        logger.error(`[Admin] Failed to delete board comment ${req.params.id}:`, error);
        res.status(500).json({ error: 'Failed to delete board comment' });
    }
});

// Mount the admin router
router.use('/admin', adminRouter);


// Log donation account copy event for statistics
router.post('/log-donation-copy', (req, res) => {
    const { userAgent, timestamp } = req.body;
    logger.info(`[STATISTICS] Donation account copied. Time: ${timestamp}, UA: ${userAgent}`);
    res.status(200).json({ success: true });
});

module.exports = router;
