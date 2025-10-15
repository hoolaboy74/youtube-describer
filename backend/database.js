const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'db', 'cache.db');
const db = new Database(dbPath);

// DB 초기화: 테이블 생성
function init() {
  console.log('Initializing database...');
  // videos 테이블: 영상의 고유 정보 저장
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      videoId TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
  console.log('Database initialized successfully.');
}

// 특정 영상 정보와 스크립트 전체를 가져오는 함수
function getVideo(videoId) {
  const videoRow = db.prepare('SELECT videoId, title FROM videos WHERE videoId = ?').get(videoId);
  if (!videoRow) {
    return null;
  }

  const scriptRows = db.prepare('SELECT id, timestamp, text, verbosity FROM scripts WHERE videoId = ? ORDER BY timestamp').all(videoId);
  
  return {
    videoId: videoRow.videoId,
    title: videoRow.title,
    script: scriptRows.map(row => ({
      ...row,
      // Ensure timestamp is a number
      timestamp: Number(row.timestamp)
    }))
  };
}

// 영상과 스크립트 정보를 DB에 저장하는 함수 (트랜잭션 사용)
function saveVideo({ videoId, title, script }) {
  const transaction = db.transaction(() => {
    // Step 1: Ensure the parent video row exists.
    db.prepare('INSERT OR IGNORE INTO videos (videoId, title) VALUES (?, ?)')
      .run(videoId, title);

    // Step 2: Delete all old scripts for this video to ensure a clean slate.
    db.prepare('DELETE FROM scripts WHERE videoId = ?')
      .run(videoId);

    // Step 3: Insert all the new script lines.
    const insertScript = db.prepare('INSERT OR IGNORE INTO scripts (id, videoId, timestamp, text, verbosity) VALUES (?, ?, ?, ?, ?)');
    for (const line of script) {
      insertScript.run(line.id, videoId, line.timestamp, line.text, line.verbosity);
    }
  });

  try {
    transaction();
  } catch (error) {
    console.error(`[Database] Failed to save video ${videoId}:`, error);
    throw error; // Re-throw the error to be handled by the caller
  }
}

// 캐시된 모든 영상의 목록을 가져오는 함수
function listVideos() {
  const rows = db.prepare('SELECT videoId, title, createdAt FROM videos ORDER BY createdAt DESC').all();
  return rows;
}

function searchVideosByTitle(query) {
  const rows = db.prepare(
    'SELECT videoId, title, createdAt FROM videos WHERE title LIKE ? ORDER BY createdAt DESC'
  ).all(`%${query}%`);
  return rows;
}

function saveVideoChunk({ videoId, title, scriptChunk }) {
  const transaction = db.transaction(() => {
    // Step 1: Ensure the parent video row exists.
    if (title) {
        db.prepare('INSERT OR IGNORE INTO videos (videoId, title) VALUES (?, ?)')
          .run(videoId, title);
    }

    // Step 2: Insert the new script lines from the chunk.
    const insertScript = db.prepare('INSERT OR IGNORE INTO scripts (id, videoId, timestamp, text, verbosity) VALUES (?, ?, ?, ?, ?)');
    for (const line of scriptChunk) {
      insertScript.run(line.id, videoId, line.timestamp, line.text, line.verbosity);
    }
  });

  try {
    transaction();
  } catch (error) {
    console.error(`[Database] Failed to save chunk for video ${videoId}:`, error);
    throw error;
  }
}

module.exports = {
  init,
  getVideo,
  saveVideo,
  saveVideoChunk,
  listVideos,
  searchVideosByTitle,
};
