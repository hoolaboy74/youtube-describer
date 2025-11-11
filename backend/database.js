const path = require('path');
const Database = require('better-sqlite3');
const logger = require('./logger');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'db', 'cache.db');
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
  });
  transaction();


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
  const videoRow = db.prepare('SELECT videoId, title, duration, status FROM videos WHERE videoId = ?').get(videoId);
  if (!videoRow) {
    return null;
  }

  const scriptRows = db.prepare('SELECT id, timestamp, text, verbosity FROM scripts WHERE videoId = ? ORDER BY timestamp').all(videoId);
  
  return {
    videoId: videoRow.videoId,
    title: videoRow.title,
    duration: videoRow.duration,
    status: videoRow.status,
    script: scriptRows.map(row => ({
      ...row,
      // Ensure timestamp is a number
      timestamp: Number(row.timestamp)
    }))
  };
}

// 영상과 스크립트 정보를 DB에 저장하는 함수 (트랜잭션 사용, 배치 처리용)
function saveVideo({ videoId, title, duration, script }) {
  const transaction = db.transaction(() => {
    // Step 1: Insert or update the video record, setting status to completed.
    db.prepare(`
      INSERT INTO videos (videoId, title, duration, status)
      VALUES (?, ?, ?, 'completed')
      ON CONFLICT(videoId) DO UPDATE SET
        title = excluded.title,
        duration = excluded.duration,
        status = 'completed'
    `).run(videoId, title, duration);

    // Step 2: Delete all old scripts for this video to ensure a clean slate.
    db.prepare('DELETE FROM scripts WHERE videoId = ?').run(videoId);

    // Step 3: Insert all the new script lines.
    if (script && script.length > 0) {
      const insertScript = db.prepare('INSERT INTO scripts (id, videoId, timestamp, text, verbosity) VALUES (?, ?, ?, ?, ?)');
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
      v.status, 
      v.createdAt, 
      COUNT(c.id) as commentCount 
    FROM 
      videos AS v
    LEFT JOIN 
      comments AS c ON v.videoId = c.videoId
    WHERE 
      v.status = 'completed'
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
      v.status, 
      v.createdAt, 
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

// 처리 시작 시 호출. status를 'processing'으로 설정.
function ensureVideoRecord({ videoId, title, duration }) {
  try {
    db.prepare(`
      INSERT INTO videos (videoId, title, duration, status)
      VALUES (?, ?, ?, 'processing')
      ON CONFLICT(videoId) DO UPDATE SET
        title = excluded.title,
        duration = excluded.duration,
        status = 'processing'
    `).run(videoId, title, Math.round(duration));
  } catch (error) {
    logger.error(`[Database] Failed to ensure video record for ${videoId}:`, error);
    throw error;
  }
}

// 영상 처리 상태를 업데이트하는 함수
function updateVideoStatus(videoId, status) {
  try {
    db.prepare('UPDATE videos SET status = ? WHERE videoId = ?').run(status, videoId);
    logger.info(`[Database] Updated status for ${videoId} to ${status}`);
  } catch (error) {
    logger.error(`[Database] Failed to update status for ${videoId}:`, error);
    throw error;
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
  return db.prepare("SELECT id, videoId, nickname, content, strftime('%Y-%m-%dT%H:%M:%fZ', createdAt) as createdAt FROM comments WHERE videoId = ? ORDER BY createdAt ASC").all(videoId);
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
        ac.model_used, 
        ac.image_tokens, 
        ac.text_tokens, 
        ac.cost, 
        strftime('%Y-%m-%dT%H:%M:%SZ', ac.createdAt) as createdAt 
    FROM api_costs ac
    LEFT JOIN videos v ON ac.videoId = v.videoId
    ${whereClause}
    ORDER BY ${safeSortBy} ${safeSortOrder}
    LIMIT ? OFFSET ?
  `;
  
  const costs = db.prepare(dataQuery).all(params);
  return { costs, totalCosts };
}

// 총 후원금 및 총 비용 집계
function getAggregatedCosts() {
    const totalDonations = db.prepare('SELECT SUM(amount) as total FROM donations').get()?.total || 0;
    const totalApiCosts = db.prepare('SELECT SUM(cost) as total FROM api_costs').get()?.total || 0;
    return {
        totalDonations,
        totalApiCosts,
        balance: totalDonations - totalApiCosts,
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
      v.status, 
      v.createdAt, 
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

    // Core stats
    stats.totalVideos = db.prepare('SELECT COUNT(*) as count FROM videos').get().count;
    stats.totalComments = db.prepare('SELECT COUNT(*) as count FROM comments').get().count;
    
    // Videos processed by period
    stats.videosToday = db.prepare("SELECT COUNT(*) as count FROM videos WHERE createdAt >= date('now')").get().count;
    stats.videosThisWeek = db.prepare("SELECT COUNT(*) as count FROM videos WHERE createdAt >= date('now', '-7 days')").get().count;
    stats.videosThisMonth = db.prepare("SELECT COUNT(*) as count FROM videos WHERE createdAt >= date('now', '-30 days')").get().count;

    // API costs by period
    stats.costToday = db.prepare("SELECT SUM(cost) as total FROM api_costs WHERE createdAt >= date('now')").get()?.total || 0;
    stats.costThisWeek = db.prepare("SELECT SUM(cost) as total FROM api_costs WHERE createdAt >= date('now', '-7 days')").get()?.total || 0;
    stats.costThisMonth = db.prepare("SELECT SUM(cost) as total FROM api_costs WHERE createdAt >= date('now', '-30 days')").get()?.total || 0;

    // System status
    stats.processingVideos = db.prepare("SELECT videoId, title, createdAt FROM videos WHERE status = 'processing' ORDER BY createdAt DESC LIMIT 5").all();
    stats.failedVideos = db.prepare("SELECT videoId, title, createdAt FROM videos WHERE status = 'failed' AND createdAt >= date('now', '-1 day') ORDER BY createdAt DESC LIMIT 5").all();

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
      c.createdAt
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


module.exports = {
  init,
  getVideo,
  saveVideo,
  ensureVideoRecord,
  updateVideoStatus,
  saveVideoChunk,
  listVideos,
  searchVideosByTitle,
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
};
