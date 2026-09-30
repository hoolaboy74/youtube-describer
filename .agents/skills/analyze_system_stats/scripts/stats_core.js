'use strict';

function parseInstant(value) {
    if (typeof value === 'number') return value;
    if (!value) return NaN;
    const s = String(value).trim();
    return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
}

function dateStart(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('날짜 형식은 YYYY-MM-DD입니다.');
    const day = Date.parse(date + 'T00:00:00Z');
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) throw new Error('존재하지 않는 날짜입니다.');
    return day - 9 * 3600000;
}

function kstDate(time) { return new Date(time + 9 * 3600000).toISOString().slice(0, 10); }

function makeRange(start, end, firstRegistration, now = Date.now()) {
    const first = parseInstant(firstRegistration);
    if (!start && !Number.isFinite(first)) throw new Error('최초 회원 가입일을 확인할 수 없습니다. 시작일을 지정하십시오.');
    const startDate = start || kstDate(first);
    const endDate = end || kstDate(now);
    const requestedStart = dateStart(startDate), requestedEnd = dateStart(endDate) + 86400000;
    if (requestedStart >= requestedEnd) throw new Error('시작일이 종료일보다 늦습니다.');
    const effectiveStart = Math.max(requestedStart, Number.isFinite(first) ? first : requestedStart);
    if (effectiveStart >= requestedEnd) throw new Error('조회 기간이 최초 회원 가입 이전입니다.');
    return { startDate, endDate, timeZone: 'Asia/Seoul', start: new Date(effectiveStart).toISOString(),
        endExclusive: new Date(requestedEnd).toISOString(), firstRegistration: Number.isFinite(first) ? new Date(first).toISOString() : null,
        clamped: effectiveStart !== requestedStart, interval: '[start,endExclusive)' };
}

function routeGroup(raw) {
    const path = String(raw || '').split('?')[0].replace(/^\/api(?=\/)/, '');
    if (path === '/video-qa') return 'qa.question.legacy';
    if (path === '/qa/requests') return 'qa.request';
    if (/^\/qa\/requests\/[^/]+\/(events|audio|cancel)$/.test(path)) return 'qa.' + path.split('/').pop();
    if (path.startsWith('/qa/audio/')) return 'qa.audio.fetch';
    if (path.startsWith('/qa/sessions/')) return 'qa.presence';
    if (path.startsWith('/qa-tts')) return 'qa.tts.legacy';
    if (path.startsWith('/qa/')) return path === '/qa/config' ? 'qa.config' : 'qa.other';
    if (path.startsWith('/tts')) return 'tts.description';
    if (path.startsWith('/script/')) return 'description.script';
    if (path === '/process' || path === '/batch-process') return 'description.request';
    if (path === '/users/me/videos/history') return 'account.watch_history';
    if (path.includes('/favorites')) return 'account.favorites';
    if (path.startsWith('/users/')) return 'account.other';
    if (path.startsWith('/auth/')) return 'auth';
    if (path.startsWith('/admin/')) return 'admin';
    if (path.startsWith('/board/')) return 'community';
    if (path.startsWith('/comments')) return 'comments';
    if (path.startsWith('/video/')) return 'page.video';
    if (path === '/' || path === '/index.html') return 'page.home';
    if (path.startsWith('/log-donation')) return 'donation.interest';
    if (path.startsWith('/search')) return 'search';
    return 'other';
}

function parseNginx(line) {
    const m = line.match(/^(\S+) - \S+ \[([^\]]+)\] "([^"]+)" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"/);
    if (!m) return null;
    const d = m[2].match(/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/);
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    if (!d || !months[d[2]]) return null;
    const time = Date.parse(`${d[3]}-${months[d[2]]}-${d[1]}T${d[4]}:${d[5]}:${d[6]}${d[7].slice(0,3)}:${d[7].slice(3)}`);
    if (!Number.isFinite(time)) return null;
    const request = m[3].split(' ');
    return { ip: m[1], time, method: request[0], path: request[1] || '', status: Number(m[4]), bytes: Number(m[5]) || 0, ua: m[7] };
}

