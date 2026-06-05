const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const logger = require('./logger');
const crypto = require('crypto');

const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'cache.db');
const db = new Database(dbPath);

// DB 초기화: 테이블 생성
function init() {
  logger.info('Initializing database...');
  // videos 테이블: 영상의 고유 정보 저장
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      videoId TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      duration INTEGER DEFAULT 0,
      filesize INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending' NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add columns if they don't exist (for backward compatibility)
  try {
    db.prepare('SELECT duration FROM videos LIMIT 1').get();
  } catch (error) {
    logger.info('Adding duration column to videos table with default value 0...');
    db.exec('ALTER TABLE videos ADD COLUMN duration INTEGER DEFAULT 0');
  }
  try {
    db.prepare('SELECT status FROM videos LIMIT 1').get();
  } catch (error) {
    logger.info('Adding status column to videos table with default value \'completed\'...');
    db.exec("ALTER TABLE videos ADD COLUMN status TEXT DEFAULT 'completed' NOT NULL");
  }
  try {
    db.prepare('SELECT fail_reason FROM videos LIMIT 1').get();
  } catch (error) {
    logger.info('Adding fail_reason column to videos table...');
    db.exec('ALTER TABLE videos ADD COLUMN fail_reason TEXT');
  }
  try {
    db.prepare('SELECT filesize FROM videos LIMIT 1').get();
  } catch (error) {
    logger.info('Adding filesize column to videos table...');
    db.exec('ALTER TABLE videos ADD COLUMN filesize INTEGER DEFAULT 0');
  }
  try {
    db.prepare('SELECT is_featured FROM videos LIMIT 1').get();
  } catch (error) {
    logger.info('Adding is_featured column to videos table with default value 0...');
    db.exec('ALTER TABLE videos ADD COLUMN is_featured INTEGER DEFAULT 0');
  }

  // scripts 테이블: 각 영상에 속한 화면 해설 스크립트 정보 저장
  db.exec(`
    CREATE TABLE IF NOT EXISTS scripts (
      id TEXT PRIMARY KEY,
      videoId TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      text TEXT NOT NULL,
      verbosity TEXT NOT NULL,
      FOREIGN KEY (videoId) REFERENCES videos (videoId) ON DELETE CASCADE
    )
  `);

  // comments 테이블: 영상에 대한 사용자 댓글 정보 저장
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      videoId TEXT NOT NULL,
      nickname TEXT NOT NULL,
      password TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (videoId) REFERENCES videos (videoId) ON DELETE CASCADE
    )
  `);

  // donations 테이블: 후원금 입금 내역 저장
  db.exec(`
    CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donator_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      donation_date DATETIME NOT NULL,
      message TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // api_costs 테이블: API 호출 비용 정보 저장
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      videoId TEXT,
      model_used TEXT NOT NULL,
      image_tokens INTEGER DEFAULT 0,
      text_tokens INTEGER DEFAULT 0,
      cost REAL NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (videoId) REFERENCES videos (videoId) ON DELETE SET NULL
    )
  `);

  // settings 테이블: 서비스 전체 설정 저장
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // 기본 설정값 추가 (존재하지 않을 경우)
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const transaction = db.transaction(() => {
    insertSetting.run('videoDurationLimit', '30'); // minutes
    insertSetting.run('processingPaused', 'false');
    insertSetting.run('exchangeRate', '1400');
    insertSetting.run('notice_title', '');
    insertSetting.run('notice_content', '');
    insertSetting.run('proxyCostPerGB', '1'); // USD per GB
    insertSetting.run('admin_password', 'momcenter!@#');
  });
  transaction();

  // posts 테이블: '와글와글 게시판'의 글(주제) 정보 저장
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      nickname TEXT NOT NULL,
      password TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // post_comments 테이블: 각 글에 대한 댓글 정보 저장
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      postId INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      password TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (postId) REFERENCES posts (id) ON DELETE CASCADE
    )
  `);

  // 'posts' 테이블에 is_notice 컬럼 추가 (없을 경우)
  try {
    db.prepare('SELECT is_notice FROM posts LIMIT 1').get();
  } catch (error) {
    logger.info('Adding is_notice column to posts table...');
    db.exec('ALTER TABLE posts ADD COLUMN is_notice INTEGER DEFAULT 0');
  }


  // users 테이블: 가입 회원 정보 저장
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      birthdate TEXT NOT NULL,
      is_blind INTEGER DEFAULT 0, -- 0: 미인증, 1: 인증완료, 2: 반려, 9: 관리자 대기
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 'users' 테이블 컬럼 누락 시 자동 추가 (하위 호환 마이그레이션)
  try {
    db.prepare('SELECT is_blind FROM users LIMIT 1').get();
  } catch (error) {
    logger.info('Adding is_blind column to users table...');
    db.exec('ALTER TABLE users ADD COLUMN is_blind INTEGER DEFAULT 0');
  }
  try {
    db.prepare('SELECT updatedAt FROM users LIMIT 1').get();
  } catch (error) {
    logger.info('Adding updatedAt column to users table...');
    db.exec('ALTER TABLE users ADD COLUMN updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP');
  }

  // user_verifications 테이블: 사용자 장애인 자격 검증 이력 저장
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      verificationMethod TEXT NOT NULL, -- 'siloam_api', 'card_ocr', 'admin_manual'
      status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
      details TEXT,
      verifiedAt DATETIME,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // 'videos' 테이블에 requested_by 컬럼 추가 (없을 경우)
  try {
    db.prepare('SELECT requested_by FROM videos LIMIT 1').get();
  } catch (error) {
    logger.info('Adding requested_by column to videos table...');
    db.exec('ALTER TABLE videos ADD COLUMN requested_by TEXT');
  }

  // 'posts' 테이블에 userId 컬럼 추가 (없을 경우)
  try {
    db.prepare('SELECT userId FROM posts LIMIT 1').get();
  } catch (error) {
    logger.info('Adding userId column to posts table...');
    db.exec('ALTER TABLE posts ADD COLUMN userId TEXT');
  }

  // 'post_comments' 테이블에 userId 컬럼 추가 (없을 경우)
  try {
    db.prepare('SELECT userId FROM post_comments LIMIT 1').get();
  } catch (error) {
    logger.info('Adding userId column to post_comments table...');
    db.exec('ALTER TABLE post_comments ADD COLUMN userId TEXT');
  }

  // user_watch_histories 테이블 신설
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_watch_histories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      videoId TEXT NOT NULL,
      watchedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (videoId) REFERENCES videos (videoId) ON DELETE CASCADE,
      UNIQUE(userId, videoId)
    )
  `);

  // user_favorites 테이블 신설
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      videoId TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (videoId) REFERENCES videos (videoId) ON DELETE CASCADE,
      UNIQUE(userId, videoId)
    )
  `);

  logger.info('Database initialized successfully.');
}

