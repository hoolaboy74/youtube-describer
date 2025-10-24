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

  logger.info('Database initialized successfully.');
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
};
