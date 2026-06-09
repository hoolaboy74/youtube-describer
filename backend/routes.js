const express = require('express');
const crypto = require('crypto');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { processVideo, processVideoBatch } = require('./videoProcessor');
const { 
    getYoutubeVideoId, 
    hashPassword, 
    verifyPassword, 
    verifySiloamMember, 
    verifyCardOCR 
} = require('./utils');
const logger = require('./logger');

// JWT 기반 세션 관리 설정
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'momcenter-jwt-secret-key-!!!';
const JWT_EXPIRES_IN = '30d';

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

// 인증 미들웨어: 로그인 완료된 회원만 허용 (시각장애인 여부 상관없음)
function requireAuth(req, res, next) {
    let token = null;
    const authHeader = req.headers['authorization'];
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: '로그인이 필요한 서비스입니다.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.getUserById(decoded.userId);
        if (!user) {
            return res.status(401).json({ error: '사용자를 찾을 수 없습니다. 다시 로그인해 주십시오.' });
        }
        req.user = user;
        next();
    } catch (e) {
        logger.warn('[Auth] Invalid or expired JWT token:', e.message);
        return res.status(401).json({ error: '인증 세션이 만료되었습니다. 다시 로그인해 주십시오.' });
    }
}

// 인증 미들웨어: 로그인 완료 및 시각장애인으로 인증된 회원만 허용
function requireBlindAuth(req, res, next) {
    let token = null;
    const authHeader = req.headers['authorization'];
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token; // SSE(EventSource) 헤더 미지원 우회 처리
    }

    if (!token) {
        return res.status(401).json({ error: '로그인이 필요한 서비스입니다.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.getUserById(decoded.userId);
        if (!user) {
            return res.status(401).json({ error: '사용자를 찾을 수 없습니다. 다시 로그인해 주십시오.' });
        }

        if (user.is_blind !== 1) {
            return res.status(403).json({ error: '시각장애인 인증이 완료된 회원만 신규 해설 생성이 가능합니다.' });
        }

        req.user = user;
        next();
    } catch (e) {
        logger.warn('[Auth] Invalid or expired JWT token:', e.message);
        return res.status(401).json({ error: '인증 세션이 만료되었습니다. 다시 로그인해 주십시오.' });
    }
}

// --- MAIN PROCESSING API ENDPOINT (SSE) ---
router.get('/process', requireBlindAuth, async (req, res) => {
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
        await processVideo(videoId, youtubeUrl, sendSse, req.user.id);
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
router.post('/comments', requireAuth, (req, res) => {
    try {
        const { videoId, nickname, content } = req.body;
        if (!videoId || !content) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const authorNickname = nickname || req.user.name;
        const userId = req.user.id;
        const password = 'dummy_password';

        const newCommentId = db.addComment({ videoId, userId, nickname: authorNickname, password, content });
        const newComment = db.getCommentById(newCommentId);
        // Return the newly created comment (without password)
        res.status(201).json({
            id: newComment.id,
            videoId: newComment.videoId,
            userId: newComment.userId,
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
router.put('/comments/:commentId', requireAuth, (req, res) => {
    try {
        const { commentId } = req.params;
        const { content } = req.body;

        if (!content) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const comment = db.getCommentById(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        if (!comment.userId || comment.userId !== req.user.id) {
            return res.status(403).json({ error: '본인이 작성한 댓글만 수정할 수 있습니다.' });
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
router.delete('/comments/:commentId', requireAuth, (req, res) => {
    try {
        const { commentId } = req.params;

        const comment = db.getCommentById(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        if (!comment.userId || comment.userId !== req.user.id) {
            return res.status(403).json({ error: '본인이 작성한 댓글만 삭제할 수 있습니다.' });
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
boardRouter.post('/posts', requireAuth, (req, res) => {
    try {
        const { title, content, nickname, is_notice = false, adminPassword } = req.body;
        
        if (!title || !content) {
            return res.status(400).json({ error: '제목과 내용은 필수입니다.' });
        }

        let isNoticeBool = Boolean(is_notice);

        if (isNoticeBool) {
            const actualAdminPassword = db.getSetting('admin_password') || 'momcenter!@#';
            if (adminPassword !== actualAdminPassword) {
                return res.status(403).json({ error: '관리자 암호가 올바르지 않아 공지글로 등록할 수 없습니다.' });
            }
        }

        const authorNickname = nickname || req.user.name;
        const password = 'dummy_password'; // 더미 비밀번호 설정 (DB null constraint 대응)
        const userId = req.user.id;

        const newPostId = db.createPost({ title, content, nickname: authorNickname, password, is_notice: isNoticeBool, userId });
        const newPost = db.getPost(newPostId);
        res.status(201).json(newPost);
    } catch (error) {
        logger.error('[Board] Failed to create post:', error);
        res.status(500).json({ error: '글 작성 중 서버 오류가 발생했습니다.' });
    }
});

// PUT (update) a post
boardRouter.put('/posts/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        const { title, content } = req.body;

        if (!title || !content) {
            return res.status(400).json({ error: 'Title and content are required' });
        }

        const post = db.getPostWithPassword(id);
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (!post.userId || post.userId !== req.user.id) {
            return res.status(403).json({ error: '본인이 작성한 글만 수정할 수 있습니다.' });
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
boardRouter.delete('/posts/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;

        const post = db.getPostWithPassword(id);
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (!post.userId || post.userId !== req.user.id) {
            return res.status(403).json({ error: '본인이 작성한 글만 삭제할 수 있습니다.' });
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
boardRouter.post('/posts/:id/comments', requireAuth, (req, res) => {
    try {
        const { id: postId } = req.params;
        const { content, nickname } = req.body;
        if (!content) {
            return res.status(400).json({ error: '내용은 필수입니다.' });
        }

        const authorNickname = nickname || req.user.name;
        const password = 'dummy_password';
        const userId = req.user.id;

        const newCommentId = db.createPostComment({ postId, nickname: authorNickname, password, content, userId });
        const newComment = db.getPostCommentById(newCommentId);
        res.status(201).json({
            id: newComment.id,
            postId: newComment.postId,
            nickname: newComment.nickname,
            content: newComment.content,
            createdAt: newComment.createdAt,
            userId: newComment.userId
        });
    } catch (error) {
        logger.error(`[Board] Failed to add comment to post ${req.params.id}:`, error);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// PUT (update) a comment on a post
boardRouter.put('/comments/:commentId', requireAuth, (req, res) => {
    try {
        const { commentId } = req.params;
        const { content } = req.body;

        if (!content) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const comment = db.getPostCommentById(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        if (!comment.userId || comment.userId !== req.user.id) {
            return res.status(403).json({ error: '본인이 작성한 댓글만 수정할 수 있습니다.' });
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
boardRouter.delete('/comments/:commentId', requireAuth, (req, res) => {
    try {
        const { commentId } = req.params;

        const comment = db.getPostCommentById(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        if (!comment.userId || comment.userId !== req.user.id) {
            return res.status(403).json({ error: '본인이 작성한 댓글만 삭제할 수 있습니다.' });
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

// GET list of users pending manual blind verification (is_blind = 9)
adminRouter.get('/pending-users', (req, res) => {
    try {
        const users = db.listPendingUsers();
        res.json(users);
    } catch (error) {
        logger.error('[Admin] Failed to fetch pending users:', error);
        res.status(500).json({ error: 'Failed to fetch pending users' });
    }
});

// POST approve a pending user
adminRouter.post('/users/:userId/approve', (req, res) => {
    try {
        const { userId } = req.params;
        const success = db.updateUserBlindStatus(userId, 1); // 1 = approved (blind)
        if (success) {
            logger.info(`[Admin] User ${userId} blind status approved successfully.`);
            res.json({ success: true, message: '사용자 시각장애인 인증이 승인되었습니다.' });
        } else {
            res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
        }
    } catch (error) {
        logger.error(`[Admin] Failed to approve user ${req.params.userId}:`, error);
        res.status(500).json({ error: 'Failed to approve user' });
    }
});

// POST reject a pending user
adminRouter.post('/users/:userId/reject', (req, res) => {
    try {
        const { userId } = req.params;
        const success = db.updateUserBlindStatus(userId, 2); // 2 = rejected
        if (success) {
            logger.info(`[Admin] User ${userId} blind status rejected.`);
            res.json({ success: true, message: '사용자 시각장애인 인증이 반려되었습니다.' });
        } else {
            res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
        }
    } catch (error) {
        logger.error(`[Admin] Failed to reject user ${req.params.userId}:`, error);
        res.status(500).json({ error: 'Failed to reject user' });
    }
});

// Mount the admin router
router.use('/admin', adminRouter);


// --- AUTHENTICATION API ROUTES ---

// 1. 회원가입 API (실시간 인증 포함)
router.post('/auth/register', async (req, res) => {
    const { email, password, name, phone, birthdate, pin, verificationMethod = 'siloam_api', cardImage, mimeType } = req.body;

    if (!email || !password || !name || !phone || !birthdate || !pin) {
        return res.status(400).json({ error: '필수 가입 정보가 누락되었습니다.' });
    }

    try {
        // 1단계: 이메일(ID) 중복 확인
        const existingUser = db.getUserByEmail(email);
        if (existingUser) {
            return res.status(400).json({ error: '이미 사용 중인 이메일 주소입니다.' });
        }

        // 2단계: 실명 + 생년월일 조합 중복 확인
        const existingBio = db.getUserByBio(name, birthdate);
        if (existingBio) {
            return res.status(400).json({ error: '이미 해당 정보(실명 및 생년월일)로 가입된 회원이 존재합니다.' });
        }

        // 3단계: 연락처(휴대폰 번호) 중복 확인
        const existingPhone = db.getUserByPhone(phone);
        if (existingPhone) {
            return res.status(400).json({ error: '이미 사용 중인 연락처(휴대폰 번호)입니다.' });
        }

        const userId = crypto.randomUUID();
        const hashedPassword = hashPassword(password);
        let isBlindStatus = 0; // 0: 미인증
        let verificationStatus = 'pending';
        let detailLogs = '';

        if (verificationMethod === 'siloam_api') {
            const result = await verifySiloamMember({ name, birthDate: birthdate, phoneNo: phone });
            if (result.isValid) {
                isBlindStatus = 1;
                verificationStatus = 'approved';
                detailLogs = JSON.stringify({ verifiedAt: result.verifiedAt });
            } else {
                return res.status(400).json({ error: '실로암 시각장애인 회원 정보와 일치하지 않습니다.' });
            }
        } else if (verificationMethod === 'card_ocr') {
            if (!cardImage || !mimeType) {
                return res.status(400).json({ error: '복지카드 이미지 데이터가 누락되었습니다.' });
            }

            const base64Data = cardImage.replace(/^data:image\/\w+;base64,/, "");
            const imageBuffer = Buffer.from(base64Data, 'base64');

            const ocrResult = await verifyCardOCR(imageBuffer, mimeType, name, birthdate);
            logger.info(`[Card OCR Result] Name: ${name}, Birthdate: ${birthdate}, Result: ${JSON.stringify(ocrResult)}`);
            detailLogs = JSON.stringify(ocrResult);

            if (ocrResult.isValidCard) {
                if (ocrResult.confidenceScore >= 0.85) {
                    isBlindStatus = 1;
                    verificationStatus = 'approved';
                } else {
                    isBlindStatus = 9; // 관리자 대기
                    verificationStatus = 'pending';
                }
            } else {
                return res.status(400).json({ error: '업로드된 복지카드에서 시각장애인 자격을 판독하지 못했습니다. 선명한 사진을 다시 업로드해 주세요.' });
            }
        } else {
            return res.status(400).json({ error: '지원하지 않는 인증 방식입니다.' });
        }

        const userCreated = db.createUser({
            id: userId,
            email,
            password: hashedPassword,
            name,
            phone,
            birthdate,
            is_blind: isBlindStatus,
            pin
        });

        if (!userCreated) {
            throw new Error('회원 DB 저장 실패');
        }

        db.createUserVerification({
            userId,
            verificationMethod,
            status: verificationStatus,
            details: detailLogs,
            verifiedAt: isBlindStatus === 1 ? new Date().toISOString() : null
        });

        res.status(201).json({
            success: true,
            message: isBlindStatus === 9 
                ? '회원가입이 완료되었습니다. 복지카드 수동 승인 대기 중입니다.' 
                : '시각장애인 인증 및 회원가입이 완료되었습니다.',
            isBlind: isBlindStatus
        });

    } catch (error) {
        logger.error('Registration process failed:', error);
        res.status(500).json({ error: '회원가입 처리 중 내부 서버 오류가 발생했습니다.' });
    }
});

// 2. 로그인 API
router.post('/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: '이메일과 비밀번호를 입력하십시오.' });
    }

    try {
        const user = db.getUserByEmail(email);
        if (!user || !verifyPassword(password, user.password)) {
            return res.status(401).json({ error: '이메일 또는 비밀번호가 잘못되었습니다.' });
        }

        const token = jwt.sign(
            { 
                userId: user.id, 
                email: user.email, 
                name: user.name, 
                isBlind: user.is_blind 
            }, 
            JWT_SECRET, 
            { expiresIn: JWT_EXPIRES_IN }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                isBlind: user.is_blind
            }
        });
    } catch (error) {
        logger.error('Login error:', error);
        res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
    }
});

// 2.1 회원 ID 찾기 API
router.post('/auth/find-id', (req, res) => {
    const { name, birthdate } = req.body;
    if (!name || !birthdate) {
        return res.status(400).json({ error: '이름과 생년월일을 입력하십시오.' });
    }

    try {
        const user = db.findUserEmail(name, birthdate);
        if (!user) {
            return res.status(404).json({ error: '일치하는 회원 정보가 존재하지 않습니다.' });
        }
        res.json({ success: true, email: user.email });
    } catch (error) {
        logger.error('Find ID error:', error);
        res.status(500).json({ error: '회원 ID 찾기 처리 중 오류가 발생했습니다.' });
    }
});

// 2.2 비밀번호 찾기용 인증 정보 확인 API
router.post('/auth/verify-reset-credentials', (req, res) => {
    const { name, birthdate, phone, pin } = req.body;
    if (!name || !birthdate || !phone || !pin) {
        return res.status(400).json({ error: '이름, 생년월일, 전화번호, PIN을 모두 입력하십시오.' });
    }

    try {
        const user = db.verifyUserResetCredentials(name, birthdate, phone, pin);
        if (!user) {
            return res.status(400).json({ error: '입력하신 정보와 일치하는 회원이 없거나 PIN 번호가 다릅니다.' });
        }
        res.json({ success: true, message: '인증에 성공했습니다. 새 비밀번호를 입력해주세요.' });
    } catch (error) {
        logger.error('Verify reset credentials error:', error);
        res.status(500).json({ error: '인증 확인 처리 중 오류가 발생했습니다.' });
    }
});

// 2.3 비밀번호 재설정 API
router.post('/auth/reset-password-with-pin', (req, res) => {
    const { name, birthdate, phone, pin, newPassword } = req.body;
    if (!name || !birthdate || !phone || !pin || !newPassword) {
        return res.status(400).json({ error: '모든 필수 입력 정보가 누락되었습니다.' });
    }

    try {
        const user = db.verifyUserResetCredentials(name, birthdate, phone, pin);
        if (!user) {
            return res.status(400).json({ error: '인증 정보가 올바르지 않습니다.' });
        }

        const hashedPassword = hashPassword(newPassword);
        const success = db.updateUserPassword(user.id, hashedPassword);
        if (!success) {
            return res.status(500).json({ error: '비밀번호 재설정에 실패했습니다.' });
        }

        res.json({ success: true, message: '비밀번호가 성공적으로 재설정되었습니다.' });
    } catch (error) {
        logger.error('Reset password error:', error);
        res.status(500).json({ error: '비밀번호 재설정 처리 중 오류가 발생했습니다.' });
    }
});

// 3. 로그인 정보 조회 API
router.get('/auth/me', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '로그인이 필요합니다.' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.getUserById(decoded.userId);
        if (!user) {
             return res.status(401).json({ error: '사용자를 찾을 수 없습니다.' });
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                isBlind: user.is_blind
            }
        });
    } catch (e) {
        logger.warn('[Auth] Me check failed, invalid or expired JWT token:', e.message);
        return res.status(401).json({ error: '유효하지 않거나 만료된 세션입니다.' });
    }
});

// 4. 로그아웃 API
router.post('/auth/logout', (req, res) => {
    // JWT는 무상태(Stateless)이므로 서버 메모리 삭제 처리가 불필요합니다.
    res.json({ success: true, message: '로그아웃 되었습니다.' });
});

// Log donation account copy event for statistics
router.post('/log-donation-copy', (req, res) => {
    const { userAgent, timestamp } = req.body;
    logger.info(`[STATISTICS] Donation account copied. Time: ${timestamp}, UA: ${userAgent}`);
    res.status(200).json({ success: true });
});

// --- MY PAGE API ENDPOINTS ---

// 1. 내 가입 정보 조회
router.get('/users/me', requireAuth, (req, res) => {
    res.json({
        success: true,
        user: {
            id: req.user.id,
            email: req.user.email,
            name: req.user.name,
            phone: req.user.phone,
            birthdate: req.user.birthdate,
            pin: req.user.pin,
            isBlind: req.user.is_blind,
            createdAt: req.user.createdAt
        }
    });
});

// 2. 내 가입 정보 수정
router.put('/users/me', requireAuth, (req, res) => {
    const { name, phone, pin } = req.body;
    if (!name || !phone || !pin) {
        return res.status(400).json({ error: '이름, 연락처 및 PIN 번호는 필수 입력 사항입니다.' });
    }
    if (pin.length < 4 || pin.length > 6 || /[^0-9]/.test(pin)) {
        return res.status(400).json({ error: 'PIN 번호는 4~6자리의 숫자여야 합니다.' });
    }
    
    try {
        // 휴대폰 번호 중복 확인 (본인 제외)
        const existingPhone = db.getUserByPhone(phone);
        if (existingPhone && existingPhone.id !== req.user.id) {
            return res.status(400).json({ error: '이미 사용 중인 연락처(휴대폰 번호)입니다.' });
        }
        
        const success = db.updateUser(req.user.id, { name, phone, pin });
        if (success) {
            res.json({ success: true, message: '회원 정보가 수정되었습니다.' });
        } else {
            res.status(500).json({ error: '회원 정보 수정에 실패했습니다.' });
        }
    } catch (error) {
        logger.error('[MyPage] Failed to update user info:', error);
        res.status(500).json({ error: '회원 정보 수정 중 서버 오류가 발생했습니다.' });
    }
});

// 3. 비밀번호 변경
router.put('/users/me/password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 모두 입력해주십시오.' });
    }
    
    try {
        if (!verifyPassword(currentPassword, req.user.password)) {
            return res.status(400).json({ error: '현재 비밀번호가 일치하지 않습니다.' });
        }
        
        const newPasswordHash = hashPassword(newPassword);
        const success = db.updateUserPassword(req.user.id, newPasswordHash);
        if (success) {
            res.json({ success: true, message: '비밀번호가 안전하게 변경되었습니다.' });
        } else {
            res.status(500).json({ error: '비밀번호 변경에 실패했습니다.' });
        }
    } catch (error) {
        logger.error('[MyPage] Failed to update password:', error);
        res.status(500).json({ error: '비밀번호 변경 중 서버 오류가 발생했습니다.' });
    }
});

// 4. 내가 요청한 영상 목록 조회
router.get('/users/me/videos/requested', requireAuth, (req, res) => {
    try {
        const videos = db.getRequestedVideosByUserId(req.user.id);
        res.json({ success: true, videos });
    } catch (error) {
        logger.error('[MyPage] Failed to fetch requested videos:', error);
        res.status(500).json({ error: '요청 영상 목록 조회 중 서버 오류가 발생했습니다.' });
    }
});

// 5. 최근 시청 영상 목록 조회
router.get('/users/me/videos/history', requireAuth, (req, res) => {
    try {
        const videos = db.getWatchHistory(req.user.id);
        res.json({ success: true, videos });
    } catch (error) {
        logger.error('[MyPage] Failed to fetch watch history:', error);
        res.status(500).json({ error: '최근 시청 목록 조회 중 서버 오류가 발생했습니다.' });
    }
});

// 6. 시청 기록 추가
router.post('/users/me/videos/history', requireAuth, (req, res) => {
    const { videoId } = req.body;
    if (!videoId) {
        return res.status(400).json({ error: '영상 ID가 누락되었습니다.' });
    }
    try {
        db.addWatchHistory(req.user.id, videoId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[MyPage] Failed to add watch history:', error);
        res.status(500).json({ error: '시청 기록 저장 중 서버 오류가 발생했습니다.' });
    }
});

// 7. 즐겨찾는 영상 목록 조회
router.get('/users/me/videos/favorites', requireAuth, (req, res) => {
    try {
        const videos = db.getFavorites(req.user.id);
        res.json({ success: true, videos });
    } catch (error) {
        logger.error('[MyPage] Failed to fetch favorites:', error);
        res.status(500).json({ error: '즐겨찾는 영상 목록 조회 중 서버 오류가 발생했습니다.' });
    }
});

// 8. 즐겨찾기 토글
router.post('/users/me/videos/favorites/toggle', requireAuth, (req, res) => {
    const { videoId } = req.body;
    if (!videoId) {
        return res.status(400).json({ error: '영상 ID가 누락되었습니다.' });
    }
    try {
        const result = db.toggleFavorite(req.user.id, videoId);
        const count = db.getFavoriteCount(videoId);
        res.json({ success: true, isFavorite: result.isFavorite, likeCount: count });
    } catch (error) {
        logger.error('[MyPage] Failed to toggle favorite:', error);
        res.status(500).json({ error: '즐겨찾기 상태 변경 중 서버 오류가 발생했습니다.' });
    }
});

// 9. 특정 영상 즐겨찾기 여부 확인
router.get('/users/me/videos/favorites/:videoId', requireAuth, (req, res) => {
    const { videoId } = req.params;
    try {
        const favorited = db.isFavorite(req.user.id, videoId);
        const count = db.getFavoriteCount(videoId);
        res.json({ success: true, isFavorite: favorited, likeCount: count });
    } catch (error) {
        logger.error('[MyPage] Failed to check favorite status:', error);
        res.status(500).json({ error: '즐겨찾기 상태 확인 중 서버 오류가 발생했습니다.' });
    }
});

// 10. 내가 쓴 글/댓글 모아보기
router.get('/users/me/activities', requireAuth, (req, res) => {
    try {
        const posts = db.getPostsByUserId(req.user.id);
        const comments = db.getCommentsByUserId(req.user.id);
        res.json({ success: true, posts, comments });
    } catch (error) {
        logger.error('[MyPage] Failed to fetch user activities:', error);
        res.status(500).json({ error: '활동 내역 조회 중 서버 오류가 발생했습니다.' });
    }
});

module.exports = router;