// --- Settings Functions ---
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getAllSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }
    return settings;
}

function updateSetting({ key, value }) {
    const result = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
                     .run(key, value);
    return result.changes > 0;
}

// 특정 영상 정보와 스크립트 전체를 가져오는 함수
function getVideo(videoId) {
  const videoRow = db.prepare('SELECT videoId, title, duration, filesize, status FROM videos WHERE videoId = ?').get(videoId);
  if (!videoRow) {
    return null;
  }

  const scriptRows = db.prepare('SELECT id, timestamp, text, verbosity FROM scripts WHERE videoId = ? ORDER BY timestamp').all(videoId);
  
  return {
    videoId: videoRow.videoId,
    title: videoRow.title,
    duration: videoRow.duration,
    filesize: videoRow.filesize,
    status: videoRow.status,
    script: scriptRows.map(row => ({
      ...row,
      // Ensure timestamp is a number
      timestamp: Number(row.timestamp)
    }))
  };
}

// 영상과 스크립트 정보를 DB에 저장하는 함수 (트랜잭션 사용, 배치 처리용)
function saveVideo({ videoId, title, duration, filesize, script }) {
  const transaction = db.transaction(() => {
    // Step 1: Insert or update the video record, setting status to completed.
    db.prepare(`
      INSERT INTO videos (videoId, title, duration, filesize, status)
      VALUES (?, ?, ?, ?, 'completed')
      ON CONFLICT(videoId) DO UPDATE SET
        title = excluded.title,
        duration = excluded.duration,
        filesize = excluded.filesize,
        status = 'completed'
    `).run(videoId, title, duration, filesize);

    // Step 2: Delete all old scripts for this video to ensure a clean slate.
    db.prepare('DELETE FROM scripts WHERE videoId = ?').run(videoId);

    // Step 3: Insert all the new script lines.
    if (script && script.length > 0) {
      const insertScript = db.prepare('INSERT OR IGNORE INTO scripts (id, videoId, timestamp, text, verbosity) VALUES (?, ?, ?, ?, ?)');
      for (const line of script) {
        insertScript.run(line.id, videoId, line.timestamp, line.text, line.verbosity);
      }
    }
  });

  try {
    transaction();
  } catch (error) {
    logger.error(`[Database] Failed to save video ${videoId}:`, error);
    throw error; // Re-throw the error to be handled by the caller
  }
}

// 캐시된 모든 영상의 목록을 가져오는 함수
function listVideos() {
  const rows = db.prepare(`
    SELECT 
      v.videoId, 
      v.title, 
      v.duration, 
      v.filesize,
      v.status, 
      strftime('%Y-%m-%dT%H:%M:%SZ', v.createdAt) as createdAt, 
      COUNT(c.id) as commentCount 
    FROM 
      videos AS v
    LEFT JOIN 
      comments AS c ON v.videoId = c.videoId
    WHERE
      v.status = 'completed' AND v.is_featured = 0
    GROUP BY 
      v.videoId
    ORDER BY 
      v.createdAt DESC
  `).all();
  return rows;
}

