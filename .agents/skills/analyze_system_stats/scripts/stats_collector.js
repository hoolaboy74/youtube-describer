#!/usr/bin/env node
/**
 * 운영 서버(mom)의 DB, Nginx 로그, 백엔드 로그, TTS 캐시 디스크 상태를 종합 수집 및 분석하여 고도화된 통합 통계 리포트를 작성하는 도구
 * 명령행 인자로 조회 기간(시작일, 종료일)을 입력받을 수 있습니다.
 * 보안 조치: 모든 조사의 하한선은 최초 회원 가입 시점 이후로 자동 제한됩니다.
 * 출력 조치: 리포트는 일반 텍스트(.txt) 형태로 prod_report/ 디렉토리에 저장됩니다.
 * 시각 장애인 접근성 최적화: 스크린리더 오독 방지를 위해 연속된 대시/언더바/기호 구분선을 전면 배제하고, 공백과 번호 매기기로 구조화합니다.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 설정값
const sshHost = 'mom';
const dbPath = '/app/youtube-describer/backend/db/cache.db';
const nginxLogDir = '/var/log/nginx';
const backendLogDir = '/app/youtube-describer/backend/logs';
const ttsCacheDir = '/app/youtube-describer/backend/public/audio/tts_cache';

function runRemoteNode(scriptContent) {
  const command = `ssh ${sshHost} "node"`;
  try {
    return execSync(command, { input: scriptContent, encoding: 'utf8' });
  } catch (error) {
    console.error('Remote execution failed:', error.message);
    process.exit(1);
  }
}

// 1. 명령행 인자 파싱 및 기본값 설정
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

// 원격 통합 통계 수집 스크립트 작성
const remoteQueryScript = `
const Database = require('/app/youtube-describer/backend/node_modules/better-sqlite3');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const dbPath = '${dbPath}';
const nginxLogDir = '${nginxLogDir}';
const backendLogDir = '${backendLogDir}';
const ttsCacheDir = '${ttsCacheDir}';
const startDate = '${startDate}';
const endDate = '${endDate}';

// Date 객체 파싱 (KST로 매핑하기 위해 +09:00 보정)
const minTime = new Date('${startDate.replace(' ', 'T')}+09:00'); 
const maxTime = new Date('${endDate.replace(' ', 'T')}+09:00');

const db = new Database(dbPath);
const results = {
  db: { startDate, endDate },
  nginx: {},
  backendLogs: {
    total: 0,
    info: 0,
    warn: 0,
    error: 0,
    frequentErrors: {}
  },
  ttsDisk: {}
};

// ==========================================
// 1. 데이터베이스(SQLite) 기반 통계 수집
// ==========================================

// 신규 회원 통계
results.db.newUsers = db.prepare(\`
  SELECT COUNT(*) as count FROM users WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate).count;

// 신규 가입자 인증 경로별 통계
results.db.newUsersByAuthMethod = db.prepare(\`
  SELECT COALESCE(blind_auth_method, 'unverified') as method, COUNT(*) as count 
  FROM users 
  WHERE createdAt >= ? AND createdAt <= ?
  GROUP BY method
\`).all(startDate, endDate);

// 누적 회원 인증 경로별 통계 (전체 기간)
results.db.totalUsersByAuthMethod = db.prepare(\`
  SELECT COALESCE(blind_auth_method, 'unverified') as method, COUNT(*) as count 
  FROM users 
  GROUP BY method
\`).all();

// 회원 그룹별 서비스 가입 분포 (전체 기간)
results.db.userSegmentDistribution = db.prepare(\`
  SELECT 
    CASE is_blind
      WHEN 1 THEN '시각장애인 인증 회원'
      WHEN 9 THEN '관리자 승인 대기 회원'
      WHEN 0 THEN '미인증 회원'
      WHEN 2 THEN '반려 회원'
      ELSE '기타'
    END as group_name,
    COUNT(*) as count
  FROM users
  GROUP BY is_blind
\`).all();

// 영상 생성 요약
results.db.summary = db.prepare(\`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate);

results.db.duration = db.prepare(\`
  SELECT 
    SUM(duration) as total_duration,
    AVG(duration) as avg_duration,
    MAX(duration) as max_duration,
    MIN(duration) as min_duration
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ? AND status = 'completed'
\`).get(startDate, endDate);

results.db.longestVideo = db.prepare(\`
  SELECT videoId, title, duration
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ? AND status = 'completed' AND duration = ?
\`).get(startDate, endDate, results.db.duration.max_duration || 0);

results.db.shortestVideo = db.prepare(\`
  SELECT videoId, title, duration
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ? AND status = 'completed' AND duration = ?
\`).get(startDate, endDate, results.db.duration.min_duration || 0);

results.db.requestorStats = db.prepare(\`
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
    u.blind_auth_method,
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

results.db.topRequestors = topRequestorsRaw.map(r => ({
  requested_by: r.requested_by ? r.requested_by.substring(0, 8) + '...' : null,
  name: maskName(r.name),
  email: maskEmail(r.email),
  is_blind: r.is_blind,
  blind_auth_method: r.blind_auth_method,
  count: r.count,
  total_duration: r.total_duration || 0,
  total_cost: r.total_cost || 0
}));

results.db.dailyTrend = db.prepare(\`
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

results.db.dayOfWeekDistribution = db.prepare(\`
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

results.db.hourlyDistribution = db.prepare(\`
  SELECT 
    strftime('%H', createdAt) as hour,
    COUNT(*) as count
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ?
  GROUP BY hour
  ORDER BY hour ASC
\`).all(startDate, endDate);

results.db.apiCostsTotal = db.prepare(\`
  SELECT 
    SUM(cost) as total_cost,
    SUM(image_tokens) as total_image_tokens,
    SUM(text_tokens) as total_text_tokens
  FROM api_costs
  WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate);

results.db.modelCosts = db.prepare(\`
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

results.db.mostExpensiveVideos = db.prepare(\`
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

results.db.failureReasons = db.prepare(\`
  SELECT 
    fail_reason,
    COUNT(*) as count
  FROM videos
  WHERE createdAt >= ? AND createdAt <= ? AND status = 'failed'
  GROUP BY fail_reason
  ORDER BY count DESC
\`).all(startDate, endDate);

// 사용자 활동 지표 수집
results.db.videoComments = db.prepare(\`
  SELECT 
    COUNT(CASE WHEN userId IS NOT NULL AND userId != '' THEN 1 END) as member_count,
    COUNT(CASE WHEN userId IS NULL OR userId = '' THEN 1 END) as non_member_count
  FROM comments 
  WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate);

results.db.boardPosts = db.prepare(\`
  SELECT 
    COUNT(CASE WHEN userId IS NOT NULL AND userId != '' THEN 1 END) as member_count,
    COUNT(CASE WHEN userId IS NULL OR userId = '' THEN 1 END) as non_member_count
  FROM posts 
  WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate);

results.db.boardComments = db.prepare(\`
  SELECT 
    COUNT(CASE WHEN userId IS NOT NULL AND userId != '' THEN 1 END) as member_count,
    COUNT(CASE WHEN userId IS NULL OR userId = '' THEN 1 END) as non_member_count
  FROM post_comments 
  WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate);

results.db.memberWatches = db.prepare(\`
  SELECT COUNT(*) as count FROM user_watch_histories WHERE watchedAt >= ? AND watchedAt <= ?
\`).get(startDate, endDate).count;

results.db.memberLikes = db.prepare(\`
  SELECT COUNT(*) as count FROM user_favorites WHERE createdAt >= ? AND createdAt <= ?
\`).get(startDate, endDate).count;

results.db.mostCommentedVideos = db.prepare(\`
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

results.db.mostWatchedVideos = db.prepare(\`
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

// 교차 상관 검증 (대안 3)을 위한 시청 로그 수집
results.db.watchLogs = db.prepare(\`
  SELECT userId, videoId, strftime('%Y-%m-%dT%H:%M:%SZ', watchedAt) as watchedAt 
  FROM user_watch_histories 
  WHERE watchedAt >= ? AND watchedAt <= ?
  ORDER BY watchedAt ASC
\`).all(startDate, endDate);

// 회원들의 lastLoginIp 목록 (Nginx 분석 보강용)
const loginIpsRaw = db.prepare("SELECT DISTINCT lastLoginIp FROM users WHERE lastLoginIp IS NOT NULL").all();
const loginIps = loginIpsRaw.map(r => r.lastLoginIp);

// DB 기반 실제 시청 활동 고유 회원수
results.db.uniqueActiveMembers = db.prepare(\`
  SELECT COUNT(DISTINCT userId) as count 
  FROM user_watch_histories 
  WHERE watchedAt >= ? AND watchedAt <= ?
\`).get(startDate, endDate).count;

// 일별 DB 기반 실제 시청 활성 회원수
results.db.dailyActiveMembers = db.prepare(\`
  SELECT 
    strftime('%Y-%m-%d', watchedAt) as date,
    COUNT(DISTINCT userId) as count
  FROM user_watch_histories
  WHERE watchedAt >= ? AND watchedAt <= ?
  GROUP BY date
  ORDER BY date ASC
\`).all(startDate, endDate);

// 고도화 1: 비디오 생성 소요 시간(빌드 처리 지연) 통계
results.db.buildLatency = db.prepare(\`
  SELECT 
    COUNT(*) as count,
    AVG(strftime('%s', c.createdAt) - strftime('%s', v.createdAt)) as avg_latency,
    MAX(strftime('%s', c.createdAt) - strftime('%s', v.createdAt)) as max_latency,
    MIN(strftime('%s', c.createdAt) - strftime('%s', v.createdAt)) as min_latency
  FROM videos v
  JOIN api_costs c ON v.videoId = c.videoId
  WHERE v.status = 'completed' AND v.createdAt >= ? AND v.createdAt <= ?
    AND (strftime('%s', c.createdAt) - strftime('%s', v.createdAt)) BETWEEN 0 AND 10800
\`).get(startDate, endDate);

results.db.buildLatencyOutliers = db.prepare(\`
  SELECT COUNT(*) as count
  FROM videos v
  JOIN api_costs c ON v.videoId = c.videoId
  WHERE v.status = 'completed' AND v.createdAt >= ? AND v.createdAt <= ?
    AND (strftime('%s', c.createdAt) - strftime('%s', v.createdAt)) > 10800
\`).get(startDate, endDate).count;

results.db.costMissingCount = db.prepare(\`
  SELECT COUNT(*) as count 
  FROM videos v
  LEFT JOIN api_costs c ON v.videoId = c.videoId
  WHERE v.status = 'completed' AND v.createdAt >= ? AND v.createdAt <= ? 
    AND (c.cost IS NULL OR c.cost = 0)
\`).get(startDate, endDate).count;


// 고도화 2: 세분화된 회원 그룹별 서비스 가용 분포 및 활동량 분석
results.db.videoRequestsBySegment = db.prepare(\`
  SELECT 
    CASE COALESCE(u.is_blind, 0)
      WHEN 1 THEN '시각장애인 인증 회원'
      WHEN 9 THEN '관리자 승인 대기 회원'
      WHEN 0 THEN '미인증 회원'
      WHEN 2 THEN '반려 회원'
      ELSE '기타'
    END as group_name,
    COUNT(*) as count
  FROM videos v
  LEFT JOIN users u ON v.requested_by = u.id
  WHERE v.createdAt >= ? AND v.createdAt <= ?
  GROUP BY group_name
\`).all(startDate, endDate);

results.db.commentsBySegment = db.prepare(\`
  SELECT 
    CASE COALESCE(u.is_blind, 0)
      WHEN 1 THEN '시각장애인 인증 회원'
      WHEN 9 THEN '관리자 승인 대기 회원'
      WHEN 0 THEN '미인증 회원'
      WHEN 2 THEN '반려 회원'
      ELSE '기타'
    END as group_name,
    COUNT(*) as count
  FROM comments c
  LEFT JOIN users u ON c.userId = u.id
  WHERE c.createdAt >= ? AND c.createdAt <= ?
  GROUP BY group_name
\`).all(startDate, endDate);

results.db.watchesBySegment = db.prepare(\`
  SELECT 
    CASE COALESCE(u.is_blind, 0)
      WHEN 1 THEN '시각장애인 인증 회원'
      WHEN 9 THEN '관리자 승인 대기 회원'
      WHEN 0 THEN '미인증 회원'
      WHEN 2 THEN '반려 회원'
      ELSE '기타'
    END as group_name,
    COUNT(*) as count
  FROM user_watch_histories w
  LEFT JOIN users u ON w.userId = u.id
  WHERE w.watchedAt >= ? AND w.watchedAt <= ?
  GROUP BY group_name
\`).all(startDate, endDate);


// ==========================================
// 2. Nginx access.log 기반 트래픽/사용자 분석
// ==========================================

// 교차 상관 검증 (대안 3) 시청 로그 배열 로드
const watchLogs = results.db.watchLogs.map(log => ({
  userId: log.userId,
  videoId: log.videoId,
  time: new Date(log.watchedAt.replace(' ', 'T') + 'Z') // UTC 명시 파싱
}));

const nginxFiles = fs.readdirSync(nginxLogDir)
  .filter(f => f.startsWith('access.log'))
  .map(f => path.join(nginxLogDir, f));

let mobileCount = 0;
let pcCount = 0;
let botCount = 0;
let memberTrafficCount = 0;
let nonMemberTrafficCount = 0;
let ttsRequestCount = 0; // TTS API 요청 횟수 수집 고도화

const memberIps = new Set(loginIps);
const homeMemberIps = new Set();
const videoMemberIps = new Set();
const homeNonMemberIps = new Set();
const videoNonMemberIps = new Set();
const dailyNonMemberIps = {};
const ipDailyRequestStats = {}; // 일자별 IP별 비회원 요청 빈도 누적 (2차 행동 봇 감지용)
const ipApiOrVideoRequestCount = {}; // IP별 실제 API/Video 요청 빈도 누적

const userAgentStats = { mobile: {}, pc: {} };

// 고도화 3: Nginx 기반 인기 검색어 랭킹, HTTP 상태 코드 분석, 총 전송량, IP별 랭킹 수집용 변수
const searchKeywords = {};
const statusStats = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
const specificErrors = {};
let totalBytes = 0;
const ipStats = {};

const logRegex = /^([^\\s]+) - - \\[([^\\]]+)\\] "([^"]+)" (\\d+) (\\d+) "([^"]*)" "([^"]*)"/;

function collectMemberIps(line) {
  const match = line.match(logRegex);
  if (!match) return;
  const ip = match[1];
  const reqStr = match[3];
  if (reqStr.includes('/api/auth/') || reqStr.includes('/api/users/me')) {
    memberIps.add(ip);
  }
}

function parseLogLine(line) {
  const match = line.match(logRegex);
  if (!match) return;
  
  const ip = match[1];
  const dateStr = match[2];
  const reqStr = match[3];
  const status = match[4];
  const sizeStr = match[5];
  const ua = match[7];
  
  // Nginx 로그 날짜 파싱 (예: 14/Jul/2026:13:22:36 +0900)
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
  
  const size = parseInt(sizeStr) || 0;
  totalBytes += size;
  
  // IP별 요청 건수 및 전송량 집계
  if (!ipStats[ip]) {
    ipStats[ip] = { count: 0, bytes: 0 };
  }
  ipStats[ip].count++;
  ipStats[ip].bytes += size;

  // HTTP 상태 코드 집계
  const statusGroup = status.substring(0, 1) + 'xx';
  if (statusStats[statusGroup] !== undefined) {
    statusStats[statusGroup]++;
  } else {
    statusStats[statusGroup] = 1;
  }
  if (status.startsWith('4') || status.startsWith('5')) {
    specificErrors[status] = (specificErrors[status] || 0) + 1;
  }

  // TTS 요청 카운트 집계
  if (reqStr.includes('/api/tts')) {
    ttsRequestCount++;
  }

  // 검색어 분석
  if (reqStr.includes('/api/search')) {
    const reqParts = reqStr.split(' ');
    const urlObj = reqParts[1] ? reqParts[1].split('?') : [];
    if (urlObj[1]) {
      const params = urlObj[1].split('&');
      let queryVal = '';
      for (const param of params) {
        const [k, v] = param.split('=');
        if ((k === 'q' || k === 'query') && v) {
          try {
            queryVal = decodeURIComponent(v.replace(/\\+/g, ' ')).trim();
          } catch(e) {
            queryVal = v;
          }
          break;
        }
      }
      if (queryVal) {
        searchKeywords[queryVal] = (searchKeywords[queryVal] || 0) + 1;
      }
    }
  }

  // 봇 및 비인간 클라이언트 필터링 (확장된 봇 키워드)
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
                lowerUa.includes('fetch') ||
                lowerUa.includes('zgrab') ||
                lowerUa.includes('censys') ||
                lowerUa.includes('shodan') ||
                lowerUa.includes('nmap') ||
                lowerUa.includes('masscan') ||
                lowerUa.includes('bytespider') ||
                lowerUa.includes('mj12bot') ||
                lowerUa.includes('semrush') ||
                lowerUa.includes('ahrefs') ||
                lowerUa.includes('dotbot') ||
                lowerUa.includes('exabot') ||
                lowerUa.includes('yandex') ||
                lowerUa.includes('petalbot') ||
                lowerUa.includes('screaming') ||
                lowerUa.includes('blexbot') ||
                lowerUa.includes('sogou') ||
                lowerUa.includes('baidu') ||
                lowerUa.includes('coccoc') ||
                lowerUa.includes('go-http-client') ||
                lowerUa.includes('okhttp') ||
                lowerUa.includes('perl') ||
                lowerUa.includes('ruby') ||
                lowerUa.includes('faraday') ||
                lowerUa.includes('java') ||
                lowerUa.includes('lwp-trivial') ||
                lowerUa.includes('colossus');

  if (isBot) {
    botCount++;
    return;
  }

  // 비회원인 경우 일자별 IP 요청 횟수 카운팅 (2차 행동 기반 봇 판정용)
  if (!memberIps.has(ip)) {
    const dateStr = logDateKst.toISOString().substring(0, 10);
    if (!ipDailyRequestStats[dateStr]) {
      ipDailyRequestStats[dateStr] = {};
    }
    ipDailyRequestStats[dateStr][ip] = (ipDailyRequestStats[dateStr][ip] || 0) + 1;
  }
  
  const isApiOrVideo = reqStr.includes('/api/process') || 
                       reqStr.includes('/api/tts') || 
                       reqStr.includes('/api/script/') || 
                       reqStr.includes('/video/');
                       
  const reqParts = reqStr.split(' ');
  const method = reqParts[0];
  const rawUrl = reqParts[1] ? reqParts[1].split('?')[0] : '';
  
  const isHome = method === 'GET' && (rawUrl === '/' || rawUrl === '/index.html');
  const isVideo = method === 'GET' && rawUrl.startsWith('/video/');

  if (isHome) {
    if (memberIps.has(ip)) homeMemberIps.add(ip);
    else homeNonMemberIps.add(ip);
  }
  if (isVideo) {
    const targetVideoId = rawUrl.substring(7);
    // 교차 상관 검증 (대안 3): 비회원 IP 진입 시점과 DB 시청 이력 시점을 비교하여 동적 회원 IP 판정
    if (!memberIps.has(ip)) {
      const logTimeUtc = logDate.getTime();
      const match = watchLogs.find(w => 
        w.videoId === targetVideoId && 
        Math.abs(logTimeUtc - w.time.getTime()) <= 15000 // 15초 오차 허용
      );
      if (match) {
        memberIps.add(ip); // 회원 IP 셋에 동적 추가
      }
    }

    if (memberIps.has(ip)) {
      videoMemberIps.add(ip);
    } else {
      videoNonMemberIps.add(ip);
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
      ipApiOrVideoRequestCount[ip] = (ipApiOrVideoRequestCount[ip] || 0) + 1;
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

nginxFiles.forEach(file => {
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

// 2차 검증: 하루에 30회 이상 비정상 요청을 한 비회원 IP를 봇(스캐너)으로 판정하고 트래픽 소급 제외
const spammerIpsByDate = {};
Object.entries(ipDailyRequestStats).forEach(([date, ipMap]) => {
  spammerIpsByDate[date] = new Set();
  Object.entries(ipMap).forEach(([ip, count]) => {
    if (count > 30) {
      spammerIpsByDate[date].add(ip);
      botCount += count; // 봇 카운트에 합산
    }
  });
});

// 전체 기간 통계에서 보정할 스패머 IP 세트 취합
const allSpammerIps = new Set();
Object.values(spammerIpsByDate).forEach(set => {
  set.forEach(ip => allSpammerIps.add(ip));
});

// 스패머의 API/Video 요청 수만큼 nonMemberTrafficCount 차감
let spammerApiRequestSum = 0;
allSpammerIps.forEach(ip => {
  if (ipApiOrVideoRequestCount[ip]) {
    spammerApiRequestSum += ipApiOrVideoRequestCount[ip];
  }
});
nonMemberTrafficCount = Math.max(0, nonMemberTrafficCount - spammerApiRequestSum);

// 일별 고유 비회원 수 보정
const dailyNonMembers = {};
Object.entries(dailyNonMemberIps).forEach(([date, ipSet]) => {
  const spammerSet = spammerIpsByDate[date] || new Set();
  const cleanIpSet = new Set([...ipSet].filter(ip => !spammerSet.has(ip)));
  dailyNonMembers[date] = cleanIpSet.size;
});

// 전체 고유 방문 비회원 세트 보정
const cleanHomeNonMemberIps = new Set([...homeNonMemberIps].filter(ip => !allSpammerIps.has(ip)));
const cleanVideoNonMemberIps = new Set([...videoNonMemberIps].filter(ip => !allSpammerIps.has(ip)));

// Top 10 IP 추출
const topIps = Object.entries(ipStats)
  .map(([ip, data]) => ({ ip, count: data.count, bytes: data.bytes }))
  .sort((a, b) => b.count - a.count)
  .slice(0, 10);

results.nginx = {
  mobileCount, 
  pcCount, 
  botCount, 
  memberTrafficCount, 
  nonMemberTrafficCount,
  ttsRequestCount,
  uniqueVisits: {
    homeMember: homeMemberIps.size,
    homeNonMember: cleanHomeNonMemberIps.size,
    videoMember: videoMemberIps.size,
    videoNonMember: cleanVideoNonMemberIps.size
  },
  dailyNonMembers,
  stats: userAgentStats,
  searchKeywords,
  statusStats,
  specificErrors,
  totalBytes,
  topIps
};

// ==========================================
// 3. 백엔드 자체 로그 파일(backend/logs) 분석
// ==========================================

const getDatesInRange = (startStr, endStr) => {
  const dates = [];
  const start = new Date(startStr.substring(0, 10));
  const end = new Date(endStr.substring(0, 10));
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().substring(0, 10));
  }
  return dates;
};

try {
  const targetDates = getDatesInRange(startDate, endDate);
  targetDates.forEach(date => {
    const logFile = path.join(backendLogDir, \`\${date}.log\`);
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.split('\\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        const match = line.match(/^\\[([^\\]]+)\\] \\[([^\\]]+)\\] (.*)/);
        if (match) {
          const [, timestamp, level, message] = match;
          const logTime = new Date(timestamp.replace(' ', 'T') + '+09:00');
          if (logTime >= minTime && logTime <= maxTime) {
            results.backendLogs.total++;
            const lvl = level.toLowerCase();
            if (lvl === 'info') results.backendLogs.info++;
            else if (lvl === 'warn') results.backendLogs.warn++;
            else if (lvl === 'error') {
              results.backendLogs.error++;
              const cleanMsg = message.split('\\n')[0].substring(0, 120);
              results.backendLogs.frequentErrors[cleanMsg] = (results.backendLogs.frequentErrors[cleanMsg] || 0) + 1;
            }
          }
        }
      });
    }
  });
} catch (e) {
  results.backendLogs.parseError = e.message;
}

// ==========================================
// 4. TTS 캐시 물리 디스크 및 API 호출량 분석
// ==========================================

try {
  const sizeOutput = execSync(\`du -sh \${ttsCacheDir}\`, { encoding: 'utf8' }).trim();
  results.ttsDisk.cacheDirSize = sizeOutput.split('\\t')[0] || sizeOutput.split(' ')[0];
  
  const countOutput = execSync(\`find \${ttsCacheDir} -type f | wc -l\`, { encoding: 'utf8' }).trim();
  results.ttsDisk.cacheFileCount = parseInt(countOutput) || 0;

  const newFilesOutput = execSync(\`find \${ttsCacheDir} -type f -newermt "\${startDate}" ! -newermt "\${endDate}" | wc -l\`, { encoding: 'utf8' }).trim();
  results.ttsDisk.periodNewFiles = parseInt(newFilesOutput) || 0;
} catch (e) {
  results.ttsDisk.error = e.message;
}

console.log(JSON.stringify(results));
`;

console.log(`최초 회원 가입 시점(조회 하한선): ${absoluteMinDate}`);
console.log(`최종 조회 범위 지정: ${startDate} ~ ${endDate}`);
console.log('운영 서버(DB/Nginx/백엔드로그/TTS캐시)로부터 통합 통계 데이터 수집 중...');

const rawResult = runRemoteNode(remoteQueryScript);
let data;
try {
  data = JSON.parse(rawResult);
} catch (parseErr) {
  console.error('Failed to parse remote script output. Raw output:');
  console.error(rawResult);
  process.exit(1);
}

console.log('통계 통합 분석 보고서 작성 중...');

const dbResult = data.db;
const uaResult = data.nginx;
const logResult = data.backendLogs;
const ttsResult = data.ttsDisk;

// 보고서 작성 (스크린리더 친화적으로 수평선 및 연속 기호 일체 배제)
let txtContent = `운영 서버 종합 성능 및 서비스 활성 통계 보고서\n\n`;

txtContent += `1. 개요 및 요약\n\n`;
txtContent += `  조회 설정 기간: ${startDate} ~ ${endDate}\n`;
txtContent += `  최초 회원가입 시점 (조회 절대 하한선): ${absoluteMinDate}\n`;
txtContent += `  총 영상 생성 요청 수: ${dbResult.summary.total}건\n`;
if (dbResult.summary.total > 0) {
  txtContent += `  성공 건수: ${dbResult.summary.completed}건 (성공률 ${((dbResult.summary.completed / dbResult.summary.total) * 100).toFixed(1)}%)\n`;
  txtContent += `  실패 건수: ${dbResult.summary.failed}건 (실패율 ${((dbResult.summary.failed / dbResult.summary.total) * 100).toFixed(1)}%)\n`;
} else {
  txtContent += `  성공 건수: 0건\n`;
  txtContent += `  실패 건수: 0건\n`;
}
txtContent += `  대기 중 건수: ${dbResult.summary.pending}건\n`;
txtContent += `  비용 데이터 누락 의심 영상 건수 (완료 기준): ${dbResult.costMissingCount}건\n\n`;

txtContent += `2. 생성 영상 재생 시간 및 빌드 소요 시간 통계\n\n`;
if (dbResult.duration && dbResult.duration.total_duration) {
  const totalHours = Math.floor(dbResult.duration.total_duration / 3600);
  const totalMins = Math.floor((dbResult.duration.total_duration % 3600) / 60);
  const totalSecs = dbResult.duration.total_duration % 60;
  txtContent += `  총 누적 해설 영상 시간: ${dbResult.duration.total_duration}초 (약 ${totalHours}시간 ${totalMins}분 ${totalSecs}초)\n`;
  const avgMins = Math.floor(dbResult.duration.avg_duration / 60);
  const avgSecs = Math.round(dbResult.duration.avg_duration % 60);
  txtContent += `  평균 영상 길이: ${dbResult.duration.avg_duration.toFixed(1)}초 (약 ${avgMins}분 ${avgSecs}초)\n`;
} else {
  txtContent += `  총 누적 해설 영상 시간: 0초\n`;
  txtContent += `  평균 영상 길이: 0초\n`;
}
if (dbResult.longestVideo && dbResult.longestVideo.duration) {
  const maxMins = Math.floor(dbResult.longestVideo.duration / 60);
  const maxSecs = dbResult.longestVideo.duration % 60;
  txtContent += `  최장 해설 영상: ${dbResult.longestVideo.title} (ID: ${dbResult.longestVideo.videoId}, ${dbResult.longestVideo.duration}초 / 약 ${maxMins}분 ${maxSecs}초)\n`;
}
if (dbResult.shortestVideo && dbResult.shortestVideo.duration) {
  txtContent += `  최단 해설 영상: ${dbResult.shortestVideo.title} (ID: ${dbResult.shortestVideo.videoId}, ${dbResult.shortestVideo.duration}초)\n`;
}

// 빌드 소요 시간 통계 (이상치 3시간 초과 건 배제)
if (dbResult.buildLatency && dbResult.buildLatency.count > 0) {
  const avgLat = dbResult.buildLatency.avg_latency;
  const maxLat = dbResult.buildLatency.max_latency;
  const minLat = dbResult.buildLatency.min_latency;
  txtContent += `  평균 빌드 소요 시간: ${avgLat.toFixed(1)}초 (약 ${Math.floor(avgLat / 60)}분 ${Math.round(avgLat % 60)}초)\n`;
  txtContent += `  최장 빌드 소요 시간: ${maxLat}초 (약 ${Math.floor(maxLat / 60)}분 ${maxLat % 60}초)\n`;
  txtContent += `  최단 빌드 소요 시간: ${minLat}초\n`;
  txtContent += `  비정상 지연 완료 건수 (3시간 초과): ${dbResult.buildLatencyOutliers}건\n`;
} else {
  txtContent += `  빌드 소요 시간 정보 없음\n`;
}
txtContent += `\n`;

txtContent += `3. 영상 생성 요청자 및 회원 그룹 세그먼트 분석\n\n`;
if (dbResult.summary.total > 0) {
  const memberReqPct = ((dbResult.requestorStats.member_requests / dbResult.summary.total) * 100).toFixed(1);
  const nonMemberReqPct = ((dbResult.requestorStats.non_member_requests / dbResult.summary.total) * 100).toFixed(1);
  txtContent += `  회원 생성 요청: ${dbResult.requestorStats.member_requests}건 (${memberReqPct}%)\n`;
  txtContent += `  비회원 생성 요청: ${dbResult.requestorStats.non_member_requests}건 (${nonMemberReqPct}%)\n`;
} else {
  txtContent += `  회원 생성 요청: 0건\n`;
  txtContent += `  비회원 생성 요청: 0건\n`;
}

// 세그먼트별 요청 비중
txtContent += `  회원 그룹 세그먼트별 요청 건수:\n`;
if (dbResult.videoRequestsBySegment && dbResult.videoRequestsBySegment.length > 0) {
  dbResult.videoRequestsBySegment.forEach(seg => {
    txtContent += `    ${seg.group_name}: ${seg.count}건\n`;
  });
} else {
  txtContent += `    요청 데이터 없음\n`;
}

txtContent += `  최다 요청 회원 리스트 (Top 10):\n`;
if (dbResult.topRequestors && dbResult.topRequestors.length > 0) {
  dbResult.topRequestors.forEach((req, idx) => {
    let blindStatus = '미인증';
    if (req.is_blind === 1) {
      const authMethod = req.blind_auth_method === 'siloam_api' ? '실로암 API' :
                         req.blind_auth_method === 'card_ocr' ? '복지카드 OCR' :
                         req.blind_auth_method === 'admin_manual' ? '관리자 수동 승인' : '기타/미지정';
      blindStatus = `시각장애인 인증 (${authMethod})`;
    }
    const totalMins = Math.floor(req.total_duration / 60);
    const totalSecs = req.total_duration % 60;
    txtContent += `    ${idx + 1}위: ${req.name} (ID: ${req.requested_by}, 이메일: ${req.email}, ${blindStatus})\n`;
    txtContent += `        요청 건수: ${req.count}건, 총 영상길이: ${req.total_duration.toLocaleString()}초 (약 ${totalMins}분 ${totalSecs}초), 누적 비용: $${req.total_cost.toFixed(3)}\n`;
  });
} else {
  txtContent += `    해당 기간 활동 회원 없음\n`;
}
txtContent += `\n`;

txtContent += `4. 기기 플랫폼 및 OS 접속 통계 (Nginx 로그 기반)\n\n`;
const totalUa = uaResult.mobileCount + uaResult.pcCount;
if (totalUa > 0) {
  const mobilePct = ((uaResult.mobileCount / totalUa) * 100).toFixed(1);
  const pcPct = ((uaResult.pcCount / totalUa) * 100).toFixed(1);
  txtContent += `  모바일 (Mobile/Tablet): ${uaResult.mobileCount}건 (${mobilePct}%)\n`;
  txtContent += `  데스크톱 (PC): ${uaResult.pcCount}건 (${pcPct}%)\n`;
  txtContent += `  세부 플랫폼 정보:\n`;
  txtContent += `    모바일 디바이스:\n`;
  Object.entries(uaResult.stats.mobile).forEach(([device, count]) => {
    const pct = ((count / uaResult.mobileCount) * 100).toFixed(1);
    txtContent += `      ${device}: ${count}건 (${pct}%)\n`;
  });
  txtContent += `    데스크톱 OS:\n`;
  Object.entries(uaResult.stats.pc).forEach(([os, count]) => {
    const pct = ((count / uaResult.pcCount) * 100).toFixed(1);
    txtContent += `      ${os}: ${count}건 (${pct}%)\n`;
  });
} else {
  txtContent += `  해당 기간 수집된 클라이언트 트래픽 로그 없음\n`;
}
txtContent += `\n`;

txtContent += `5. 사용자 서비스 활성 및 소통 지표 (세그먼트별 분석)\n\n`;
txtContent += `  해당 기간 신규 가입 회원 수: ${dbResult.newUsers}명\n`;

const getMethodName = (method) => {
  switch (method) {
    case 'siloam_api': return '실로암 API 연동';
    case 'card_ocr': return '복지카드 OCR 판독';
    case 'admin_manual': return '관리자 수동 승인';
    default: return '미인증 / 기타';
  }
};

if (dbResult.newUsers > 0 && dbResult.newUsersByAuthMethod && dbResult.newUsersByAuthMethod.length > 0) {
  txtContent += `  신규 가입 인증 경로 분포:\n`;
  dbResult.newUsersByAuthMethod.forEach(m => {
    txtContent += `    ${getMethodName(m.method)}: ${m.count}명\n`;
  });
}

txtContent += `  누적 회원 인증 경로 분포 (전체 기간):\n`;
if (dbResult.totalUsersByAuthMethod && dbResult.totalUsersByAuthMethod.length > 0) {
  dbResult.totalUsersByAuthMethod.forEach(m => {
    txtContent += `    ${getMethodName(m.method)}: ${m.count}명\n`;
  });
}

txtContent += `  누적 회원 그룹 분포 (전체 기간):\n`;
if (dbResult.userSegmentDistribution && dbResult.userSegmentDistribution.length > 0) {
  dbResult.userSegmentDistribution.forEach(seg => {
    txtContent += `    ${seg.group_name}: ${seg.count}명\n`;
  });
}
txtContent += `\n`;

txtContent += `  영상 댓글 활동:\n`;
const totalVidComm = dbResult.videoComments.member_count + dbResult.videoComments.non_member_count;
txtContent += `    총 영상 댓글 수: ${totalVidComm}건\n`;
txtContent += `    회원 작성 댓글: ${dbResult.videoComments.member_count}건\n`;
txtContent += `    비회원 작성 댓글: ${dbResult.videoComments.non_member_count}건\n`;
if (dbResult.commentsBySegment && dbResult.commentsBySegment.length > 0) {
  txtContent += `    회원 세그먼트별 댓글 분포:\n`;
  dbResult.commentsBySegment.forEach(seg => {
    txtContent += `      ${seg.group_name}: ${seg.count}건\n`;
  });
}

txtContent += `  커뮤니티 게시판 활동:\n`;
const totalPosts = dbResult.boardPosts.member_count + dbResult.boardPosts.non_member_count;
txtContent += `    총 등록된 게시글: ${totalPosts}건\n`;
txtContent += `    회원 작성 게시글: ${dbResult.boardPosts.member_count}건\n`;
txtContent += `    비회원 작성 게시글: ${dbResult.boardPosts.non_member_count}건\n`;

const totalBoardComm = dbResult.boardComments.member_count + dbResult.boardComments.non_member_count;
txtContent += `    총 등록된 게시판 댓글: ${totalBoardComm}건\n`;
txtContent += `    회원 작성 게시판 댓글: ${dbResult.boardComments.member_count}건\n`;
txtContent += `    비회원 작성 게시판 댓글: ${dbResult.boardComments.non_member_count}건\n`;

txtContent += `  로그인 회원 전용 인터랙션:\n`;
txtContent += `    로그인 유저 총 비디오 시청 횟수: ${dbResult.memberWatches}건\n`;
if (dbResult.watchesBySegment && dbResult.watchesBySegment.length > 0) {
  txtContent += `    회원 세그먼트별 시청 분포:\n`;
  dbResult.watchesBySegment.forEach(seg => {
    txtContent += `      ${seg.group_name}: ${seg.count}건\n`;
  });
}
txtContent += `    로그인 유저 좋아요 클릭 수: ${dbResult.memberLikes}건\n`;

const totalWebTraffic = uaResult.memberTrafficCount + uaResult.nonMemberTrafficCount;
if (totalWebTraffic > 0) {
  const memberTrafficPct = ((uaResult.memberTrafficCount / totalWebTraffic) * 100).toFixed(1);
  const nonMemberTrafficPct = ((uaResult.nonMemberTrafficCount / totalWebTraffic) * 100).toFixed(1);
  txtContent += `  웹 트래픽 유입 비율 (Nginx 로그 IP 연계):\n`;
  txtContent += `    로그인 회원 추정 트래픽: ${uaResult.memberTrafficCount}건 (${memberTrafficPct}%)\n`;
  txtContent += `    비회원 추정 트래픽: ${uaResult.nonMemberTrafficCount}건 (${nonMemberTrafficPct}%)\n`;
}
txtContent += `\n`;

txtContent += `6. 고유 IP 기반 화면 방문 분석 (Nginx 로그 연계 - 비인간 트래픽 필터 적용)\n\n`;
txtContent += `  홈 화면 (/) 고유 방문자 수:\n`;
txtContent += `    회원 고유 IP 수: ${uaResult.uniqueVisits.homeMember}개\n`;
txtContent += `    비회원 고유 IP 수: ${uaResult.uniqueVisits.homeNonMember}개\n`;
txtContent += `  재생 화면 (/video/:id) 고유 방문자 수:\n`;
txtContent += `    회원 고유 IP 수: ${uaResult.uniqueVisits.videoMember}개\n`;
txtContent += `    비회원 고유 IP 수: ${uaResult.uniqueVisits.videoNonMember}개\n`;

if (uaResult.uniqueVisits.homeNonMember > 0) {
  const convRate = ((uaResult.uniqueVisits.videoNonMember / uaResult.uniqueVisits.homeNonMember) * 100).toFixed(1);
  txtContent += `  비회원 재생 페이지 전환율 (홈 방문 대비 재생 화면 도달율):\n`;
  txtContent += `    전환율: ${convRate}%\n`;
}
txtContent += `\n`;

const actualActiveMembers = dbResult.uniqueActiveMembers;
const estimatedActiveNonMembers = uaResult.uniqueVisits.videoNonMember;
const actualActiveUsers = actualActiveMembers + estimatedActiveNonMembers;

txtContent += `7. 실제 활성 사용자 분석 (Actual Active Users)\n\n`;
txtContent += `  정의: 재생 화면(/video/:id)에 도달하여 실제로 해설을 시청한 고유 회원(DB 이력 기준) 및 비회원(Nginx 고유 IP 기준)의 합산\n`;
txtContent += `  총 실제 활성 사용자 수: ${actualActiveUsers}명\n`;
if (actualActiveUsers > 0) {
  const activeMemPct = ((actualActiveMembers / actualActiveUsers) * 100).toFixed(1);
  const activeNonMemPct = ((estimatedActiveNonMembers / actualActiveUsers) * 100).toFixed(1);
  txtContent += `    실제 활성 회원 수 (DB 시청 이력 검증): ${actualActiveMembers}명 (${activeMemPct}%)\n`;
  txtContent += `    추정 활성 비회원 수 (Nginx 고유 IP 기반): ${estimatedActiveNonMembers}명 (${activeNonMemPct}%)\n`;
  
  if (actualActiveMembers > 0) {
    const avgWatch = (dbResult.memberWatches / actualActiveMembers).toFixed(1);
    txtContent += `    활성 회원 1인당 평균 시청 횟수: ${avgWatch}회 (회원 총 시청 ${dbResult.memberWatches}건 / 활성 회원 ${actualActiveMembers}명)\n`;
  } else {
    txtContent += `    활성 회원 1인당 평균 시청 횟수: 0.0회\n`;
  }
} else {
  txtContent += `    해당 기간 재생 진입 유저 없음\n`;
}
txtContent += `\n`;

txtContent += `8. 일별 실제 활성 사용자(Daily AAU) 추이\n\n`;
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

txtContent += `9. 검색어 트렌드 및 콘텐츠 인기 소통 지표\n\n`;

// 검색 키워드 Top 10 출력
txtContent += `  인기 검색 키워드 Top 10 (Nginx 분석):\n`;
const sortedKeywords = Object.entries(uaResult.searchKeywords)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);
if (sortedKeywords.length > 0) {
  sortedKeywords.forEach(([kw, count], idx) => {
    txtContent += `    ${idx + 1}위: ${kw} (${count}회 검색)\n`;
  });
} else {
  txtContent += `    검색 이력 없음\n`;
}

txtContent += `  가장 많은 댓글 소통이 일어난 영상 Top 5:\n`;
if (dbResult.mostCommentedVideos && dbResult.mostCommentedVideos.length > 0) {
  dbResult.mostCommentedVideos.forEach((v, idx) => {
    txtContent += `    ${idx + 1}위: ${v.title || 'Unknown'} (ID: ${v.videoId}) - 댓글 ${v.count}개\n`;
  });
} else {
  txtContent += `    해당 기간 소통 이력 없음\n`;
}

txtContent += `  가장 시청이 많이 이루어진 인기 영상 Top 5 (회원 시청 이력 기준):\n`;
if (dbResult.mostWatchedVideos && dbResult.mostWatchedVideos.length > 0) {
  dbResult.mostWatchedVideos.forEach((v, idx) => {
    txtContent += `    ${idx + 1}위: ${v.title || 'Unknown'} (ID: ${v.videoId}) - 시청 ${v.count}회\n`;
  });
} else {
  txtContent += `    해당 기간 시청 이력 없음\n`;
}
txtContent += `\n`;

txtContent += `10. 일별 생성 요청 추이\n\n`;
if (dbResult.dailyTrend && dbResult.dailyTrend.length > 0) {
  dbResult.dailyTrend.forEach(trend => {
    txtContent += `  일자: ${trend.date} - 총 ${trend.total}건 (성공 ${trend.completed}건, 실패 ${trend.failed}건)\n`;
  });
} else {
  txtContent += `  해당 기간 생성 요청 이력 없음\n`;
}
txtContent += `\n`;

txtContent += `11. 요일별 및 시간대별 요청 분포\n\n`;
txtContent += `  요일별 현황:\n`;
if (dbResult.dayOfWeekDistribution && dbResult.dayOfWeekDistribution.length > 0) {
  dbResult.dayOfWeekDistribution.forEach(dow => {
    txtContent += `    ${dow.day_of_week}: ${dow.count}건\n`;
  });
} else {
  txtContent += `    이력 없음\n`;
}
txtContent += `  시간대별 현황 (요청 집중도):\n`;
if (dbResult.hourlyDistribution && dbResult.hourlyDistribution.length > 0) {
  dbResult.hourlyDistribution.forEach(h => {
    txtContent += `    ${h.hour}시: ${h.count}건\n`;
  });
} else {
  txtContent += `    이력 없음\n`;
}
txtContent += `\n`;

txtContent += `12. AI API 사용 비용 통계\n\n`;
if (dbResult.apiCostsTotal && dbResult.apiCostsTotal.total_cost) {
  txtContent += `  누적 API 비용: $${dbResult.apiCostsTotal.total_cost.toFixed(3)}\n`;
  txtContent += `  누적 토큰: 이미지 토큰 ${dbResult.apiCostsTotal.total_image_tokens.toLocaleString()} / 텍스트 토큰 ${dbResult.apiCostsTotal.total_text_tokens.toLocaleString()}\n`;
} else {
  txtContent += `  누적 API 비용: $0.000\n`;
}
txtContent += `  사용 모델별 비용 현황:\n`;
if (dbResult.modelCosts && dbResult.modelCosts.length > 0) {
  dbResult.modelCosts.forEach(mc => {
    txtContent += `    ${mc.model_used}: ${mc.calls}회 호출, $${mc.cost.toFixed(3)} (이미지 토큰 ${mc.image_tokens.toLocaleString()}, 텍스트 토큰 ${mc.text_tokens.toLocaleString()})\n`;
  });
} else {
  txtContent += `    사용 이력 없음\n`;
}
txtContent += `  최고 비용 발생 영상 Top 5:\n`;
if (dbResult.mostExpensiveVideos && dbResult.mostExpensiveVideos.length > 0) {
  dbResult.mostExpensiveVideos.forEach((v, idx) => {
    txtContent += `    ${idx + 1}위: ${v.title || 'Unknown'} (ID: ${v.videoId}) - $${v.cost.toFixed(3)} (이미지 ${v.image_tokens.toLocaleString()}, 텍스트 ${v.text_tokens.toLocaleString()})\n`;
  });
} else {
  txtContent += `    비용 발생 이력 없음\n`;
}
txtContent += `\n`;

// 고도화 4: TTS 하이브리드 캐시 효율성 분석
txtContent += `13. 하이브리드 TTS 캐시 시스템 점검\n\n`;
if (ttsResult.error) {
  txtContent += `  TTS 캐시 디렉토리 수집 중 오류: ${ttsResult.error}\n`;
} else {
  txtContent += `  현재 총 누적 캐시 파일 수: ${ttsResult.cacheFileCount.toLocaleString()}개\n`;
  txtContent += `  현재 캐시 디렉토리 총 디스크 용량: ${ttsResult.cacheDirSize}\n`;
  txtContent += `  조회 기간 내 새로 생성된 캐시 파일 수 (TTS API 직접 호출 = 캐시 미스): ${ttsResult.periodNewFiles.toLocaleString()}개\n`;
  txtContent += `  조회 기간 내 Nginx 기록된 총 TTS 요청 수: ${uaResult.ttsRequestCount.toLocaleString()}회\n`;
  if (uaResult.ttsRequestCount > 0) {
    const ttsHitRate = ((1 - (ttsResult.periodNewFiles / uaResult.ttsRequestCount)) * 100).toFixed(1);
    txtContent += `  하이브리드 TTS 캐시 히트율 (Cache Hit Rate): ${ttsHitRate}%\n`;
  } else {
    txtContent += `  하이브리드 TTS 캐시 히트율 (Cache Hit Rate): 100.0% (요청 없음)\n`;
  }
}
txtContent += `\n`;

// 고도화 5: Nginx 상세 에러 로그 및 트래픽 분석
txtContent += `14. Nginx 상세 트래픽 및 네트워크 안정성 분석\n\n`;
const totalOutGb = (uaResult.totalBytes / (1024 * 1024 * 1024)).toFixed(3);
txtContent += `  총 아웃바운드 데이터 전송량: ${totalOutGb} GB\n`;
txtContent += `  HTTP 응답 코드 상태별 요약:\n`;
const totalStatusCalls = Object.values(uaResult.statusStats).reduce((a, b) => a + b, 0);
if (totalStatusCalls > 0) {
  Object.entries(uaResult.statusStats).forEach(([group, count]) => {
    const pct = ((count / totalStatusCalls) * 100).toFixed(1);
    txtContent += `    ${group}: ${count}건 (${pct}%)\n`;
  });
}
if (Object.keys(uaResult.specificErrors).length > 0) {
  txtContent += `  상세 실패 에러코드 분포 (4xx 및 5xx):\n`;
  Object.entries(uaResult.specificErrors)
    .sort((a, b) => b[1] - a[1])
    .forEach(([code, count]) => {
      txtContent += `    HTTP ${code}: ${count}건\n`;
    });
}
txtContent += `  최다 요청 고유 IP 리스트 Top 10:\n`;
if (uaResult.topIps && uaResult.topIps.length > 0) {
  uaResult.topIps.forEach((ipData, idx) => {
    const ipMb = (ipData.bytes / (1024 * 1024)).toFixed(2);
    txtContent += `    ${idx + 1}위 IP: ${ipData.ip} - 요청 ${ipData.count}회, 전송량 ${ipMb} MB\n`;
  });
}
txtContent += `\n`;

// 고도화 6: 백엔드 자체 로그 분석
txtContent += `15. 백엔드 시스템 로그 예외 분석 (logs/*.log)\n\n`;
if (logResult.parseError) {
  txtContent += `  백엔드 로그 수집 오류: ${logResult.parseError}\n`;
} else {
  txtContent += `  조회 기간 내 총 백엔드 발생 로그 라인 수: ${logResult.total.toLocaleString()}건\n`;
  txtContent += `    INFO 수준: ${logResult.info.toLocaleString()}건\n`;
  txtContent += `    WARN 수준: ${logResult.warn.toLocaleString()}건\n`;
  txtContent += `    ERROR 수준: ${logResult.error.toLocaleString()}건\n`;
  
  if (logResult.error > 0) {
    txtContent += `  다발적인 백엔드 에러 문구 Top 5:\n`;
    const sortedLogErrors = Object.entries(logResult.frequentErrors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    sortedLogErrors.forEach(([errMsg, count], idx) => {
      txtContent += `    ${idx + 1}위: ${errMsg} (${count}회 발생)\n`;
    });
  } else {
    txtContent += `    기간 내 백엔드 에러 로그 발생 없음\n`;
  }
}
txtContent += `\n`;

txtContent += `16. 비디오 생성 실패 구체 사유 빈도 분포\n\n`;
if (dbResult.failureReasons && dbResult.failureReasons.length > 0) {
  dbResult.failureReasons.forEach(fr => {
    const reasonClean = fr.fail_reason.replace(/\n/g, ' ');
    txtContent += `  사유: ${reasonClean} - ${fr.count}건\n`;
  });
} else {
  txtContent += `  해당 기간 비디오 생성 실패 이력 없음\n`;
}

// prod_report/ 디렉토리 존재 확인 및 없으면 자동 생성
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

fs.writeFileSync(outputPath, txtContent, 'utf8');
console.log(`보고서 생성이 완료되었습니다: ${outputPath}`);
