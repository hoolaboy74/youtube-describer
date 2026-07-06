#!/usr/bin/env node
/**
 * 운영 서버(mom)의 DB 및 Nginx access.log를 수집 및 분석하여 통합 통계 리포트를 작성하는 도구
 * 명령행 인자로 조회 기간(시작일, 종료일)을 입력받을 수 있습니다.
 * 보안 조치: 모든 조사의 하한선은 최초 회원 가입 시점 이후로 자동 제한됩니다.
 * 출력 조치: 리포트는 일반 텍스트(.txt) 형태로 prod_report/ 디렉토리에 저장됩니다.
 * 분석 고도화: 
 *   - AAU 표준 공식 고정: 재생 화면(/video/) 진입 실제 회원(DB 고유 시청) + 비회원(Nginx 고유 IP)
 *   - 일별 AAU(Daily AAU) 추이 집계 탑재
 *   - 최다 요청 회원 리스트(Top 10)에 단순 건수 외 총 영상길이와 누적 소모 API 비용을 합산 표기
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 설정값
const sshHost = 'mom';
const dbPath = '/app/youtube-describer/backend/db/cache.db';
const nginxLogDir = '/var/log/nginx';

function runRemoteNode(scriptContent) {
  const command = `ssh ${sshHost} "node"`;
  try {
    return execSync(command, { input: scriptContent, encoding: 'utf8' });
  } catch (error) {
    console.error('Remote execution failed:', error.message);
    process.exit(1);
  }
}

// 1. 명령행 인자 파싱
let inputStart = process.argv[2];
let inputEnd = process.argv[3];

function isValidDate(dateStr) {
  return !isNaN(Date.parse(dateStr));
}

// 최초 가입일(조회 절대 하한선) 확인을 위한 원격 쿼리
const setupScript = `
const Database = require('/app/youtube-describer/backend/node_modules/better-sqlite3');
const db = new Database('${dbPath}');
const minDateRow = db.prepare("SELECT MIN(createdAt) as min FROM users").get();
console.log(minDateRow ? minDateRow.min : '2026-07-02 02:27:51');
`;

let absoluteMinDate;
try {
  absoluteMinDate = runRemoteNode(setupScript).trim();
} catch (e) {
  absoluteMinDate = '2026-07-02 02:27:51';
}

// 시작일 결정 및 하한선 제한 (입력값이 최초 회원가입 이전일 경우 최초 가입일로 강제 보정)
let tempStart = inputStart && isValidDate(inputStart) ? `${inputStart} 00:00:00` : absoluteMinDate;
if (Date.parse(tempStart) < Date.parse(absoluteMinDate)) {
  tempStart = absoluteMinDate;
}
const startDate = tempStart;

// 종료일 결정
const endDate = inputEnd && isValidDate(inputEnd) ? `${inputEnd} 23:59:59` : new Date(new Date().getTime() + (9*60*60*1000)).toISOString().replace('T', ' ').substring(0, 19);

// 출력 파일명 및 경로 결정 (prod_report/ 디렉토리로 고정)
const startName = startDate.substring(0, 10).replace(/-/g, '');
const endName = endDate.substring(0, 10).replace(/-/g, '');
const reportFileName = `system_stats_report_${startName}_${endName}.txt`;
const outDir = path.join(process.cwd(), 'prod_report');
const outputPath = path.join(outDir, reportFileName);

// 2. 원격 DB 데이터 집계 스크립트 작성
const dbQueryScript = `
const Database = require('/app/youtube-describer/backend/node_modules/better-sqlite3');
const db = new Database('${dbPath}');

const startDate = '${startDate}';
const endDate = '${endDate}';

const stats = { startDate, endDate };

// 회원 수 통계
stats.newUsers = db.prepare(\`
  SELECT COUNT(*) as count FROM users WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate).count;

// 영상 생성 요약
stats.summary = db.prepare(\`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate);

stats.duration = db.prepare(\`
  SELECT 
    SUM(duration) as total_duration,
    AVG(duration) as avg_duration,
    MAX(duration) as max_duration,
    MIN(duration) as min_duration
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ? AND status = 'completed'
\`).get(startDate, endDate);

stats.longestVideo = db.prepare(\`
  SELECT videoId, title, duration
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ? AND status = 'completed' AND duration = ?
\`).get(startDate, endDate, stats.duration.max_duration || 0);

stats.shortestVideo = db.prepare(\`
  SELECT videoId, title, duration
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ? AND status = 'completed' AND duration = ?
\`).get(startDate, endDate, stats.duration.min_duration || 0);

stats.requestorStats = db.prepare(\`
  SELECT 
    SUM(CASE WHEN requested_by IS NOT NULL THEN 1 ELSE 0 END) as member_requests,
    SUM(CASE WHEN requested_by IS NULL THEN 1 ELSE 0 END) as non_member_requests
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate);

// 회원 중 최다 요청자 (총 영상길이 및 누적 API 비용 컬럼 추가 집계)
const topRequestorsRaw = db.prepare(\`
  SELECT 
    v.requested_by,
    u.name,
    u.email,
    u.is_blind,
    COUNT(*) as count,
    SUM(CASE WHEN v.status = 'completed' THEN v.duration ELSE 0 END) as total_duration,
    SUM(COALESCE(c.cost, 0)) as total_cost
  FROM videos v
  JOIN users u ON v.requested_by = u.id
  LEFT JOIN api_costs c ON v.videoId = c.videoId
  WHERE v.createdAt >= ? AND v.createdAt <= ?
  GROUP BY v.requested_by
  ORDER BY count DESC
  LIMIT 10
\`).all(startDate, endDate);

const maskName = (name) => {
  if (!name) return 'Unknown';
  if (name.length <= 1) return '*';
  if (name.length === 2) return name[0] + '*';
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1];
};
const maskEmail = (email) => {
  if (!email) return 'Unknown';
  const parts = email.split('@');
  if (parts.length !== 2) return '***';
  const [local, domain] = parts;
  if (local.length <= 3) return local[0] + '**@' + domain;
  return local.substring(0, 2) + '*'.repeat(local.length - 3) + local[local.length - 1] + '@' + domain;
};

stats.topRequestors = topRequestorsRaw.map(r => ({
  requested_by: r.requested_by ? r.requested_by.substring(0, 8) + '...' : null,
  name: maskName(r.name),
  email: maskEmail(r.email),
  is_blind: r.is_blind,
  count: r.count,
  total_duration: r.total_duration || 0,
  total_cost: r.total_cost || 0
}));

stats.dailyTrend = db.prepare(\`
  SELECT 
    strftime('%Y-%m-%d', createdAt) as date,
    COUNT(*) as total,
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ?
  GROUP BY date
  ORDER BY date ASC
\`).all(startDate, endDate);

stats.dayOfWeekDistribution = db.prepare(\`
  SELECT 
    CASE cast(strftime('%w', createdAt) as integer)
      WHEN 0 THEN '일요일'
      WHEN 1 THEN '월요일'
      WHEN 2 THEN '화요일'
      WHEN 3 THEN '수요일'
      WHEN 4 THEN '목요일'
      WHEN 5 THEN '금요일'
      WHEN 6 THEN '토요일'
    END as day_of_week,
    COUNT(*) as count
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ?
  GROUP BY strftime('%w', createdAt)
  ORDER BY strftime('%w', createdAt) ASC
\`).all(startDate, endDate);

stats.hourlyDistribution = db.prepare(\`
  SELECT 
    strftime('%H', createdAt) as hour,
    COUNT(*) as count
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ?
  GROUP BY hour
  ORDER BY hour ASC
\`).all(startDate, endDate);

stats.apiCostsTotal = db.prepare(\`
  SELECT 
    SUM(cost) as total_cost,
    SUM(image_tokens) as total_image_tokens,
    SUM(text_tokens) as total_text_tokens
  FROM api_costs
  WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate);

stats.modelCosts = db.prepare(\`
  SELECT 
    model_used,
    COUNT(*) as calls,
    SUM(cost) as cost,
    SUM(image_tokens) as image_tokens,
    SUM(text_tokens) as text_tokens
  FROM api_costs
  WHERE createdAt >= ? AND createdAt <= ?
  GROUP BY model_used
  ORDER BY cost DESC
\`).all(startDate, endDate);

stats.mostExpensiveVideos = db.prepare(\`
  SELECT 
    c.videoId,
    v.title,
    c.cost,
    c.model_used,
    c.image_tokens,
    c.text_tokens
  FROM api_costs c
  LEFT JOIN videos v ON c.videoId = v.videoId
  WHERE c.createdAt >= ? AND c.createdAt <= ?
  ORDER BY c.cost DESC
  LIMIT 5
\`).all(startDate, endDate);

stats.failureReasons = db.prepare(\`
  SELECT 
    fail_reason,
    COUNT(*) as count
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ? AND status = 'failed'
  GROUP BY fail_reason
  ORDER BY count DESC
\`).all(startDate, endDate);

// === 사용자 활동 지표 수집 ===
stats.videoComments = db.prepare(\`
  SELECT 
    COUNT(CASE WHEN userId IS NOT NULL AND userId != '' THEN 1 END) as member_count,
    COUNT(CASE WHEN userId IS NULL OR userId = '' THEN 1 END) as non_member_count
  FROM comments 
  WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate);

stats.boardPosts = db.prepare(\`
  SELECT 
    COUNT(CASE WHEN userId IS NOT NULL AND userId != '' THEN 1 END) as member_count,
    COUNT(CASE WHEN userId IS NULL OR userId = '' THEN 1 END) as non_member_count
  FROM posts 
  WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate);

stats.boardComments = db.prepare(\`
  SELECT 
    COUNT(CASE WHEN userId IS NOT NULL AND userId != '' THEN 1 END) as member_count,
    COUNT(CASE WHEN userId IS NULL OR userId = '' THEN 1 END) as non_member_count
  FROM post_comments 
  WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate);

stats.memberWatches = db.prepare(\`
  SELECT COUNT(*) as count FROM user_watch_histories WHERE watchedAt >= ? AND watchedAt <= ?
\`).get(startDate, endDate).count;

stats.memberLikes = db.prepare(\`
  SELECT COUNT(*) as count FROM user_favorites WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate).count;

stats.mostCommentedVideos = db.prepare(\`
  SELECT 
    c.videoId, 
    v.title, 
    COUNT(*) as count 
  FROM comments c
  LEFT JOIN videos v ON c.videoId = v.videoId
  WHERE c.createdAt >= ? AND c.createdAt <= ?
  GROUP BY c.videoId
  ORDER BY count DESC
  LIMIT 5
\`).all(startDate, endDate);

stats.mostWatchedVideos = db.prepare(\`
  SELECT 
    w.videoId, 
    v.title, 
    COUNT(*) as count 
  FROM user_watch_histories w
  LEFT JOIN videos v ON w.videoId = v.videoId
  WHERE w.watchedAt >= ? AND w.watchedAt <= ?
  GROUP BY w.videoId
  ORDER BY count DESC
  LIMIT 5
\`).all(startDate, endDate);

// 회원들의 lastLoginIp 목록 (Nginx 분석 보강용)
const loginIpsRaw = db.prepare("SELECT DISTINCT lastLoginIp FROM users WHERE lastLoginIp IS NOT NULL").all();
stats.loginIps = loginIpsRaw.map(r => r.lastLoginIp);

// DB 기반 실제 시청 활동 고유 회원수 (100% 정밀 보장)
stats.uniqueActiveMembers = db.prepare(\`
  SELECT COUNT(DISTINCT userId) as count 
  FROM user_watch_histories 
  WHERE watchedAt >= ? AND watchedAt <= ?
\`).get(startDate, endDate).count;

// 일별 DB 기반 실제 시청 활성 회원수
stats.dailyActiveMembers = db.prepare(\`
  SELECT 
    strftime('%Y-%m-%d', watchedAt) as date,
    COUNT(DISTINCT userId) as count
  FROM user_watch_histories
  WHERE watchedAt >= ? AND watchedAt <= ?
  GROUP BY date
  ORDER BY date ASC
\`).all(startDate, endDate);

console.log(JSON.stringify(stats));
`;

console.log(`최초 회원 가입 시점(조회 하한선): ${absoluteMinDate}`);
console.log(`최종 조회 범위 지정: ${startDate} ~ ${endDate}`);
console.log('운영 서버(DB)로부터 생성 및 활동 데이터 수집 중...');
const dbResult = JSON.parse(runRemoteNode(dbQueryScript));

// DB에서 수집한 회원 IP 목록을 Nginx 파싱 스크립트에 주입
const dbMemberIpsJson = JSON.stringify(dbResult.loginIps || []);

// 3. 원격 Nginx 로그 집계 스크립트 작성 (고유 IP 방문 분석 및 강화된 비인간 트래픽 필터 포함)
const nginxQueryScript = `
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const logDir = '${nginxLogDir}';
const minTime = new Date('${startDate.replace(' ', 'T')}+09:00'); 
const maxTime = new Date('${endDate.replace(' ', 'T')}+09:00');
const dbMemberIps = ${dbMemberIpsJson};

const files = fs.readdirSync(logDir)
  .filter(f => f.startsWith('access.log'))
  .map(f => path.join(logDir, f));

let mobileCount = 0;
let pcCount = 0;
let botCount = 0;

// 트래픽 및 고유 IP 분석용
const memberIps = new Set(dbMemberIps); // DB의 lastLoginIp 목록으로 초기화
let memberTrafficCount = 0;
let nonMemberTrafficCount = 0;

const homeMemberIps = new Set();
const videoMemberIps = new Set();
const homeNonMemberIps = new Set();
const videoNonMemberIps = new Set();

// 일별 고유 비회원 재생 IP 수집
const dailyNonMemberIps = {};

const userAgentStats = {
  mobile: {},
  pc: {}
};

const logRegex = /^([^\\s]+) - - \\[([^\\]]+)\\] "([^"]+)" (\\d+) (\\d+) "([^"]*)" "([^"]*)"/;

function collectMemberIps(line) {
  const match = line.match(logRegex);
  if (!match) return;
  const [,, dateStr, reqStr] = match;
  
  // 로그인/회원 정보를 체크하는 API 접근자 IP를 회원 풀에 추가 수집
  if (reqStr.includes('/api/auth/') || reqStr.includes('/api/users/me')) {
    const ip = match[1];
    memberIps.add(ip);
  }
}

function parseLogLine(line) {
  const match = line.match(logRegex);
  if (!match) return;
  
  const [ip,, dateStr, reqStr,, sizeStr,, ua] = match;
  
  const dateParts = dateStr.split(' ');
  const [d, m, y, h, min, s] = dateParts[0].split(/:|\\//);
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  };
  const logDate = new Date(Date.UTC(parseInt(y), months[m], parseInt(d), parseInt(h), parseInt(min), parseInt(s)));
  
  const tzOffset = dateParts[1];
  const tzSign = tzOffset[0] === '+' ? 1 : -1;
  const tzHours = parseInt(tzOffset.substring(1, 3));
  const tzMins = parseInt(tzOffset.substring(3, 5));
  const offsetMs = (tzHours * 60 + tzMins) * 60 * 1000 * tzSign;
  const logDateKst = new Date(logDate.getTime() - offsetMs + (9 * 60 * 60 * 1000));
  
  if (logDateKst < minTime || logDateKst > maxTime) return;
  
  const isApiOrVideo = reqStr.includes('/api/process') || 
                       reqStr.includes('/api/tts') || 
                       reqStr.includes('/api/script/') || 
                       reqStr.includes('/video/');
                       
  const reqParts = reqStr.split(' ');
  const method = reqParts[0];
  const rawUrl = reqParts[1] ? reqParts[1].split('?')[0] : '';
  
  const isHome = method === 'GET' && (rawUrl === '/' || rawUrl === '/index.html');
  const isVideo = method === 'GET' && rawUrl.startsWith('/video/');

  // 강화된 봇 및 비인간 클라이언트 필터링
  const lowerUa = ua.toLowerCase();
  const isBot = lowerUa.includes('bot') || 
                lowerUa.includes('spider') || 
                lowerUa.includes('crawler') || 
                lowerUa.includes('slurp') || 
                lowerUa.includes('curl') || 
                lowerUa.includes('wget') ||
                lowerUa.includes('python') || 
                lowerUa.includes('requests') ||
                lowerUa.includes('http-client') || 
                lowerUa.includes('headless') || 
                lowerUa.includes('puppeteer') || 
                lowerUa.includes('playwright') || 
                lowerUa.includes('axios') || 
                lowerUa.includes('postman') ||
                lowerUa.includes('fetch');

  if (isBot) {
    botCount++;
    return;
  }
  
  // 홈 및 상세(재생) 화면 방문 고유 IP 분류 적립
  if (isHome) {
    if (memberIps.has(ip)) homeMemberIps.add(ip);
    else homeNonMemberIps.add(ip);
  }
  if (isVideo) {
    if (memberIps.has(ip)) {
      videoMemberIps.add(ip);
    } else {
      videoNonMemberIps.add(ip);
      
      // 일자별 비회원 IP 수집 (KST 기준 날짜 파악)
      const dateStr = logDateKst.toISOString().substring(0, 10);
      if (!dailyNonMemberIps[dateStr]) {
        dailyNonMemberIps[dateStr] = new Set();
      }
      dailyNonMemberIps[dateStr].add(ip);
    }
  }

  if (isApiOrVideo) {
    if (memberIps.has(ip)) {
      memberTrafficCount++;
    } else {
      nonMemberTrafficCount++;
    }
  }

  const isMobile = /android|iphone|ipad|ipod|iemobile|opera mini|blackberry|mobile/i.test(ua);
  if (isMobile && isApiOrVideo) {
    mobileCount++;
    let device = 'Android Mobile';
    if (/iphone/i.test(ua)) device = 'iPhone';
    else if (/ipad/i.test(ua)) device = 'iPad';
    userAgentStats.mobile[device] = (userAgentStats.mobile[device] || 0) + 1;
  } else if (isApiOrVideo) {
    pcCount++;
    let os = 'Windows PC';
    if (/macintosh|mac os x/i.test(ua)) os = 'macOS (Mac)';
    else if (/linux/i.test(ua)) os = 'Linux PC';
    userAgentStats.pc[os] = (userAgentStats.pc[os] || 0) + 1;
  }
}

files.forEach(file => {
  try {
    let content = '';
    if (file.endsWith('.gz')) {
      content = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    } else {
      content = fs.readFileSync(file, 'utf8');
    }
    const lines = content.split('\\n');
    
    for (const line of lines) {
      if (line.trim()) collectMemberIps(line);
    }
    for (const line of lines) {
      if (line.trim()) parseLogLine(line);
    }
  } catch (err) {}
});

// 일별 고유 비회원 IP 셋의 크기를 맵으로 변경
const dailyNonMembers = {};
Object.entries(dailyNonMemberIps).forEach(([date, ipSet]) => {
  dailyNonMembers[date] = ipSet.size;
});

console.log(JSON.stringify({ 
  mobileCount, 
  pcCount, 
  botCount, 
  memberTrafficCount, 
  nonMemberTrafficCount,
  uniqueVisits: {
    homeMember: homeMemberIps.size,
    homeNonMember: homeNonMemberIps.size,
    videoMember: videoMemberIps.size,
    videoNonMember: videoNonMemberIps.size
  },
  dailyNonMembers,
  stats: userAgentStats 
}));
`;

console.log('운영 서버(Nginx 로그)로부터 트래픽 및 고유 IP 데이터 수집 중...');
const uaResult = JSON.parse(runRemoteNode(nginxQueryScript));

console.log('통계 통합 분석 보고서 작성 중...');

// 4. 리포트 작성
let txtContent = `운영 서버 영상 생성 및 플랫폼 접속 통계 보고서\n\n`;
txtContent += `1. 개요 및 요약\n`;
txtContent += `조회 설정 기간: ${startDate} ~ ${endDate}\n`;
txtContent += `최초 회원가입 시점 (조회 절대 하한선): ${absoluteMinDate}\n`;
txtContent += `총 영상 생성 요청 수: ${dbResult.summary.total}건\n`;
if (dbResult.summary.total > 0) {
  txtContent += `성공 건수: ${dbResult.summary.completed}건 (성공률 ${((dbResult.summary.completed / dbResult.summary.total) * 100).toFixed(1)}%)\n`;
  txtContent += `실패 건수: ${dbResult.summary.failed}건 (실패율 ${((dbResult.summary.failed / dbResult.summary.total) * 100).toFixed(1)}%)\n`;
} else {
  txtContent += `성공 건수: 0건\n`;
  txtContent += `실패 건수: 0건\n`;
}
txtContent += `대기 중 건수: ${dbResult.summary.pending}건\n\n`;

txtContent += `2. 생성 영상 재생 시간 통계 (성공 비디오 기준)\n`;
if (dbResult.duration && dbResult.duration.total_duration) {
  const totalHours = Math.floor(dbResult.duration.total_duration / 3600);
  const totalMins = Math.floor((dbResult.duration.total_duration % 3600) / 60);
  const totalSecs = dbResult.duration.total_duration % 60;
  txtContent += `총 누적 해설 영상 시간: ${dbResult.duration.total_duration}초 (약 ${totalHours}시간 ${totalMins}분 ${totalSecs}초)\n`;
  const avgMins = Math.floor(dbResult.duration.avg_duration / 60);
  const avgSecs = Math.round(dbResult.duration.avg_duration % 60);
  txtContent += `평균 영상 길이: ${dbResult.duration.avg_duration.toFixed(1)}초 (약 ${avgMins}분 ${avgSecs}초)\n`;
} else {
  txtContent += `총 누적 해설 영상 시간: 0초\n`;
  txtContent += `평균 영상 길이: 0초\n`;
}
if (dbResult.longestVideo && dbResult.longestVideo.duration) {
  const maxMins = Math.floor(dbResult.longestVideo.duration / 60);
  const maxSecs = dbResult.longestVideo.duration % 60;
  txtContent += `최장 해설 영상: ${dbResult.longestVideo.title} (ID: ${dbResult.longestVideo.videoId}, ${dbResult.longestVideo.duration}초 / 약 ${maxMins}분 ${maxSecs}초)\n`;
}
if (dbResult.shortestVideo && dbResult.shortestVideo.duration) {
  txtContent += `최단 해설 영상: ${dbResult.shortestVideo.title} (ID: ${dbResult.shortestVideo.videoId}, ${dbResult.shortestVideo.duration}초)\n`;
}
txtContent += `\n`;

txtContent += `3. 영상 생성 요청자 분석 (회원 vs 비회원)\n`;
if (dbResult.summary.total > 0) {
  const memberReqPct = ((dbResult.requestorStats.member_requests / dbResult.summary.total) * 100).toFixed(1);
  const nonMemberReqPct = ((dbResult.requestorStats.non_member_requests / dbResult.summary.total) * 100).toFixed(1);
  txtContent += `회원 생성 요청: ${dbResult.requestorStats.member_requests}건 (${memberReqPct}%)\n`;
  txtContent += `비회원 생성 요청: ${dbResult.requestorStats.non_member_requests}건 (${nonMemberReqPct}%)\n`;
} else {
  txtContent += `회원 생성 요청: 0건\n`;
  txtContent += `비회원 생성 요청: 0건\n`;
}
txtContent += `최다 요청 회원 리스트 (Top 10):\n`;
if (dbResult.topRequestors && dbResult.topRequestors.length > 0) {
  dbResult.topRequestors.forEach((req, idx) => {
    const blindStatus = req.is_blind === 1 ? '시각장애인 인증' : '미인증';
    const totalMins = Math.floor(req.total_duration / 60);
    const totalSecs = req.total_duration % 60;
    txtContent += `  ${idx + 1}위: ${req.name} (ID: ${req.requested_by}, 이메일: ${req.email}, ${blindStatus})\n`;
    txtContent += `        - 요청 건수: ${req.count}건, 총 영상길이: ${req.total_duration.toLocaleString()}초 (약 ${totalMins}분 ${totalSecs}초), 누적 비용: $${req.total_cost.toFixed(3)}\n`;
  });
} else {
  txtContent += `  해당 기간 활동 회원 없음\n`;
}
txtContent += `\n`;

const totalUa = uaResult.mobileCount + uaResult.pcCount;
txtContent += `4. 기기 플랫폼 및 OS 접속 통계 (Nginx 로그 기반)\n`;
if (totalUa > 0) {
  const mobilePct = ((uaResult.mobileCount / totalUa) * 100).toFixed(1);
  const pcPct = ((uaResult.pcCount / totalUa) * 100).toFixed(1);
  txtContent += `모바일 (Mobile/Tablet): ${uaResult.mobileCount}건 (${mobilePct}%)\n`;
  txtContent += `데스크톱 (PC): ${uaResult.pcCount}건 (${pcPct}%)\n`;
  txtContent += `세부 플랫폼 정보:\n`;
  txtContent += `  모바일 디바이스:\n`;
  Object.entries(uaResult.stats.mobile).forEach(([device, count]) => {
    const pct = ((count / uaResult.mobileCount) * 100).toFixed(1);
    txtContent += `    ${device}: ${count}건 (${pct}%)\n`;
  });
  txtContent += `  데스크톱 OS:\n`;
  Object.entries(uaResult.stats.pc).forEach(([os, count]) => {
    const pct = ((count / uaResult.pcCount) * 100).toFixed(1);
    txtContent += `    ${os}: ${count}건 (${pct}%)\n`;
  });
} else {
  txtContent += `해당 기간 수집된 클라이언트 트래픽 로그 없음\n`;
}
txtContent += `\n`;

txtContent += `5. 사용자 서비스 활성 및 소통 지표 (회원 vs 비회원)\n`;
txtContent += `해당 기간 신규 가입 회원 수: ${dbResult.newUsers}명\n`;
txtContent += `영상 댓글 활동:\n`;
const totalVidComm = dbResult.videoComments.member_count + dbResult.videoComments.non_member_count;
txtContent += `  총 영상 댓글 수: ${totalVidComm}건\n`;
txtContent += `  회원 작성 댓글: ${dbResult.videoComments.member_count}건\n`;
txtContent += `  비회원 작성 댓글: ${dbResult.videoComments.non_member_count}건\n`;

txtContent += `커뮤니티 게시판 활동:\n`;
const totalPosts = dbResult.boardPosts.member_count + dbResult.boardPosts.non_member_count;
txtContent += `  총 등록된 게시글: ${totalPosts}건\n`;
txtContent += `  회원 작성 게시글: ${dbResult.boardPosts.member_count}건\n`;
txtContent += `  비회원 작성 게시글: ${dbResult.boardPosts.non_member_count}건\n`;

const totalBoardComm = dbResult.boardComments.member_count + dbResult.boardComments.non_member_count;
txtContent += `  총 등록된 게시판 댓글: ${totalBoardComm}건\n`;
txtContent += `  회원 작성 게시판 댓글: ${dbResult.boardComments.member_count}건\n`;
txtContent += `  비회원 작성 게시판 댓글: ${dbResult.boardComments.non_member_count}건\n`;

txtContent += `로그인 회원 전용 인터랙션:\n`;
txtContent += `  로그인 유저 총 비디오 시청 횟수: ${dbResult.memberWatches}건\n`;
txtContent += `  로그인 유저 좋아요 클릭 수: ${dbResult.memberLikes}건\n`;

const totalWebTraffic = uaResult.memberTrafficCount + uaResult.nonMemberTrafficCount;
if (totalWebTraffic > 0) {
  const memberTrafficPct = ((uaResult.memberTrafficCount / totalWebTraffic) * 100).toFixed(1);
  const nonMemberTrafficPct = ((uaResult.nonMemberTrafficCount / totalWebTraffic) * 100).toFixed(1);
  txtContent += `웹 트래픽 유입 비율 (Nginx 로그 IP 연계):\n`;
  txtContent += `  로그인 회원 추정 트래픽: ${uaResult.memberTrafficCount}건 (${memberTrafficPct}%)\n`;
  txtContent += `  비회원 추정 트래픽: ${uaResult.nonMemberTrafficCount}건 (${nonMemberTrafficPct}%)\n`;
}
txtContent += `\n`;

txtContent += `6. 고유 IP 기반 화면 방문 분석 (Nginx 로그 연계 - 비인간 트래픽 필터 적용)\n`;
txtContent += `홈 화면 (/) 고유 방문자 수:\n`;
txtContent += `  회원 고유 IP 수: ${uaResult.uniqueVisits.homeMember}개\n`;
txtContent += `  비회원 고유 IP 수: ${uaResult.uniqueVisits.homeNonMember}개\n`;
txtContent += `재생 화면 (/video/:id) 고유 방문자 수:\n`;
txtContent += `  회원 고유 IP 수: ${uaResult.uniqueVisits.videoMember}개\n`;
txtContent += `  비회원 고유 IP 수: ${uaResult.uniqueVisits.videoNonMember}개\n`;

if (uaResult.uniqueVisits.homeNonMember > 0) {
  const convRate = ((uaResult.uniqueVisits.videoNonMember / uaResult.uniqueVisits.homeNonMember) * 100).toFixed(1);
  txtContent += `비회원 재생 페이지 전환율 (홈 방문 대비 재생 화면 도달율):\n`;
  txtContent += `  전환율: ${convRate}%\n`;
}
txtContent += `\n`;

// === 실제 활성 사용자(Actual Active Users) 분석 단락 ===
const actualActiveMembers = dbResult.uniqueActiveMembers;
const estimatedActiveNonMembers = uaResult.uniqueVisits.videoNonMember;
const actualActiveUsers = actualActiveMembers + estimatedActiveNonMembers;

txtContent += `7. 실제 활성 사용자 분석 (Actual Active Users)\n`;
txtContent += `* 정의: 재생 화면(/video/:id)에 도달하여 실제로 해설을 시청한 고유 회원(DB 이력 기준) 및 비회원(Nginx 고유 IP 기준)의 합산\n`;
txtContent += `총 실제 활성 사용자 수: ${actualActiveUsers}명\n`;
if (actualActiveUsers > 0) {
  const activeMemPct = ((actualActiveMembers / actualActiveUsers) * 100).toFixed(1);
  const activeNonMemPct = ((estimatedActiveNonMembers / actualActiveUsers) * 100).toFixed(1);
  txtContent += `  실제 활성 회원 수 (DB 시청 이력 검증): ${actualActiveMembers}명 (${activeMemPct}%)\n`;
  txtContent += `  추정 활성 비회원 수 (Nginx 고유 IP 기반): ${estimatedActiveNonMembers}명 (${activeNonMemPct}%)\n`;
  
  if (actualActiveMembers > 0) {
    const avgWatch = (dbResult.memberWatches / actualActiveMembers).toFixed(1);
    txtContent += `  활성 회원 1인당 평균 시청 횟수: ${avgWatch}회 (회원 총 시청 ${dbResult.memberWatches}건 / 활성 회원 ${actualActiveMembers}명)\n`;
  } else {
    txtContent += `  활성 회원 1인당 평균 시청 횟수: 0.0회\n`;
  }
} else {
  txtContent += `  해당 기간 재생 진입 유저 없음\n`;
}
txtContent += `\n`;

// === 일별 실제 활성 사용자(Daily AAU) 추이 ===
txtContent += `8. 일별 실제 활성 사용자(Daily AAU) 추이\n`;
const allDates = new Set();
dbResult.dailyActiveMembers.forEach(d => allDates.add(d.date));
Object.keys(uaResult.dailyNonMembers).forEach(d => allDates.add(d));
const sortedDates = Array.from(allDates).sort();

if (sortedDates.length > 0) {
  sortedDates.forEach(date => {
    const dailyMemRow = dbResult.dailyActiveMembers.find(d => d.date === date);
    const dailyMemCount = dailyMemRow ? dailyMemRow.count : 0;
    const dailyNonMemCount = uaResult.dailyNonMembers[date] || 0;
    const dailyAauCount = dailyMemCount + dailyNonMemCount;
    txtContent += `  일자: ${date} - 총 ${dailyAauCount}명 (활성 회원 ${dailyMemCount}명, 활성 비회원 ${dailyNonMemCount}명)\n`;
  });
} else {
  txtContent += `  해당 기간 활성 사용자 추이 데이터 없음\n`;
}
txtContent += `\n`;

txtContent += `9. 콘텐츠 인기 소통 지표\n`;
txtContent += `가장 많은 댓글 소통이 일어난 영상 Top 5:\n`;
if (dbResult.mostCommentedVideos && dbResult.mostCommentedVideos.length > 0) {
  dbResult.mostCommentedVideos.forEach((v, idx) => {
    txtContent += `  ${idx + 1}위: ${v.title || 'Unknown'} (ID: ${v.videoId}) - 댓글 ${v.count}개\n`;
  });
} else {
  txtContent += `  해당 기간 소통 이력 없음\n`;
}

txtContent += `가장 시청이 많이 이루어진 인기 영상 Top 5 (회원 시청 이력 기준):\n`;
if (dbResult.mostWatchedVideos && dbResult.mostWatchedVideos.length > 0) {
  dbResult.mostWatchedVideos.forEach((v, idx) => {
    txtContent += `  ${idx + 1}위: ${v.title || 'Unknown'} (ID: ${v.videoId}) - 시청 ${v.count}회\n`;
  });
} else {
  txtContent += `  해당 기간 시청 이력 없음\n`;
}
txtContent += `\n`;

txtContent += `10. 일별 생성 요청 추이\n`;
if (dbResult.dailyTrend && dbResult.dailyTrend.length > 0) {
  dbResult.dailyTrend.forEach(trend => {
    txtContent += `일자: ${trend.date} - 총 ${trend.total}건 (성공 ${trend.completed}건, 실패 ${trend.failed}건)\n`;
  });
} else {
  txtContent += `해당 기간 생성 요청 이력 없음\n`;
}
txtContent += `\n`;

txtContent += `11. 요일별 및 시간대별 요청 분포\n`;
txtContent += `요일별 현황:\n`;
if (dbResult.dayOfWeekDistribution && dbResult.dayOfWeekDistribution.length > 0) {
  dbResult.dayOfWeekDistribution.forEach(dow => {
    txtContent += `  ${dow.day_of_week}: ${dow.count}건\n`;
  });
} else {
  txtContent += `  이력 없음\n`;
}
txtContent += `시간대별 현황 (요청 집중도):\n`;
if (dbResult.hourlyDistribution && dbResult.hourlyDistribution.length > 0) {
  dbResult.hourlyDistribution.forEach(h => {
    txtContent += `  ${h.hour}시: ${h.count}건\n`;
  });
} else {
  txtContent += `  이력 없음\n`;
}
txtContent += `\n`;

txtContent += `12. AI API 사용 비용 통계\n`;
if (dbResult.apiCostsTotal && dbResult.apiCostsTotal.total_cost) {
  txtContent += `누적 API 비용: $${dbResult.apiCostsTotal.total_cost.toFixed(3)}\n`;
  txtContent += `누적 토큰: 이미지 토큰 ${dbResult.apiCostsTotal.total_image_tokens.toLocaleString()} / 텍스트 토큰 ${dbResult.apiCostsTotal.total_text_tokens.toLocaleString()}\n`;
} else {
  txtContent += `누적 API 비용: $0.000\n`;
}
txtContent += `사용 모델별 비용 현황:\n`;
if (dbResult.modelCosts && dbResult.modelCosts.length > 0) {
  dbResult.modelCosts.forEach(mc => {
    txtContent += `  ${mc.model_used}: ${mc.calls}회 호출, $${mc.cost.toFixed(3)} (이미지 토큰 ${mc.image_tokens.toLocaleString()}, 텍스트 토큰 ${mc.text_tokens.toLocaleString()})\n`;
  });
} else {
  txtContent += `  사용 이력 없음\n`;
}
txtContent += `최고 비용 발생 영상 Top 5:\n`;
if (dbResult.mostExpensiveVideos && dbResult.mostExpensiveVideos.length > 0) {
  dbResult.mostExpensiveVideos.forEach((v, idx) => {
    txtContent += `  ${idx + 1}위: ${v.title || 'Unknown'} (ID: ${v.videoId}) - $${v.cost.toFixed(3)} (이미지 ${v.image_tokens.toLocaleString()}, 텍스트 ${v.text_tokens.toLocaleString()})\n`;
  });
} else {
  txtContent += `  비용 발생 이력 없음\n`;
}
txtContent += `\n`;

txtContent += `13. 실패 사유 분석 및 빈도\n`;
if (dbResult.failureReasons && dbResult.failureReasons.length > 0) {
  dbResult.failureReasons.forEach(fr => {
    const reasonClean = fr.fail_reason.replace(/\n/g, ' ');
    txtContent += `사유: ${reasonClean} - ${fr.count}건\n`;
  });
} else {
  txtContent += `해당 기간 실패 이력 없음\n`;
}

// prod_report/ 디렉토리 존재 확인 및 없으면 자동 생성
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

fs.writeFileSync(outputPath, txtContent, 'utf8');
console.log(`보고서 생성이 완료되었습니다: ${outputPath}`);