function searchVideosByTitle(query) {
  const rows = db.prepare(`
    SELECT 
      v.videoId, 
      v.title, 
      v.duration, 
      v.filesize,
      v.status, 
      strftime('%Y-%m-%dT%H:%M:%SZ', v.createdAt) as createdAt, 
      COUNT(c.id) as commentCount 
    FROM 
      videos AS v
    LEFT JOIN 
      comments AS c ON v.videoId = c.videoId
    WHERE 
      v.title LIKE ? AND v.status = 'completed'
    GROUP BY 
      v.videoId
    ORDER BY 
      v.createdAt DESC
  `).all(`%${query}%`);
  return rows;
}

function getRandomVideos(limit = 3) {
  const rows = db.prepare(`
    SELECT videoId, title 
    FROM videos 
    WHERE status = 'completed' 
    ORDER BY RANDOM() 
    LIMIT ?
  `).all(limit);
  return rows;
}

// 추천 영상 목록을 가져오는 함수
function getFeaturedVideos() {
  return db.prepare(`
    SELECT videoId, title, duration, filesize, createdAt 
    FROM videos 
    WHERE is_featured = 1 AND status = 'completed'
    ORDER BY createdAt DESC
  `).all();
}

// 처리 시작 시 호출. status를 'processing'으로 설정.
function ensureVideoRecord({ videoId, title, duration, filesize, requested_by = null }) {
  try {
    db.prepare(`
      INSERT INTO videos (videoId, title, duration, filesize, status, requested_by)
      VALUES (?, ?, ?, ?, 'processing', ?)
      ON CONFLICT(videoId) DO UPDATE SET
        title = excluded.title,
        duration = excluded.duration,
        filesize = excluded.filesize,
        status = 'processing',
        requested_by = COALESCE(excluded.requested_by, videos.requested_by)
    `).run(videoId, title, Math.round(duration), filesize, requested_by);
  } catch (error) {
    logger.error(`[Database] Failed to ensure video record for ${videoId}:`, error);
    throw error;
  }
}

// 영상 처리 상태를 업데이트하는 함수
function updateVideoStatus(videoId, status, reason = null) {
  try {
    // If status is 'failed', we store the reason. Otherwise, we clear it.
    const failReason = status === 'failed' ? reason : null;
    db.prepare('UPDATE videos SET status = ?, fail_reason = ? WHERE videoId = ?').run(status, failReason, videoId);
    logger.info(`[Database] Updated status for ${videoId} to ${status}` + (failReason ? ` with reason: ${failReason}` : ''));
  } catch (error) {
    logger.error(`[Database] Failed to update status for ${videoId}:`, error);
    throw error;
  }
}

// 임시 레코드를 먼저 생성하는 함수
function ensurePreliminaryRecord(videoId) {
    try {
        db.prepare('INSERT OR IGNORE INTO videos (videoId, title, status) VALUES (?, ?, ?)')
          .run(videoId, `(Pending) ${videoId}`, 'pending');
    } catch (error) {
        logger.error(`[Database] Failed to ensure preliminary record for ${videoId}:`, error);
        throw error; // Re-throw to be caught by the caller
    }
}

// Saves only the script lines for a given chunk.
function saveVideoChunk({ videoId, scriptChunk }) {
  const transaction = db.transaction(() => {
    // The caller is now responsible for ensuring the parent video row exists.
    const insertScript = db.prepare('INSERT OR IGNORE INTO scripts (id, videoId, timestamp, text, verbosity) VALUES (?, ?, ?, ?, ?)');
    for (const line of scriptChunk) {
      insertScript.run(line.id, videoId, line.timestamp, line.text, line.verbosity);
    }
  });

  try {
    transaction();
  } catch (error) {
    logger.error(`[Database] Failed to save chunk for video ${videoId}:`, error);
    throw error;
  }
}



// 비밀번호 해싱을 위한 유틸리티
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(storedPassword, providedPassword) {
  if (!storedPassword) return false;
  const [salt, originalHash] = storedPassword.split(':');
  if (!salt || !originalHash) return false;
  const hash = crypto.pbkdf2Sync(providedPassword, salt, 1000, 64, 'sha512').toString('hex');
  return hash === originalHash;
}


// 댓글 가져오기
function getComments(videoId) {
  return db.prepare("SELECT id, videoId, nickname, content, strftime('%Y-%m-%dT%H:%M:%SZ', createdAt) as createdAt FROM comments WHERE videoId = ? ORDER BY createdAt ASC").all(videoId);
}

// 댓글 추가
function addComment({ videoId, nickname, password, content }) {
  const hashedPassword = hashPassword(password);
  const result = db.prepare(
    'INSERT INTO comments (videoId, nickname, password, content) VALUES (?, ?, ?, ?)'
  ).run(videoId, nickname, hashedPassword, content);
  return result.lastInsertRowid;
}