// Self-contained read-only collection function; shipped to mom over SSH by the CLI.
async function collectStats(config) {
    const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
    const readline = require('node:readline');
    const Database = require(config.sqliteModule);
    const now = config.now ?? Date.now();
    if (config.nginxErrorTimeZone === undefined) {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        config.nginxErrorTimeZone = zone === 'Asia/Seoul' ? '+09:00' : ['UTC','Etc/UTC'].includes(zone) ? '+00:00' : null;
    }
    const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
    const warnings = [];
    const manifest = {
        videos: 'period registration/current status', users: 'period registrations/current authentication',
        api_requests: 'period route/user/day requests', api_costs: 'period detailed cost ledger',
        user_watch_histories: 'retained last-watch rows, not playback events', user_favorites: 'retained favorites, not click events',
        comments: 'retained comments', posts: 'retained posts/notices', post_comments: 'retained community comments',
        qa_user_daily_costs: 'period KST daily summary and reconciliation', qa_request_receipts: 'period request and accounting states',
        qa_cache_jobs: 'current cache jobs/expired leases', qa_frame_assets: 'current frame inventory and file presence',
        qa_subtitle_assets: 'current subtitle inventory and file presence', gemini_monthly_grounding_usage: 'whole billing-month counters',
        scripts: 'current script tags/provenance/TTS eligibility, no creation date', script_quarantine: 'period validation reasons',
        user_verifications: 'period verification attempts and decisions', donations: 'period income by donation date',
        settings: 'current allowlisted operational configuration only'
    };
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const schema = Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`PRAGMA table_info("${name.replaceAll('"','""')}")`).all().map(c => c.name)]));
    const has = (table, column) => !!schema[table]?.includes(column);
    const coverage = tables.map(({ name }) => ({ table: name, scope: manifest[name] || 'UNREVIEWED', columns: schema[name] }));
    for (const { name } of tables) if (!manifest[name]) warnings.push({ code: 'UNREVIEWED_TABLE', source: name });
    for (const name of Object.keys(manifest)) if (!schema[name]) warnings.push({ code: 'MISSING_TABLE', source: name });
    const first = schema.users ? db.prepare('SELECT MIN(createdAt) AS first FROM users').get().first : null;
    const range = makeRange(config.startDate, config.endDate, first, now);
    const low = Date.parse(range.start), high = Date.parse(range.endExclusive);
    const inRange = time => Number.isFinite(time) && time >= low && time < high;
    const bounds = [range.start, range.endExclusive];
    const where = field => `julianday(${field}) >= julianday(?) AND julianday(${field}) < julianday(?)`;
    function read(table, fn) {
        if (!schema[table]) return null;
        try { return fn(); } catch (e) { warnings.push({ code: 'QUERY_FAILED', source: table, errorCode: e.code || 'QUERY_ERROR' }); return null; }
    }
    const zeroSum = expression => `COALESCE(SUM(${expression}),0)`;
    const countPeriod = (table, field = 'createdAt') => read(table, () => db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where(field)}`).get(...bounds).count);
    const group = (table, field, period = false, dateField = 'createdAt') => read(table, () => db.prepare(`SELECT COALESCE(${field},'unknown') AS value,COUNT(*) AS count FROM ${table} ${period ? 'WHERE '+where(dateField) : ''} GROUP BY ${field} ORDER BY count DESC`).all(...(period ? bounds : [])));
    const result = { schemaVersion: 2, collectedAt: new Date(now).toISOString(), range, coverage, warnings,
        limitations: [
            '월별 상태는 현재 보존된 DB·로그를 기준으로 하며 삭제된 과거 자료와 월말 상태를 복원하지 않습니다.',
            '시청 이력은 회원별 최근 20개이며 재시청 시 갱신됩니다. 실제 재생 횟수·완주율·월간 활성 회원 수는 측정 불가입니다.',
            '즐겨찾기는 현재 남아 있는 항목 수입니다. 추가/취소 클릭 이벤트 수는 측정 불가입니다.',
            'API 로그에는 method/status/duration/requestId가 없습니다. 요청은 성공 행동 수 또는 실제 청취 횟수가 아닙니다.',
            '캐시 파일 수·mtime와 API 요청 수로 실제 TTS HIT/MISS 비율 또는 합성 비용을 계산할 수 없습니다.',
            '해설 완료 시각이 저장되지 않아 실제 빌드 지연은 측정 불가입니다. 비용 기록 지연은 별도 참고 추정치입니다.',
            'IP는 사람 수가 아닙니다. IP 추정 방문은 회원 API 이용자 수와 합산하지 않습니다.',
            '현재 상태·월별 요청/비용·전체 billing-month 검색 한도는 서로 다른 범위입니다.'
        ], data: {} };
    let apiRows = [];
    db.transaction(() => {
        result.data.members = read('users', () => ({ new: countPeriod('users'),
            verifiedNew: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where('createdAt')} AND is_blind=1`).get(...bounds).n,
            newAuthMethods: group('users','blind_auth_method',true), currentTotal: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
            currentSegments: group('users','is_blind'), scope: '가입일은 기간 기준, 인증 상태는 수집 시점 기준' }));
        result.data.videos = read('videos', () => {
            const summary = db.prepare(`SELECT COUNT(*) AS registered,${zeroSum("status='completed'")} AS completed,${zeroSum("status='failed'")} AS failed,${zeroSum('requested_by IS NOT NULL')} AS memberRegistered,${zeroSum("CASE WHEN status='completed' THEN duration ELSE 0 END")} AS completedSeconds,AVG(CASE WHEN status='completed' THEN duration END) AS averageSeconds FROM videos WHERE ${where('createdAt')}`).get(...bounds);
            summary.statuses = group('videos','status',true);
            summary.successRate = summary.registered ? summary.completed / summary.registered * 100 : null;
            summary.memberRate = summary.registered ? summary.memberRegistered / summary.registered * 100 : null;
            summary.verifiedRegistered = schema.users ? db.prepare(`SELECT COUNT(*) AS n FROM videos v JOIN users u ON u.id=v.requested_by WHERE ${where('v.createdAt')} AND u.is_blind=1`).get(...bounds).n : null;
            summary.daily = db.prepare(`SELECT strftime('%Y-%m-%d',createdAt,'+9 hours') AS date,COUNT(*) AS registered,${zeroSum("status='completed'")} AS completed FROM videos WHERE ${where('createdAt')} GROUP BY date ORDER BY date`).all(...bounds);
            summary.hours = db.prepare(`SELECT strftime('%H',createdAt,'+9 hours') AS hour,COUNT(*) AS count FROM videos WHERE ${where('createdAt')} GROUP BY hour ORDER BY hour`).all(...bounds);
            summary.weekdays = db.prepare(`SELECT strftime('%w',createdAt,'+9 hours') AS weekday,COUNT(*) AS count FROM videos WHERE ${where('createdAt')} GROUP BY weekday ORDER BY weekday`).all(...bounds);
            summary.completedDuration = db.prepare(`SELECT MIN(duration) AS minSeconds,MAX(duration) AS maxSeconds FROM videos WHERE ${where('createdAt')} AND status='completed'`).get(...bounds);
            summary.durationBuckets = db.prepare(`SELECT CASE WHEN duration<300 THEN 'under5min' WHEN duration<900 THEN '5to15min' WHEN duration<1800 THEN '15to30min' ELSE '30minPlus' END AS bucket,COUNT(*) AS count FROM videos WHERE ${where('createdAt')} AND status='completed' GROUP BY bucket`).all(...bounds);
            summary.failureCategories = {};
            if(has('videos','fail_reason'))for(const row of db.prepare(`SELECT fail_reason,COUNT(*) AS count FROM videos WHERE ${where('createdAt')} AND status='failed' GROUP BY fail_reason`).all(...bounds)){
                const reason=String(row.fail_reason||'');const category=/disk|ENOSPC|공간/i.test(reason)?'disk':/download|yt-dlp|403|429|cookie/i.test(reason)?'download':/subtitle|whisper/i.test(reason)?'speech_or_subtitle':/gemini|model|token|API/i.test(reason)?'model':/timeout|timed out/i.test(reason)?'timeout':'other_or_unknown';
                summary.failureCategories[category]=(summary.failureCategories[category]||0)+row.count;
            }
            summary.languages = has('videos','audio_language') ? group('videos','audio_language',true) : null;
            summary.downloadBytes = has('videos','filesize') ? db.prepare(`SELECT ${zeroSum('filesize')} AS n FROM videos WHERE ${where('createdAt')}`).get(...bounds).n : null;
            summary.scope = '기간 내 등록된 보존 영상의 현재 상태. API 요청 횟수·월내 완료 이벤트가 아님';
            return summary;
        });
        result.data.costs = read('api_costs', () => {
            const type = has('api_costs','request_type') ? "COALESCE(request_type,'legacy_unknown')" : "'legacy_unknown'";
            const fields = ['image_tokens','text_tokens','input_tokens','output_tokens','thinking_tokens','cached_tokens','tool_tokens','search_queries','input_cost','output_cost','cached_cost','tool_cost','search_cost'];
            const detail = fields.map(f => has('api_costs',f) ? `${zeroSum(f)} AS ${f}` : `NULL AS ${f}`).join(',');
            const total = db.prepare(`SELECT COUNT(*) AS calls,${zeroSum('cost')} AS total FROM api_costs WHERE ${where('createdAt')}`).get(...bounds);
            const recorded = has('api_costs','pricing_version') ? zeroSum('pricing_version IS NOT NULL') : '0';
            total.byType = db.prepare(`SELECT ${type} AS type,COUNT(*) AS calls,${zeroSum('cost')} AS cost,${recorded} AS breakdownRecordedCalls,${detail} FROM api_costs WHERE ${where('createdAt')} GROUP BY type`).all(...bounds);
            for(const row of total.byType){
                row.breakdownStatus=row.breakdownRecordedCalls===row.calls?'RECORDED':row.breakdownRecordedCalls?'PARTIAL':'LEGACY_UNAVAILABLE';
                if(!row.breakdownRecordedCalls)for(const field of fields.filter(f=>!['image_tokens','text_tokens'].includes(f)))row[field]=null;
            }
            total.byModel = db.prepare(`SELECT model_used AS model,${type} AS type,COUNT(*) AS calls,${zeroSum('cost')} AS cost FROM api_costs WHERE ${where('createdAt')} GROUP BY model,type`).all(...bounds);
            total.daily = db.prepare(`SELECT strftime('%Y-%m-%d',createdAt,'+9 hours') AS date,${type} AS type,COUNT(*) AS calls,${zeroSum('cost')} AS cost FROM api_costs WHERE ${where('createdAt')} GROUP BY date,type ORDER BY date`).all(...bounds);
            total.pricingVersions = has('api_costs','pricing_version') ? group('api_costs','pricing_version',true) : null;
            total.descriptionCost = total.byType.find(row => row.type === 'description')?.cost ?? (has('api_costs','request_type') ? 0 : null);
            total.qaCost = total.byType.find(row => row.type === 'qa')?.cost ?? (has('api_costs','request_type') ? 0 : null);
            total.legacyCalls = has('api_costs','pricing_version') ? db.prepare(`SELECT COUNT(*) AS n FROM api_costs WHERE ${where('createdAt')} AND pricing_version IS NULL`).get(...bounds).n : total.calls;
            if(total.legacyCalls)warnings.push({code:'LEGACY_COST_BREAKDOWN_UNAVAILABLE',source:'api_costs',calls:total.legacyCalls});
            total.scope = '기간 내 상세 원장. Q&A 일별 요약과 검색 한도 원장은 중복 합산하지 않음';
            return total;
        });
        result.data.qaDaily = read('qa_user_daily_costs', () => db.prepare(`SELECT COUNT(*) AS rows,${zeroSum('queryCount')} AS calls,${zeroSum('totalCost')} AS cost,COUNT(DISTINCT userId) AS users,COUNT(DISTINCT videoId) AS videos FROM qa_user_daily_costs WHERE logDate>=? AND logDate<=?`).get(kstDate(low), range.endDate));
        result.data.qaReceipts = read('qa_request_receipts', () => {
            const states = db.prepare('SELECT status,usageStatus,COUNT(*) AS count FROM qa_request_receipts WHERE createdAt>=? AND createdAt<? GROUP BY status,usageStatus').all(low,high);
            const earliest = db.prepare('SELECT MIN(createdAt) AS n FROM qa_request_receipts').get().n;
            return { requests: states.reduce((n,r) => n+r.count,0), states, earliest: earliest == null ? null : new Date(earliest).toISOString(),
                periodEvidence: !states.length && earliest >= high ? 'NO_RETAINED_DATA_BEFORE_FIRST_RECEIPT' : 'OBSERVED',
                scope: '기간 내 접수된 보존 영수증의 현재 최종 상태. 불확실 사용량은 청구 확인 전' };
        });
        const qaDetail = result.data.costs?.byType.find(r => r.type === 'qa');
        result.data.qaReconciliation = result.data.qaDaily && result.data.costs ? {
            detailedCalls: qaDetail?.calls || 0, dailyCalls: result.data.qaDaily.calls,
            callsDifference: (qaDetail?.calls || 0)-result.data.qaDaily.calls,
            costDifference: (qaDetail?.cost || 0)-result.data.qaDaily.cost
        } : null;
        if (result.data.qaReconciliation && (result.data.qaReconciliation.callsDifference || Math.abs(result.data.qaReconciliation.costDifference)>1e-8)) warnings.push({code:'QA_LEDGER_MISMATCH',source:'api_costs/qa_user_daily_costs'});
        result.data.grounding = read('gemini_monthly_grounding_usage', () => db.prepare('SELECT billingMonth,searchQueries FROM gemini_monthly_grounding_usage WHERE billingMonth>=? AND billingMonth<=? ORDER BY billingMonth').all(range.start.slice(0,7),new Date(high-1).toISOString().slice(0,7)));
        if (result.data.grounding?.length) warnings.push({code:'GROUNDING_WHOLE_BILLING_MONTH',source:'gemini_monthly_grounding_usage'});
        result.data.engagement = { retainedWatchRows: countPeriod('user_watch_histories','watchedAt'), retainedFavorites: countPeriod('user_favorites'),
            watchUsers: read('user_watch_histories',()=>db.prepare(`SELECT COUNT(DISTINCT userId) AS n FROM user_watch_histories WHERE ${where('watchedAt')}`).get(...bounds).n),
            comments: countPeriod('comments'), posts: countPeriod('posts'), postComments: countPeriod('post_comments'),
            notices: has('posts','is_notice') ? read('posts',()=>db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE ${where('createdAt')} AND is_notice=1`).get(...bounds).n) : null,
            actualPlays: null, favoriteClicks: null, monthlyActiveMembers: null };
        result.data.verifications = { attempts: countPeriod('user_verifications'), methods: group('user_verifications','verificationMethod',true),
            currentStatusesOfPeriodAttempts: group('user_verifications','status',true), decisionsInPeriod: has('user_verifications','verifiedAt') ? group('user_verifications','status',true,'verifiedAt') : null };
        result.data.donations = read('donations',()=>db.prepare(`SELECT COUNT(*) AS count,${zeroSum('amount')} AS amountKRW FROM donations WHERE ${where('donation_date')}`).get(...bounds));
        result.data.settings = read('settings',()=>db.prepare("SELECT key,value FROM settings WHERE key IN ('processingPaused','proxyCostPerGB') ORDER BY key").all());
        result.data.scriptsSnapshot = { tags: has('scripts','tag') ? group('scripts','tag') : null,
            validation: has('scripts','validation_status') ? group('scripts','validation_status') : null,
            ttsEligibility: has('scripts','tts_eligible') ? group('scripts','tts_eligible') : null,
            policyVersions: has('scripts','policy_version') ? group('scripts','policy_version') : null,
            provenancePresent: has('scripts','provenance_json') ? read('scripts',()=>db.prepare('SELECT COUNT(*) AS total,SUM(provenance_json IS NOT NULL) AS withProvenance FROM scripts').get()) : null,
            periodGeneratedEvents: null, scope: '수집 시점 전체 보존 대본. 생성시각 없음' };
        result.data.quarantine = { periodCount: countPeriod('script_quarantine'), periodReasons: group('script_quarantine','reason_code',true) };
        result.data.qaCacheSnapshot = { jobs: group('qa_cache_jobs','state'), subtitles: group('qa_subtitle_assets','state'),
            frameKinds: group('qa_frame_assets','sourceKind'), subtitleProvenance: group('qa_subtitle_assets','provenance'),
            expiredOwnedLeases: read('qa_cache_jobs',()=>db.prepare('SELECT COUNT(*) AS n FROM qa_cache_jobs WHERE owner IS NOT NULL AND leaseUntil<=?').get(now).n), scope:'수집 시점 현재 상태. 조회 월의 캐시 작업 발생 수가 아님' };
        const earliestApi = read('api_requests',()=>db.prepare('SELECT MIN(createdAt) AS first FROM api_requests').get().first);
        const apiRead = read('api_requests',()=>db.prepare(`SELECT userId,guestId,ip,apiPath,createdAt FROM api_requests WHERE ${where('createdAt')} ORDER BY createdAt`).all(...bounds));
        apiRows = apiRead || [];
        const routeMap=new Map(), dayMap=new Map(), allUsers=new Set(), allGuests=new Set();
        for (const row of apiRows) {
            const key=routeGroup(row.apiPath), day=kstDate(parseInstant(row.createdAt));
            if (!routeMap.has(key)) routeMap.set(key,{route:key,requests:0,memberRequests:0,guestRequests:0,users:new Set()});
            const r=routeMap.get(key);r.requests++;
            if(row.userId){r.memberRequests++;r.users.add(row.userId);allUsers.add(row.userId);}else{r.guestRequests++;if(row.guestId)allGuests.add(row.guestId);}
            if(!dayMap.has(day))dayMap.set(day,{date:day,requests:0,users:new Set()});
            dayMap.get(day).requests++;if(row.userId)dayMap.get(day).users.add(row.userId);
        }
        result.data.api = apiRead !== null ? {requests:apiRows.length, uniqueAuthenticatedUsers:allUsers.size,uniqueGuestIds:allGuests.size,
            earliest:earliestApi, routes:[...routeMap.values()].map(r=>({...r,users:r.users.size})).sort((a,b)=>b.requests-a.requests),
            daily:[...dayMap.values()].map(r=>({...r,users:r.users.size})),scope:'추적된 API 요청. 성공·실제 재생·고유 사람 수가 아님'} : null;
        if(!Number.isFinite(parseInstant(earliestApi)) || low<parseInstant(earliestApi))warnings.push({code:'API_LOGGING_NOT_AVAILABLE_FOR_FULL_PERIOD',source:'api_requests'});
        // Aggregate description costs before joining videos: never multiply video counts/durations.
        result.data.descriptionAccounting = read('api_costs',()=>{
            if(!schema.videos || !has('api_costs','request_type'))return null;
            const base=`WITH c AS (SELECT videoId,SUM(cost) AS cost,MAX(julianday(createdAt)) AS lastCost FROM api_costs WHERE request_type='description' GROUP BY videoId) `;
            const row=db.prepare(base+`SELECT COUNT(*) AS completedVideos,${zeroSum('c.cost IS NULL')} AS missingDescriptionCost,AVG(CASE WHEN (c.lastCost-julianday(v.createdAt))*86400 BETWEEN 0 AND 10800 THEN (c.lastCost-julianday(v.createdAt))*86400 END) AS costRecordDelaySeconds FROM videos v LEFT JOIN c ON c.videoId=v.videoId WHERE ${where('v.createdAt')} AND v.status='completed'`).get(...bounds);
            row.topRequesters=db.prepare(base+`SELECT COUNT(*) AS videos,${zeroSum("CASE WHEN v.status='completed' THEN v.duration ELSE 0 END")} AS completedSeconds,${zeroSum('COALESCE(c.cost,0)')} AS lifetimeDescriptionCostOfRegisteredVideos FROM videos v LEFT JOIN c ON c.videoId=v.videoId WHERE ${where('v.createdAt')} AND v.requested_by IS NOT NULL GROUP BY v.requested_by ORDER BY videos DESC LIMIT 10`).all(...bounds);
            row.topCostVideos=db.prepare(`SELECT SUM(cost) AS cost,COUNT(*) AS calls FROM api_costs WHERE ${where('createdAt')} AND request_type='description' GROUP BY videoId ORDER BY cost DESC LIMIT 5`).all(...bounds);
            row.actualBuildLatency=null;row.scope='완료시각 대신 설명 비용 기록 지연을 참고 추정. 순위 비용은 해당 등록 영상의 보존 전체 설명 비용';return row;
        });
    }).deferred();
    // Ephemeral identity used only for matching; never emitted to report files.
    const apiIndex=new Map();
    for(const row of apiRows){if(!row.userId)continue; const ip=String(row.ip).split(',')[0].trim();if(!apiIndex.has(ip))apiIndex.set(ip,[]);apiIndex.get(ip).push(parseInstant(row.createdAt));}
    for(const times of apiIndex.values())times.sort((a,b)=>a-b);
    function matchesMember(ip,time){const times=apiIndex.get(ip)||[];let lo=0,hi=times.length;while(lo<hi){const mid=(lo+hi)>>1;if(times[mid]<time-5000)lo=mid+1;else hi=mid;}return lo<times.length&&times[lo]<=time+5000;}
    const assetRows=[...(read('qa_frame_assets',()=>db.prepare('SELECT relativePath FROM qa_frame_assets').all())||[]),...(read('qa_subtitle_assets',()=>db.prepare("SELECT relativePath FROM qa_subtitle_assets WHERE state='ready' AND relativePath IS NOT NULL").all())||[])];
    db.close();
    const sourceStatus={};
    async function lines(file,callback,status){
        let input;
        try{
            const stream=fs.createReadStream(file);input=file.endsWith('.gz')?stream.pipe(zlib.createGunzip()):stream;
            const errorPromise=new Promise((resolve,reject)=>{stream.on('error',reject);input.on('error',reject);});
            errorPromise.catch(()=>{});
            const consume=(async()=>{for await(const line of readline.createInterface({input,crlfDelay:Infinity})){status.lines++;callback(line);}})();
            await Promise.race([consume,errorPromise]);status.readFiles++;
        }catch(e){input?.destroy();status.readErrors++;warnings.push({code:'LOG_READ_FAILED',source:status.kind,errorCode:e.code||'PARSE_ERROR',file:path.basename(file)});}
    }
    function fileList(dir,filter,kind){const status={kind,files:0,readFiles:0,readErrors:0,lines:0,unparsedLines:0,periodLines:0,days:new Set(),earliest:null,latest:null};sourceStatus[kind]=status;try{const files=fs.readdirSync(dir).filter(filter).map(n=>path.join(dir,n));status.files=files.length;return {status,files};}catch(e){status.readErrors++;warnings.push({code:'LOG_SOURCE_UNAVAILABLE',source:kind,errorCode:e.code});return{status,files:[]};}}
    function observed(status,time){if(!Number.isFinite(time))return;status.earliest=status.earliest==null?time:Math.min(status.earliest,time);status.latest=status.latest==null?time:Math.max(status.latest,time);if(inRange(time)){status.periodLines++;status.days.add(kstDate(time));}}
    const nginx={requests:0,bytes:0,statuses:{},routes:{},methods:{},botRequests:0,humanVideoPageRequests:0,mobileRequests:0,pcRequests:0,memberMatchedRequests:0,unmatchedRequests:0,uniqueVideoPageIps:0,daily:[],searchKeywordTop:[]};
    const pageIps=new Set(), nginxDays=new Map(), keywords=new Map();
    const ns=fileList(config.nginxDir,n=>/^access\.log(?:\.\d+)?(?:\.gz)?$/.test(n),'nginxAccess');
    for(const file of ns.files)await lines(file,line=>{
        const r=parseNginx(line);if(!r){if(line.trim())ns.status.unparsedLines++;return;}observed(ns.status,r.time);if(!inRange(r.time))return;
        nginx.requests++;nginx.bytes+=r.bytes;const code=r.status.toString();nginx.statuses[code]=(nginx.statuses[code]||0)+1;
        const route=routeGroup(r.path);nginx.routes[route]=(nginx.routes[route]||0)+1;nginx.methods[r.method]=(nginx.methods[r.method]||0)+1;
        const bot=/bot|spider|crawler|curl|wget|python|headless|axios|go-http-client|zgrab|censys|shodan|nmap|masscan|okhttp/i.test(r.ua);
        if(bot){nginx.botRequests++;return;}
        const matched=matchesMember(r.ip,r.time);if(matched)nginx.memberMatchedRequests++;else nginx.unmatchedRequests++;
        if(route==='page.video'&&r.method==='GET'&&r.status>=200&&r.status<400){nginx.humanVideoPageRequests++;pageIps.add(r.ip);const day=kstDate(r.time);if(!nginxDays.has(day))nginxDays.set(day,{date:day,requests:0,ips:new Set()});nginxDays.get(day).requests++;nginxDays.get(day).ips.add(r.ip);}
        if(route!=='other'){if(/android|iphone|ipad|mobile/i.test(r.ua))nginx.mobileRequests++;else nginx.pcRequests++;}
        if(route==='search'){try{const u=new URL(r.path,'http://localhost');const q=(u.searchParams.get('q')||u.searchParams.get('query')||'').trim();if(q)keywords.set(q,(keywords.get(q)||0)+1);}catch{}}
    },ns.status);
    nginx.uniqueVideoPageIps=pageIps.size;nginx.daily=[...nginxDays.values()].map(d=>({...d,ips:d.ips.size})).sort((a,b)=>a.date.localeCompare(b.date));
    // Keyword content can contain personal information; output counts only.
    nginx.searchKeywordTop=[...keywords.values()].sort((a,b)=>b-a).slice(0,10).map((count,i)=>({rank:i+1,count}));
    result.data.nginx=nginx;
    const backend={levels:{},qaEvents:{},qaFailureCodes:{},statisticsEvents:0,firstAudioSamples:0,firstAudioMsAverage:null};let audioTotal=0;
    const bs=fileList(config.backendLogDir,n=>/^\d{4}-\d{2}-\d{2}\.log(?:\.gz)?$/.test(n),'backendLogs');
    for(const file of bs.files){const day=path.basename(file).slice(0,10);if(day<kstDate(low)||day>range.endDate)continue;await lines(file,line=>{
        const m=line.match(/^\[([^\]]+)\] \[(INFO|WARN|ERROR)\] (.*)$/);if(!m){if(line.trim())bs.status.unparsedLines++;return;}
        const time=Date.parse(m[1].replace(' ','T')+'+09:00');observed(bs.status,time);if(!inRange(time))return;backend.levels[m[2]]=(backend.levels[m[2]]||0)+1;
        const marker=m[3].match(/\[(QA-MEDIA|QA-GENERATION|QA-TTS|QA-COST|QA-COST-ERROR|STATISTICS)\]/);if(!marker)return;
        let event=marker[1];if(marker[1]==='STATISTICS')backend.statisticsEvents++;
        if(marker[1]==='QA-MEDIA'||marker[1]==='QA-GENERATION'){try{const payload=JSON.parse(m[3].slice(m[3].indexOf('{')));if(/^[a-z_]{1,64}$/.test(payload.event||''))event+=':'+payload.event;if(/^[A-Z_]{1,80}$/.test(payload.code||''))backend.qaFailureCodes[payload.code]=(backend.qaFailureCodes[payload.code]||0)+1;}catch{bs.status.unparsedLines++;}}
        backend.qaEvents[event]=(backend.qaEvents[event]||0)+1;
        const latency=m[3].match(/First audio: (\d+)ms/);if(latency){backend.firstAudioSamples++;audioTotal+=Number(latency[1]);}
    },bs.status);}
    backend.firstAudioMsAverage=backend.firstAudioSamples?audioTotal/backend.firstAudioSamples:null;result.data.backend=backend;
    // PM2 console lines without an explicit timestamp cannot be assigned to a month.
    const ps=fileList(config.pm2Dir,n=>/^youtube-describer(?:-backend)?-(?:out|error)(?:__[^/]+)?\.log(?:\.gz)?$/.test(n),'pm2');
    const pm2={timestampedPeriodLines:0,untimedLines:0,errorLevelLines:0};
    for(const file of ps.files)await lines(file,line=>{const m=line.match(/^(?:\[)?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))/);if(!m){if(line.trim())pm2.untimedLines++;return;}const time=parseInstant(m[1]);observed(ps.status,time);if(inRange(time)){pm2.timestampedPeriodLines++;if(/error|failed|exception/i.test(line))pm2.errorLevelLines++;}},ps.status);
    pm2.scope='시각이 있는 줄만 기간별 집계. 시각 없는 줄은 오류 0 또는 월간 전체 로그로 해석하지 않음';
    if(pm2.untimedLines)warnings.push({code:'PM2_UNTIMED_LINES_UNASSIGNABLE',source:'pm2'});result.data.pm2=pm2;
    const es=fileList(config.nginxDir,n=>/^error\.log(?:\.\d+)?(?:\.gz)?$/.test(n),'nginxError');
    const errors={periodLines:0,categories:{},timeZone:config.nginxErrorTimeZone};
    for(const file of es.files)await lines(file,line=>{const m=line.match(/^(\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d) \[([a-z]+)\]/);if(!m){if(line.trim())es.status.unparsedLines++;return;}if(!config.nginxErrorTimeZone){es.status.unparsedLines++;return;}const stamp=m[1].replaceAll('/','-').replace(' ','T')+config.nginxErrorTimeZone;const time=Date.parse(stamp);observed(es.status,time);if(!inRange(time))return;errors.periodLines++;const code=/upstream timed out/.test(line)?'upstream_timeout':/connect\(\) failed/.test(line)?'upstream_connection':/permission denied/.test(line)?'permission':m[2];errors.categories[code]=(errors.categories[code]||0)+1;},es.status);
    if(!config.nginxErrorTimeZone)warnings.push({code:'NGINX_ERROR_TIMEZONE_UNCONFIRMED',source:'nginxError'});result.data.nginxErrors=errors;
    async function diskTree(root){let files=0,bytes=0,periodModifiedFiles=0,readErrors=0;let available;try{available=(await fs.promises.stat(root)).isDirectory();}catch{available=false;}if(!available)return{available:false,files:null,bytes:null,periodModifiedFiles:null,readErrors:1,scope:'경로가 없거나 읽을 수 없어 측정 불가'};async function walk(dir){let entries;try{entries=await fs.promises.readdir(dir,{withFileTypes:true});}catch(e){readErrors++;return;}for(const entry of entries){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()){try{const stat=await fs.promises.stat(file);files++;bytes+=stat.size;if(inRange(stat.mtimeMs))periodModifiedFiles++;}catch{readErrors++;}}}}await walk(root);return{available:true,files,bytes,periodModifiedFiles,readErrors,scope:'수집 시점 남아 있는 파일. mtime은 합성/API 캐시 MISS 횟수가 아님'};}
    result.data.disk={};for(const [name,root] of Object.entries(config.cacheDirs||{})){result.data.disk[name]=await diskTree(root);if(result.data.disk[name].readErrors)warnings.push({code:'CACHE_SCAN_INCOMPLETE',source:name});}
    let missing=0,unsafe=0;for(const row of assetRows){const file=path.resolve(config.qaCacheRoot,row.relativePath||'');if(!file.startsWith(path.resolve(config.qaCacheRoot)+path.sep)){unsafe++;continue;}try{if(!fs.statSync(file).isFile())missing++;}catch{missing++;}}
    result.data.qaCacheSnapshot.filePresence={referenced:assetRows.length,missing,unsafe};
    result.data.tts={hitRate:null,synthesisCost:null,actualPlaybackLatency:null,scope:'영속적인 HIT/MISS·합성 비용·브라우저 재생 이벤트가 없어 측정 불가'};
    const expectedDays=[];for(let time=dateStart(kstDate(low));time<high;time+=86400000)expectedDays.push(kstDate(time));
    result.sources={};for(const [kind,status] of Object.entries(sourceStatus)){
        const days=[...status.days].sort();const value={...status,days,missingObservedDays:expectedDays.filter(d=>!status.days.has(d)),earliest:status.earliest==null?null:new Date(status.earliest).toISOString(),latest:status.latest==null?null:new Date(status.latest).toISOString()};
        if(kind==='backendLogs')value.missingDateFiles=expectedDays.filter(d=>!bs.files.some(file=>path.basename(file).startsWith(d+'.log')));
        if((kind==='nginxAccess'||kind==='backendLogs')&&(value.readErrors||value.missingObservedDays.length))warnings.push({code:'LOG_PERIOD_COVERAGE_INCOMPLETE',source:kind});
        result.sources[kind]=value;
    }
    return result;
}

const {formatReport}=require('./stats_text');
module.exports={parseInstant,dateStart,kstDate,makeRange,routeGroup,parseNginx,collectStats,formatReport};
