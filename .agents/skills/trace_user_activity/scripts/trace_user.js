#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const inputIdentifier = process.argv[2];
if (!inputIdentifier) {
  console.error('Error: User ID or Email parameter is required.');
  console.error('Usage: node trace_user.js [USER_ID_OR_EMAIL]');
  process.exit(1);
}

const sshHost = 'mom';

// 원격에서 실행할 JavaScript 코드 (백슬래시 이스케이프 이슈 방지를 위해 문자열 파서 사용)
const remoteScript = `
const Database = require('/app/youtube-describer/backend/node_modules/better-sqlite3');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dbPath = '/app/youtube-describer/backend/db/cache.db';
const nginxLogDir = '/var/log/nginx';
const db = new Database(dbPath);

const identifier = '${inputIdentifier}';

// 1. DB에서 유저 기본 정보 조회 (이메일 주소 형식 혹은 ID 판별 조회)
const user = identifier.includes('@')
  ? db.prepare("SELECT * FROM users WHERE email = ?").get(identifier)
  : db.prepare("SELECT * FROM users WHERE id = ?").get(identifier);

if (!user) {
  console.log(JSON.stringify({ error: "User not found" }));
  process.exit(0);
}

// 후속 조회를 위한 유효 사용자 ID 확보
const userId = user.id;
const res = { user };

// 2. DB에서 유저 활동 이력 조회
res.verifications = db.prepare("SELECT * FROM user_verifications WHERE userId = ?").all(userId);
res.watchHistories = db.prepare("SELECT w.*, v.title FROM user_watch_histories w LEFT JOIN videos v ON w.videoId = v.videoId WHERE w.userId = ?").all(userId);
res.favorites = db.prepare("SELECT f.*, v.title FROM user_favorites f LEFT JOIN videos v ON f.videoId = v.videoId WHERE f.userId = ?").all(userId);
res.comments = db.prepare("SELECT c.*, v.title FROM comments c LEFT JOIN videos v ON c.videoId = v.videoId WHERE c.userId = ?").all(userId);
res.posts = db.prepare("SELECT * FROM posts WHERE userId = ?").all(userId);
res.postComments = db.prepare("SELECT pc.*, p.title as post_title FROM post_comments pc LEFT JOIN posts p ON pc.postId = p.id WHERE pc.userId = ?").all(userId);
res.requestedVideos = db.prepare("SELECT videoId, title, status, createdAt, duration FROM videos WHERE requested_by = ?").all(userId);

// 각 요청 비디오에 대한 API 비용 조회
const requestedVideoIds = res.requestedVideos.map(v => v.videoId);
if (requestedVideoIds.length > 0) {
  const placeholders = requestedVideoIds.map(() => '?').join(',');
  res.apiCosts = db.prepare(\`SELECT * FROM api_costs WHERE videoId IN (\${placeholders})\`).all(...requestedVideoIds);
} else {
  res.apiCosts = [];
}

// 3. IP 추적 및 Nginx 로그 조회
const ips = new Set();
if (user.lastLoginIp) {
  ips.add(user.lastLoginIp);
}

let registerTimeStr = '';
if (user.createdAt) {
  const t = new Date(user.createdAt.replace(' ', 'T') + 'Z');
  const kstStr = t.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }); // "2026-07-12 11:03:15"
  const yyyy = kstStr.substring(0, 4);
  const mm = kstStr.substring(5, 7);
  const dd = kstStr.substring(8, 10);
  const hh = kstStr.substring(11, 13);
  const min = kstStr.substring(14, 16);
  const ss = kstStr.substring(17, 19);
  
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mmm = months[parseInt(mm) - 1];
  registerTimeStr = dd + '/' + mmm + '/' + yyyy + ':' + hh + ':' + min + ':' + ss;
}

// Nginx 로그 파일 목록 확보
const logFiles = [];
try {
  const files = fs.readdirSync(nginxLogDir);
  files.forEach(f => {
    if (f.startsWith('access.log')) {
      logFiles.push(path.join(nginxLogDir, f));
    }
  });
} catch (e) {}

// 이스케이프 문제를 피하기 위한 Nginx 한 줄 문자열 파서
const parseNginxLine = (line) => {
  try {
    const p1 = line.indexOf(' - - [');
    if (p1 === -1) return null;
    const ip = line.substring(0, p1);
    
    const p2 = line.indexOf('] "', p1);
    if (p2 === -1) return null;
    const dateStr = line.substring(p1 + 6, p2);
    
    const p3 = line.indexOf('" ', p2 + 2);
    if (p3 === -1) return null;
    const reqStr = line.substring(p2 + 2, p3);
    
    const remaining = line.substring(p3 + 2);
    const parts = remaining.split(' ');
    const status = parts[0];
    const size = parts[1];
    
    const refStart = remaining.indexOf(' "');
    if (refStart === -1) {
      return { ip, dateStr, reqStr, status, size, referer: '', ua: '' };
    }
    
    const refEnd = remaining.indexOf('" "', refStart + 2);
    if (refEnd === -1) {
      const referer = remaining.substring(refStart + 2, remaining.length - 1);
      return { ip, dateStr, reqStr, status, size, referer, ua: '' };
    }
    
    const referer = remaining.substring(refStart + 2, refEnd);
    const ua = remaining.substring(refEnd + 3, remaining.length - 1);
    
    return { ip, dateStr, reqStr, status, size, referer, ua };
  } catch (e) {
    return null;
  }
};

let registerIp = null;
logFiles.forEach(file => {
  try {
    let content = '';
    if (file.endsWith('.gz')) {
      content = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    } else {
      content = fs.readFileSync(file, 'utf8');
    }
    const lines = content.split('\\n');
    lines.forEach(line => {
      if (!line.trim()) return;
      const parsed = parseNginxLine(line);
      if (!parsed) return;
      
      if (registerTimeStr && parsed.dateStr.includes(registerTimeStr) && parsed.reqStr.includes('POST /api/auth/register')) {
        registerIp = parsed.ip;
        ips.add(parsed.ip);
      }
    });
  } catch (err) {}
});

res.registerIp = registerIp;

// Nginx 로그 2차 돌며 타임라인 수집
const userIps = Array.from(ips);
const nginxLogs = [];
logFiles.forEach(file => {
  try {
    let content = '';
    if (file.endsWith('.gz')) {
      content = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    } else {
      content = fs.readFileSync(file, 'utf8');
    }
    const lines = content.split('\\n');
    lines.forEach(line => {
      if (!line.trim()) return;
      const parsed = parseNginxLine(line);
      if (!parsed) return;
      
      if (userIps.includes(parsed.ip)) {
        const lowerUa = parsed.ua.toLowerCase();
        const isBot = lowerUa.includes('bot') || lowerUa.includes('spider') || lowerUa.includes('crawler');
        if (!isBot) {
          nginxLogs.push(parsed);
        }
      }
    });
  } catch (err) {}
});

// Nginx 로그 정렬 헬퍼
const parseNginxDate = (str) => {
  try {
    // str 예: "12/Jul/2026:11:03:15 +0900"
    const parts = str.split(' ')[0].split(':');
    const dateParts = parts[0].split('/');
    const d = parseInt(dateParts[0]);
    const monthStr = dateParts[1];
    const y = parseInt(dateParts[2]);
    const h = parseInt(parts[1]);
    const m = parseInt(parts[2]);
    const s = parseInt(parts[3]);
    
    const months = {
      Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11
    };
    return new Date(Date.UTC(y, months[monthStr], d, h, m, s));
  } catch (e) {
    return new Date(0);
  }
};

nginxLogs.sort((a, b) => parseNginxDate(a.dateStr) - parseNginxDate(b.dateStr));
res.nginxTrace = nginxLogs;

// 4. 백엔드 빌드 트랜잭션 로그 조회
const backendLogs = [];
const backendLogsDir = '/app/youtube-describer/backend/logs';
const mainLogFile = '/app/youtube-describer/backend/backend.log';
const videoPrefixes = requestedVideoIds.map(id => id.substring(0, 8));

const searchBackendLogFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\\n');
    lines.forEach(line => {
      let matched = false;
      videoPrefixes.forEach(pref => {
        if (line.includes(\`[\${pref}]\`)) matched = true;
      });
      if (line.includes(userId)) matched = true;
      if (matched) backendLogs.push(line);
    });
  } catch (e) {}
};

try {
  if (fs.existsSync(backendLogsDir)) {
    const files = fs.readdirSync(backendLogsDir);
    files.forEach(f => {
      searchBackendLogFile(path.join(backendLogsDir, f));
    });
  }
} catch (e) {}
searchBackendLogFile(mainLogFile);

res.backendTrace = backendLogs;

console.log(JSON.stringify(res, null, 2));
`;