// 댓글 ID로 댓글 가져오기 (비밀번호 포함)
function getCommentById(commentId) {
  return db.prepare("SELECT id, videoId, nickname, password, content, strftime('%Y-%m-%dT%H:%M:%fZ', createdAt) as createdAt FROM comments WHERE id = ?").get(commentId);
}


// 댓글 수정
function updateComment({ commentId, content }) {
  const result = db.prepare(
    'UPDATE comments SET content = ?, createdAt = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(content, commentId);
  return result.changes > 0;
}

// 댓글 삭제
function deleteComment(commentId) {
  const result = db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
  return result.changes > 0;
}

// 영상 삭제 (관련 스크립트와 댓글은 ON DELETE CASCADE로 자동 삭제됨)
function deleteVideo(videoId) {
  const result = db.prepare('DELETE FROM videos WHERE videoId = ?').run(videoId);
  return result;
}

// --- Admin Page Functions ---

// 후원금 추가
function addDonation({ donator_name, amount, donation_date, message }) {
  const result = db.prepare(
    'INSERT INTO donations (donator_name, amount, donation_date, message) VALUES (?, ?, ?, ?)'
  ).run(donator_name, amount, donation_date, message);
  return result.lastInsertRowid;
}

// 후원금 목록 조회
function listDonations({ page = 1, limit = 20, search = null }) {
  const params = [];
  const countParams = [];
  let whereClause = 'WHERE 1=1';

  if (search) {
    whereClause += ' AND (donator_name LIKE ? OR message LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm);
    countParams.push(searchTerm, searchTerm);
  }

  const countQuery = `SELECT COUNT(*) as count FROM donations ${whereClause}`;
  const totalDonations = db.prepare(countQuery).get(countParams).count;

  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const dataQuery = `
    SELECT id, donator_name, amount, strftime('%Y-%m-%dT%H:%M:%SZ', donation_date) as donation_date, message, strftime('%Y-%m-%dT%H:%M:%SZ', createdAt) as createdAt 
    FROM donations 
    ${whereClause} 
    ORDER BY donation_date DESC 
    LIMIT ? OFFSET ?`;
  
  const donations = db.prepare(dataQuery).all(params);
  return { donations, totalDonations };
}

// 후원금 삭제
function deleteDonation(id) {
  const result = db.prepare('DELETE FROM donations WHERE id = ?').run(id);
  return result.changes > 0;
}

// API 비용 추가
function addApiCost({ videoId, model_used, image_tokens, text_tokens, cost }) {
    const result = db.prepare(
        'INSERT INTO api_costs (videoId, model_used, image_tokens, text_tokens, cost) VALUES (?, ?, ?, ?, ?)'
    ).run(videoId, model_used, image_tokens, text_tokens, cost);
    return result.lastInsertRowid;
}

// API 비용 목록 조회
function listApiCosts({ page = 1, limit = 20, search = null, sortBy = 'createdAt', sortOrder = 'DESC' }) {
  const params = [];
  const countParams = [];
  let whereClause = 'WHERE 1=1';

  // Basic validation for sortBy to prevent SQL injection
  const allowedSortBy = ['createdAt', 'cost', 'videoTitle', 'model_used'];
  const safeSortBy = allowedSortBy.includes(sortBy) ? sortBy : 'createdAt';
  const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  if (search) {
    whereClause += ' AND v.title LIKE ?';
    const searchTerm = `%${search}%`;
    params.push(searchTerm);
    countParams.push(searchTerm);
  }

  const countQuery = `SELECT COUNT(*) as count FROM api_costs ac LEFT JOIN videos v ON ac.videoId = v.videoId ${whereClause}`;
  const totalCosts = db.prepare(countQuery).get(countParams).count;
  
  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const dataQuery = `
    SELECT 
        ac.id, 
        ac.videoId, 
        v.title as videoTitle,
        v.filesize,
        ac.model_used, 
        ac.image_tokens, 
        ac.text_tokens, 
        ac.cost as apiCost,
        strftime('%Y-%m-%dT%H:%M:%SZ', ac.createdAt) as createdAt 
    FROM api_costs ac
    LEFT JOIN videos v ON ac.videoId = v.videoId
    ${whereClause}
    ORDER BY ${safeSortBy} ${safeSortOrder}
    LIMIT ? OFFSET ?
  `;
  
  const costs = db.prepare(dataQuery).all(params);
  const proxyCostPerGB = parseFloat(getSetting('proxyCostPerGB') || '1');

  const results = costs.map(row => {
    const proxyCost = row.filesize ? (row.filesize / 1_000_000_000) * proxyCostPerGB : 0;
    return {
      ...row,
      proxyCost,
      totalCost: row.apiCost + proxyCost
    };
  });

  return { costs: results, totalCosts };
}

// 총 후원금 및 총 비용 집계
function getAggregatedCosts() {
    const totalDonations = db.prepare('SELECT SUM(amount) as total FROM donations').get()?.total || 0;
    const totalApiCosts = db.prepare('SELECT SUM(cost) as total FROM api_costs').get()?.total || 0;
    
    const totalFilesize = db.prepare('SELECT SUM(filesize) as total FROM videos').get()?.total || 0;
    const proxyCostPerGB = parseFloat(getSetting('proxyCostPerGB') || '1');
    const totalProxyCost = (totalFilesize / 1_000_000_000) * proxyCostPerGB;

    return {
        totalDonations,
        totalApiCosts,
        totalProxyCost,
    };
}

// 관리자용: 모든 상태의 영상 목록 가져오기 (페이지네이션 및 필터링 지원)
function listAllVideosForAdmin({ page = 1, limit = 20, search = null, status = null }) {
  const params = [];
  const countParams = [];
  let whereClause = 'WHERE 1=1';

  if (search) {
    whereClause += ' AND v.title LIKE ?';
    params.push(`%${search}%`);
    countParams.push(`%${search}%`);
  }
  if (status) {
    whereClause += ' AND v.status = ?';
    params.push(status);
    countParams.push(status);
  }

  const countQuery = `SELECT COUNT(*) as count FROM videos AS v ${whereClause}`;
  const totalVideos = db.prepare(countQuery).get(countParams).count;

  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const dataQuery = `
    SELECT 
      v.videoId, 
      v.title, 
      v.duration, 
      v.filesize,
      v.status, 
      strftime('%Y-%m-%dT%H:%M:%SZ', v.createdAt) as createdAt, 
      v.fail_reason,
      COUNT(c.id) as commentCount 
    FROM 
      videos AS v
    LEFT JOIN 
      comments AS c ON v.videoId = c.videoId
    ${whereClause}
    GROUP BY 
      v.videoId
    ORDER BY 
      v.createdAt DESC
    LIMIT ? OFFSET ?
  `;
  
  const videos = db.prepare(dataQuery).all(params);
  
  return { videos, totalVideos };
}

// 관리자용: 대시보드 통계 데이터 가져오기
function getDashboardStats() {
    const stats = {};
    const proxyCostPerGB = parseFloat(getSetting('proxyCostPerGB') || '1');

    // Core stats
    stats.totalVideos = db.prepare('SELECT COUNT(*) as count FROM videos').get().count;
    stats.totalComments = db.prepare('SELECT COUNT(*) as count FROM comments').get().count;
    
    // Videos processed by period
    stats.videosToday = db.prepare("SELECT COUNT(*) as count FROM videos WHERE date(createdAt, 'localtime') = date('now', 'localtime')").get().count;
    stats.videosThisWeek = db.prepare("SELECT COUNT(*) as count FROM videos WHERE createdAt >= date('now', '-7 days')").get().count;
    stats.videosThisMonth = db.prepare("SELECT COUNT(*) as count FROM videos WHERE createdAt >= date('now', '-30 days')").get().count;

    // API costs by period
    const apiCostToday = db.prepare("SELECT SUM(cost) as total FROM api_costs WHERE date(createdAt, 'localtime') = date('now', 'localtime')").get()?.total || 0;
    const apiCostThisWeek = db.prepare("SELECT SUM(cost) as total FROM api_costs WHERE createdAt >= date('now', '-7 days')").get()?.total || 0;
    const apiCostThisMonth = db.prepare("SELECT SUM(cost) as total FROM api_costs WHERE createdAt >= date('now', '-30 days')").get()?.total || 0;

    // Proxy costs by period
    const filesizeToday = db.prepare("SELECT SUM(filesize) as total FROM videos WHERE date(createdAt, 'localtime') = date('now', 'localtime')").get()?.total || 0;
    const filesizeThisWeek = db.prepare("SELECT SUM(filesize) as total FROM videos WHERE createdAt >= date('now', '-7 days')").get()?.total || 0;
    const filesizeThisMonth = db.prepare("SELECT SUM(filesize) as total FROM videos WHERE createdAt >= date('now', '-30 days')").get()?.total || 0;

    const proxyCostToday = (filesizeToday / 1_000_000_000) * proxyCostPerGB;
    const proxyCostThisWeek = (filesizeThisWeek / 1_000_000_000) * proxyCostPerGB;
    const proxyCostThisMonth = (filesizeThisMonth / 1_000_000_000) * proxyCostPerGB;

    stats.costs = {
        today: { api: apiCostToday, proxy: proxyCostToday, total: apiCostToday + proxyCostToday },
        week: { api: apiCostThisWeek, proxy: proxyCostThisWeek, total: apiCostThisWeek + proxyCostThisWeek },
        month: { api: apiCostThisMonth, proxy: proxyCostThisMonth, total: apiCostThisMonth + proxyCostThisMonth },
    };

    // System status
    stats.processingVideos = db.prepare("SELECT videoId, title, strftime('%Y-%m-%dT%H:%M:%SZ', createdAt) as createdAt FROM videos WHERE status = 'processing' ORDER BY createdAt DESC LIMIT 5").all();
    stats.failedVideos = db.prepare("SELECT videoId, title, strftime('%Y-%m-%dT%H:%M:%SZ', createdAt) as createdAt, fail_reason FROM videos WHERE status = 'failed' AND createdAt >= date('now', '-1 day') ORDER BY createdAt DESC LIMIT 5").all();

    return stats;
}

// 관리자용: 모든 댓글 목록 가져오기 (페이지네이션 및 필터링 지원)
function listAllCommentsForAdmin({ page = 1, limit = 20, search = null }) {
  const params = [];
  const countParams = [];
  let whereClause = 'WHERE 1=1';

  if (search) {
    whereClause += ' AND (c.nickname LIKE ? OR c.content LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm);
    countParams.push(searchTerm, searchTerm);
  }

  const countQuery = `SELECT COUNT(*) as count FROM comments AS c ${whereClause}`;
  const totalComments = db.prepare(countQuery).get(countParams).count;

  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const dataQuery = `
    SELECT
      c.id,
      c.videoId,
      v.title as videoTitle,
      c.nickname,
      c.content,
      strftime('%Y-%m-%dT%H:%M:%SZ', c.createdAt) as createdAt
    FROM
      comments AS c
    LEFT JOIN
      videos AS v ON c.videoId = v.videoId
    ${whereClause}
    ORDER BY
      c.createdAt DESC
    LIMIT ? OFFSET ?
  `;

  const comments = db.prepare(dataQuery).all(params);

  return { comments, totalComments };
}

// 관리자용: ID로 댓글 삭제
function deleteCommentByIdAdmin(commentId) {
  const result = db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
  return result.changes > 0;
}

// --- Board (게시판) Functions ---

// 새 글 작성
function createPost({ title, content, nickname, password, is_notice = false, userId = null }) {
  const hashedPassword = hashPassword(password);
  const result = db.prepare(
    'INSERT INTO posts (title, content, nickname, password, is_notice, userId) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, content, nickname, hashedPassword, is_notice ? 1 : 0, userId);
  return result.lastInsertRowid;
}

// ID로 특정 글 조회 (댓글 수 포함)
function getPost(id) {
  const post = db.prepare(`
    SELECT 
      p.id, p.title, p.content, p.nickname, strftime('%Y-%m-%dT%H:%M:%SZ', p.createdAt) as createdAt,
      (SELECT COUNT(*) FROM post_comments WHERE postId = p.id) as commentCount
    FROM posts p 
    WHERE p.id = ?
  `).get(id);
  
  if (post) {
    const comments = db.prepare(`
      SELECT id, postId, nickname, content, strftime('%Y-%m-%dT%H:%M:%SZ', createdAt) as createdAt 
      FROM post_comments 
      WHERE postId = ? 
      ORDER BY createdAt ASC
    `).all(id);
    post.comments = comments;
  }
  return post;
}

// ID로 특정 글의 비밀번호 정보까지 포함하여 조회 (수정/삭제 시 인증용)
function getPostWithPassword(id) {
    return db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
}


// 글 목록 조회 (정렬 기능 포함)
function getPosts({ sortBy = 'newest', page = 1, limit = 15 }) {
  const offset = (page - 1) * limit;
  let orderBy;

  switch (sortBy) {
    case 'comments':
      orderBy = 'commentCount DESC, p.createdAt DESC';
      break;
    case 'newest':
    default:
      orderBy = 'p.createdAt DESC';
  }

  const query = `
    SELECT 
      p.id, p.title, p.nickname, p.is_notice, strftime('%Y-%m-%dT%H:%M:%SZ', p.createdAt) as createdAt,
      (SELECT COUNT(*) FROM post_comments WHERE postId = p.id) as commentCount
    FROM posts p
    ORDER BY p.is_notice DESC, ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const posts = db.prepare(query).all(limit, offset);
  const totalPosts = db.prepare('SELECT COUNT(*) as count FROM posts').get().count;

  return { posts, totalPosts };
}

// 글 수정
function updatePost({ id, title, content }) {
  const result = db.prepare(
    'UPDATE posts SET title = ?, content = ?, createdAt = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(title, content, id);
  return result.changes > 0;
}

// 글 삭제 (연관된 댓글은 ON DELETE CASCADE로 자동 삭제됨)
function deletePost(id) {
  const result = db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  return result.changes > 0;
}

// 새 댓글 작성 (게시판용)
function createPostComment({ postId, nickname, password, content, userId = null }) {
  const hashedPassword = hashPassword(password);
  const result = db.prepare(
    'INSERT INTO post_comments (postId, nickname, password, content, userId) VALUES (?, ?, ?, ?, ?)'
  ).run(postId, nickname, hashedPassword, content, userId);
  return result.lastInsertRowid;
}

// ID로 특정 댓글 조회 (비밀번호 포함, 게시판용)
function getPostCommentById(commentId) {
  return db.prepare('SELECT * FROM post_comments WHERE id = ?').get(commentId);
}

// 댓글 수정 (게시판용)
function updatePostComment({ commentId, content }) {
  const result = db.prepare(
    'UPDATE post_comments SET content = ?, createdAt = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(content, commentId);
  return result.changes > 0;
}

// 댓글 삭제 (게시판용)
function deletePostComment(commentId) {
  const result = db.prepare('DELETE FROM post_comments WHERE id = ?').run(commentId);
  return result.changes > 0;
}

// --- Admin Board Functions ---

// 관리자용: 모든 게시글 목록 가져오기 (페이지네이션 및 필터링 지원)
function listAllPostsForAdmin({ page = 1, limit = 20, search = null }) {
  const params = [];
  const countParams = [];
  let whereClause = 'WHERE 1=1';

  if (search) {
    whereClause += ' AND (p.title LIKE ? OR p.nickname LIKE ? OR p.content LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
    countParams.push(searchTerm, searchTerm, searchTerm);
  }

  const countQuery = `SELECT COUNT(*) as count FROM posts AS p ${whereClause}`;
  const totalPosts = db.prepare(countQuery).get(countParams).count;

  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const dataQuery = `
    SELECT
      p.id,
      p.title,
      p.nickname,
      p.is_notice,
      strftime('%Y-%m-%dT%H:%M:%SZ', p.createdAt) as createdAt,
      (SELECT COUNT(*) FROM post_comments WHERE postId = p.id) as commentCount
    FROM
      posts AS p
    ${whereClause}
    ORDER BY
      p.is_notice DESC, p.createdAt DESC
    LIMIT ? OFFSET ?
  `;

  const posts = db.prepare(dataQuery).all(params);

  return { posts, totalPosts };
}

// 관리자용: 모든 게시판 댓글 목록 가져오기 (페이지네이션 및 필터링 지원)
function listAllPostCommentsForAdmin({ page = 1, limit = 20, search = null }) {
  const params = [];
  const countParams = [];
  let whereClause = 'WHERE 1=1';

  if (search) {
    whereClause += ' AND (pc.content LIKE ? OR pc.nickname LIKE ? OR p.title LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
    countParams.push(searchTerm, searchTerm, searchTerm);
  }

  const countQuery = `SELECT COUNT(*) as count FROM post_comments AS pc LEFT JOIN posts AS p ON pc.postId = p.id ${whereClause}`;
  const totalComments = db.prepare(countQuery).get(countParams).count;

  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const dataQuery = `
    SELECT
      pc.id,
      pc.postId,
      p.title as postTitle,
      pc.nickname,
      pc.content,
      strftime('%Y-%m-%dT%H:%M:%SZ', pc.createdAt) as createdAt
    FROM
      post_comments AS pc
    LEFT JOIN
      posts AS p ON pc.postId = p.id
    ${whereClause}
    ORDER BY
      pc.createdAt DESC
    LIMIT ? OFFSET ?
  `;

  const comments = db.prepare(dataQuery).all(params);

  return { comments, totalComments };
}

// 관리자용: ID로 게시글 삭제
function deletePostByIdAdmin(id) {
  const result = db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  return result.changes > 0;
}

// 관리자용: ID로 게시판 댓글 삭제
function deletePostCommentByIdAdmin(id) {
  const result = db.prepare('DELETE FROM post_comments WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- User Management Functions ---
function createUser({ id, email, password, name, phone, birthdate, is_blind }) {
  const result = db.prepare(`
    INSERT INTO users (id, email, password, name, phone, birthdate, is_blind)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, password, name, phone, birthdate, is_blind || 0);
  return result.changes > 0;
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByBio(name, birthdate) {
  return db.prepare('SELECT * FROM users WHERE name = ? AND birthdate = ?').get(name, birthdate);
}

function getUserByPhone(phone) {
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
}

function updateUserBlindStatus(userId, isBlind) {
  const transaction = db.transaction(() => {
    const userUpdate = db.prepare('UPDATE users SET is_blind = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?')
                         .run(isBlind, userId);

    if (userUpdate.changes > 0) {
      const statusMap = { 1: 'approved', 2: 'rejected' };
      const status = statusMap[isBlind];
      if (status) {
        db.prepare(`
          UPDATE user_verifications 
          SET status = ?, verifiedAt = ? 
          WHERE userId = ? AND status = 'pending'
        `).run(status, status === 'approved' ? new Date().toISOString() : null, userId);
      }
    }
    return userUpdate;
  });

  const result = transaction();
  return result.changes > 0;
}

function createUserVerification({ userId, verificationMethod, status, details, verifiedAt }) {
  const result = db.prepare(`
    INSERT INTO user_verifications (userId, verificationMethod, status, details, verifiedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, verificationMethod, status, details || null, verifiedAt || null);
  return result.changes > 0;
}

function listPendingUsers() {
  return db.prepare(`
    SELECT u.*, uv.verificationMethod, uv.status AS verificationStatus, uv.details, uv.createdAt AS verificationCreatedAt
    FROM users u
    LEFT JOIN user_verifications uv ON u.id = uv.userId
    WHERE u.is_blind = 9
    ORDER BY u.createdAt DESC
  `).all();
}

// --- MyPage Functions ---

function updateUser(userId, { name, phone }) {
  const result = db.prepare(`
    UPDATE users
    SET name = ?, phone = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, phone, userId);
  return result.changes > 0;
}

function updateUserPassword(userId, newPasswordHash) {
  const result = db.prepare(`
    UPDATE users
    SET password = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newPasswordHash, userId);
  return result.changes > 0;
}

function addWatchHistory(userId, videoId) {
  db.prepare(`
    INSERT INTO user_watch_histories (userId, videoId, watchedAt)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(userId, videoId) DO UPDATE SET watchedAt = CURRENT_TIMESTAMP
  `).run(userId, videoId);

  db.prepare(`
    DELETE FROM user_watch_histories
    WHERE userId = ? AND id NOT IN (
      SELECT id FROM user_watch_histories
      WHERE userId = ?
      ORDER BY watchedAt DESC
      LIMIT 20
    )
  `).run(userId, userId);
}

function getWatchHistory(userId) {
  return db.prepare(`
    SELECT h.watchedAt, v.videoId, v.title, v.duration, v.status
    FROM user_watch_histories h
    JOIN videos v ON h.videoId = v.videoId
    WHERE h.userId = ?
    ORDER BY h.watchedAt DESC
  `).all(userId);
}

function toggleFavorite(userId, videoId) {
  const fav = db.prepare('SELECT id FROM user_favorites WHERE userId = ? AND videoId = ?').get(userId, videoId);
  if (fav) {
    db.prepare('DELETE FROM user_favorites WHERE userId = ? AND videoId = ?').run(userId, videoId);
    return { isFavorite: false };
  } else {
    db.prepare('INSERT INTO user_favorites (userId, videoId) VALUES (?, ?)').run(userId, videoId);
    return { isFavorite: true };
  }
}

function getFavorites(userId) {
  return db.prepare(`
    SELECT f.createdAt, v.videoId, v.title, v.duration, v.status
    FROM user_favorites f
    JOIN videos v ON f.videoId = v.videoId
    WHERE f.userId = ?
    ORDER BY f.createdAt DESC
  `).all(userId);
}

function isFavorite(userId, videoId) {
  const row = db.prepare('SELECT id FROM user_favorites WHERE userId = ? AND videoId = ?').get(userId, videoId);
  return !!row;
}

function getRequestedVideosByUserId(userId) {
  return db.prepare(`
    SELECT videoId, title, duration, status, createdAt
    FROM videos
    WHERE requested_by = ?
    ORDER BY createdAt DESC
  `).all(userId);
}

function getPostsByUserId(userId) {
  return db.prepare(`
    SELECT id, title, createdAt
    FROM posts
    WHERE userId = ?
    ORDER BY createdAt DESC
  `).all(userId);
}

function getCommentsByUserId(userId) {
  return db.prepare(`
    SELECT pc.id, pc.content, pc.createdAt, pc.postId, p.title AS targetTitle, 'post' AS type
    FROM post_comments pc
    JOIN posts p ON pc.postId = p.id
    WHERE pc.userId = ?
    ORDER BY pc.createdAt DESC
  `).all(userId);
}

module.exports = {
  init,
  createUser,
  getUserByEmail,
  getUserById,
  getUserByBio,
  getUserByPhone,
  updateUserBlindStatus,
  createUserVerification,
  listPendingUsers,
  getVideo,
  saveVideo,
  ensureVideoRecord,
  updateVideoStatus,
  ensurePreliminaryRecord,
  saveVideoChunk,
  listVideos,
  searchVideosByTitle,
  getRandomVideos,
  getFeaturedVideos, // Add this
  getComments,
  addComment,
  getCommentById,
  updateComment,
  deleteComment,
  deleteVideo,
  verifyPassword,
  // Settings Functions
  getSetting,
  getAllSettings,
  updateSetting,
  // Admin functions
  addDonation,
  listDonations,
  deleteDonation,
  addApiCost,
  listApiCosts,
  getAggregatedCosts,
  listAllVideosForAdmin,
  getDashboardStats,
  listAllCommentsForAdmin,
  deleteCommentByIdAdmin,
  // MyPage operations
  updateUser,
  updateUserPassword,
  addWatchHistory,
  getWatchHistory,
  toggleFavorite,
  getFavorites,
  isFavorite,
  getRequestedVideosByUserId,
  getPostsByUserId,
  getCommentsByUserId,
  // Board functions
  createPost,
  getPost,
  getPostWithPassword,
  getPosts,
  updatePost,
  deletePost,
  createPostComment,
  getPostCommentById,
  updatePostComment,
  deletePostComment,
  // Admin Board functions
  listAllPostsForAdmin,
  listAllPostCommentsForAdmin,
  deletePostByIdAdmin,
  deletePostCommentByIdAdmin,
  db, // Export the db instance directly
};