console.log(`운영 서버에서 식별자 (${inputIdentifier}) 정보를 통합 추적 및 수집 중...`);

let resultJson;
try {
  // maxBuffer를 50MB로 설정하여 대용량 로그 대응
  const output = execSync(`ssh mom "node"`, { input: remoteScript, encoding: 'utf8', maxBuffer: 1024 * 1024 * 50 });
  resultJson = JSON.parse(output);
} catch (err) {
  console.error('Error executing query on remote server:', err.message);
  process.exit(1);
}

if (resultJson.error) {
  console.error(`Error: ${resultJson.error}`);
  process.exit(1);
}

const { user, verifications, watchHistories, favorites, comments, posts, postComments, requestedVideos, apiCosts, registerIp, nginxTrace, backendTrace } = resultJson;

// 시간 변환 헬퍼 (UTC -> KST 문자열)
const formatUtcToKst = (utcStr) => {
  if (!utcStr) return 'N/A';
  const t = new Date(utcStr.replace(' ', 'T') + 'Z');
  const kst = new Date(t.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().replace('T', ' ').substring(0, 19);
};

// 로그인 ID(이메일)를 리포트 파일명에 사용
const userEmail = user.email;

// 리포트 생성
let report = `사용자 정밀 감사 및 추적 보고서\n\n`;
report += `[감사 대상 정보]\n`;
report += `- 고유 식별 ID: ${user.id}\n`;
report += `- 이메일 주소: ${user.email}\n`;
report += `- 이름: ${user.name}\n`;
report += `- 전화번호: ${user.phone}\n`;
report += `- 생년월일: ${user.birthdate}\n`;
report += `- 비밀번호 PIN: ${user.pin || 'N/A'}\n`;
report += `- 계정 활성 여부: ${user.is_active === 1 ? '활성 (Active)' : '비활성 (Inactive)'}\n`;
report += `- 시각장애인 여부: ${user.is_blind === 1 ? '인증완료' : user.is_blind === 2 ? '인증반려' : user.is_blind === 9 ? '승인대기' : '미인증'}\n`;
report += `- 시각장애인 인증수단: ${user.blind_auth_method || 'N/A'}\n`;
report += `- 회원 가입 일시 (KST): ${formatUtcToKst(user.createdAt)}\n`;
report += `- 정보 수정 일시 (KST): ${formatUtcToKst(user.updatedAt)}\n`;
report += `- 최종 로그인 일시 (KST): ${user.lastLoginAt ? formatUtcToKst(user.lastLoginAt) : 'N/A'}\n`;
report += `- 최초 가입 IP: ${registerIp || 'N/A'}\n`;
report += `- 최종 로그인 IP: ${user.lastLoginIp || 'N/A'}\n\n`;

report += `[시각장애인 인증 심사 이력]\n`;
if (verifications.length > 0) {
  verifications.forEach(v => {
    report += `- 인증수단: ${v.verificationMethod}, 상태: ${v.status}, 승인시각(KST): ${v.verifiedAt ? new Date(v.verifiedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }) : 'N/A'}\n`;
    report += `  상세 내용: ${v.details}\n`;
  });
} else {
  report += `  인증 심사 기록이 존재하지 않습니다.\n`;
}
report += `\n`;

report += `[화면 해설 생성 요청 이력]\n`;
if (requestedVideos.length > 0) {
  requestedVideos.forEach(v => {
    const costInfo = apiCosts.find(c => c.videoId === v.videoId);
    const costText = costInfo ? `사용 모델: ${costInfo.model_used}, 이미지 토큰: ${costInfo.image_tokens}, 비용: $${costInfo.cost}` : '비용 기록 없음';
    report += `- 비디오 ID: ${v.videoId}\n`;
    report += `  제목: ${v.title}\n`;
    report += `  상태: ${v.status}, 영상 길이: ${v.duration}초, 요청 일시 (KST): ${formatUtcToKst(v.createdAt)}\n`;
    report += `  API 비용 요약: ${costText}\n`;
  });
} else {
  report += `  요청한 비디오 생성 기록이 없습니다.\n`;
}
report += `\n`;

report += `[콘텐츠 시청 기록 (Watch History)]\n`;
if (watchHistories.length > 0) {
  watchHistories.forEach(w => {
    report += `- 비디오 ID: ${w.videoId}, 제목: ${w.title || 'Unknown'}, 시청 일시 (KST): ${formatUtcToKst(w.watchedAt)}\n`;
  });
} else {
  report += `  콘텐츠 시청 이력이 없습니다.\n`;
}
report += `\n`;

report += `[즐겨찾기 목록 (Favorites)]\n`;
if (favorites.length > 0) {
  favorites.forEach(f => {
    report += `- 비디오 ID: ${f.videoId}, 제목: ${f.title || 'Unknown'}, 추가 일시 (KST): ${formatUtcToKst(f.createdAt)}\n`;
  });
} else {
  report += `  즐겨찾기(좋아요) 이력이 없습니다.\n`;
}
report += `\n`;

report += `[커뮤니티 소통 활동]\n`;
report += `- 영상 댓글 작성 수: ${comments.length}건\n`;
if (comments.length > 0) {
  comments.forEach(c => {
    report += `  - [댓글] 영상: ${c.title || 'Unknown'}, 내용: "${c.content}", 작성 일시: ${formatUtcToKst(c.createdAt)}\n`;
  });
}
report += `- 자유게시판 게시글 작성 수: ${posts.length}건\n`;
if (posts.length > 0) {
  posts.forEach(p => {
    report += `  - [글] 제목: "${p.title}", 작성 일시: ${formatUtcToKst(p.createdAt)}\n`;
  });
}
report += `- 자유게시판 댓글 작성 수: ${postComments.length}건\n`;
if (postComments.length > 0) {
  postComments.forEach(pc => {
    report += `  - [게시판댓글] 원글 제목: "${pc.post_title || 'Unknown'}", 내용: "${pc.content}", 작성 일시: ${formatUtcToKst(pc.createdAt)}\n`;
  });
}
report += `\n`;

report += `[백엔드 애플리케이션 상세 트랜잭션 로그]\n`;
if (backendTrace.length > 0) {
  backendTrace.forEach(line => {
    report += `  ${line}\n`;
  });
} else {
  report += `  수집된 백엔드 로그가 없습니다.\n`;
}
report += `\n`;

report += `[Nginx Access 로그 기반 타임라인 추적]\n`;
if (nginxTrace.length > 0) {
  nginxTrace.forEach(log => {
    report += `  [${log.dateStr}] IP: ${log.ip} -> ${log.reqStr} (응답: ${log.status})\n`;
    report += `  - 레퍼러: ${log.referer || 'N/A'}\n`;
    report += `  - User-Agent: ${log.ua}\n`;
  });
} else {
  report += `  수집된 Nginx 로그가 없습니다.\n`;
}

// 로컬 보고서 파일 적재 (프로젝트 루트의 user_audit 폴더)
const outDir = path.join(__dirname, '..', '..', '..', '..', 'user_audit');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}
const outputPath = path.join(outDir, `user_trace_report_${userEmail}.txt`);
fs.writeFileSync(outputPath, report, 'utf8');

console.log(`\n정밀 추적 완료. 보고서 파일이 저장되었습니다:`);
console.log(`[보고서 경로] file://${outputPath}\n`);

// 콘솔 요약 출력
console.log(`=== 회원 기본 정보 요약 ===`);
console.log(`이름/이메일: ${user.name} (${user.email})`);
console.log(`인증 상태: ${user.is_blind === 1 ? '시각장애인 인증완료' : '미인증'}`);
console.log(`가입 IP: ${registerIp || 'N/A'} | 최종 IP: ${user.lastLoginIp || 'N/A'}`);
console.log(`가입 일시: ${formatUtcToKst(user.createdAt)}`);
console.log(`활동 내역: 비디오 생성 ${requestedVideos.length}건 / 시청 ${watchHistories.length}건 / 즐겨찾기 ${favorites.length}건`);
console.log(`소통 내역: 댓글 ${comments.length}건 / 게시글 ${posts.length}건`);
console.log(`\nNginx 로그 추적 내역: 총 ${nginxTrace.length}개의 세션 활동 기록됨.`);
console.log(`\n백엔드 빌드 트랜잭션 기록: 총 ${backendTrace.length}개의 로깅 식별됨.`);
