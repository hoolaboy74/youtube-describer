'use strict';

// Self-contained except for the timestamp/route helpers serialized with the collector.
function analyzeActivity({rows,profiles,registrations,videoTitles,range,now,earliest},{parseInstant,dateStart,kstDate,routeGroup}) {
    const dayMs=86400000,low=Date.parse(range.start),high=Date.parse(range.endExclusive),observedEnd=Math.min(high,now);
    const firstLog=parseInstant(earliest),profileMap=new Map((profiles||[]).map(p=>[p.id,p]));
    const coreRoutes=['description.request','description.script','tts.description','qa.request','qa.question.legacy','qa.audio','qa.audio.fetch','qa.tts.legacy'];
    const isCore=route=>coreRoutes.includes(route);
    const cleanRows=rows.map(r=>({...r,time:parseInstant(r.createdAt),route:routeGroup(r.apiPath)})).filter(r=>Number.isFinite(r.time)&&r.time<high);
    const current=cleanRows.filter(r=>r.time>=low),memberRows=current.filter(r=>r.userId);
    const unique=(list,core=false)=>new Set(list.filter(r=>r.userId&&(!core||isCore(r.route))).map(r=>r.userId));
    const pct=(n,d)=>d?n/d*100:null;
    const intersect=(a,b)=>[...a].filter(id=>b.has(id)).length;
    const earliestBoundary=Number.isFinite(firstLog)?firstLog:Infinity;
    const full=(a,b)=>a>=earliestBoundary&&b<=observedEnd;
    const counts=(list)=>({apiUsers:unique(list).size,coreUsers:unique(list,true).size,apiRequests:list.length,coreRequests:list.filter(r=>isCore(r.route)).length});
    const monday=date=>{const t=dateStart(date);return t-((new Date(t+9*3600000).getUTCDay()+6)%7)*dayMs;};
    const userMap=new Map(),routeMap=new Map(),dailyMap=new Map();
    for(const r of current) {
        const day=kstDate(r.time);
        if(!dailyMap.has(day))dailyMap.set(day,[]);dailyMap.get(day).push(r);
        if(!routeMap.has(r.route))routeMap.set(r.route,[]);routeMap.get(r.route).push(r);
        if(!r.userId)continue;
        if(!userMap.has(r.userId))userMap.set(r.userId,{id:r.userId,rows:[],days:new Set(),coreDays:new Set(),coreRequests:0});
        const u=userMap.get(r.userId);u.rows.push(r);u.days.add(day);
        if(isCore(r.route)){u.coreDays.add(day);u.coreRequests++;}
    }
    const daily=[];
    for(let t=dateStart(range.startDate);t<high;t+=dayMs) {
        const date=kstDate(t),list=dailyMap.get(date)||[],a=Math.max(low,t),b=Math.min(high,t+dayMs);
        const rolling=cleanRows.filter(r=>r.time>=t-6*dayMs&&r.time<b);
        daily.push({date,...counts(list),rolling7ApiUsers:unique(rolling).size,rolling7CoreUsers:unique(rolling,true).size,completeWindow:full(a,b),rolling7CompleteWindow:full(t-6*dayMs,b)});
    }
    const monthStarts=[];
    for(let date=range.startDate.slice(0,7)+'-01';date<=range.endDate;) {
        monthStarts.push(date);const t=new Date(date+'T00:00:00Z');t.setUTCMonth(t.getUTCMonth()+1);date=t.toISOString().slice(0,10);
    }
    const monthly=monthStarts.map(date=>{
        const a=dateStart(date),next=new Date(date+'T00:00:00Z');next.setUTCMonth(next.getUTCMonth()+1);const b=dateStart(next.toISOString().slice(0,10));
        const start=Math.max(low,a),end=Math.min(high,b),list=memberRows.filter(r=>r.time>=start&&r.time<end);
        return {month:date.slice(0,7),startDate:kstDate(start),endDate:kstDate(end-1),apiMau:unique(list).size,coreMau:unique(list,true).size,completeCalendarMonth:start===a&&end===b&&full(a,b)};
    });
    const weekly=[];
    for(let a=monday(range.startDate);a<high;a+=7*dayMs) {
        const b=a+7*dayMs,start=Math.max(a,low),end=Math.min(b,high),list=memberRows.filter(r=>r.time>=start&&r.time<end);
        weekly.push({weekStart:kstDate(a),startDate:kstDate(start),endDate:kstDate(end-1),apiWau:unique(list).size,coreWau:unique(list,true).size,completeCalendarWeek:start===a&&end===b&&full(a,b)});
    }
    const weekRetention=weekly.slice(0,-1).map((w,i)=>{
        const n=weekly[i+1],a=memberRows.filter(r=>kstDate(r.time)>=w.startDate&&kstDate(r.time)<=w.endDate),b=memberRows.filter(r=>kstDate(r.time)>=n.startDate&&kstDate(r.time)<=n.endDate);
        const mature=w.completeCalendarWeek&&n.completeCalendarWeek;
        const apiCohort=unique(a),coreCohort=unique(a,true);
        return {weekStart:w.weekStart,nextWeekStart:n.weekStart,completeWindows:mature,apiCohort:apiCohort.size,apiReturned:intersect(apiCohort,unique(b)),apiReturnRate:mature?pct(intersect(apiCohort,unique(b)),apiCohort.size):null,coreCohort:coreCohort.size,coreReturned:intersect(coreCohort,unique(b,true)),coreReturnRate:mature?pct(intersect(coreCohort,unique(b,true)),coreCohort.size):null};
    });
    const monthlyRetention=monthStarts.map(date=>{
        const a=dateStart(date),previous=new Date(date+'T00:00:00Z');previous.setUTCMonth(previous.getUTCMonth()-1);const p=dateStart(previous.toISOString().slice(0,10));
        const next=new Date(date+'T00:00:00Z');next.setUTCMonth(next.getUTCMonth()+1);const b=dateStart(next.toISOString().slice(0,10));
        const prev=cleanRows.filter(r=>r.time>=p&&r.time<a),cur=memberRows.filter(r=>r.time>=a&&r.time<b);
        const apiPrevious=unique(prev),corePrevious=unique(prev,true),complete=low<=a&&high>=b&&full(p,b);
        return {month:date.slice(0,7),previousMonth:kstDate(p).slice(0,7),completeWindows:complete,previousApiUsers:apiPrevious.size,returningApiUsers:intersect(apiPrevious,unique(cur)),apiReturnRate:complete?pct(intersect(apiPrevious,unique(cur)),apiPrevious.size):null,previousCoreUsers:corePrevious.size,returningCoreUsers:intersect(corePrevious,unique(cur,true)),coreReturnRate:complete?pct(intersect(corePrevious,unique(cur,true)),corePrevious.size):null};
    });
    const users=[...userMap.values()],apiSet=unique(memberRows),coreSet=unique(memberRows,true),coreTotal=users.reduce((n,u)=>n+u.coreRequests,0);
    const repeat={apiUsers:apiSet.size,apiRepeatUsers:users.filter(u=>u.days.size>=2).length,coreUsers:coreSet.size,coreRepeatUsers:users.filter(u=>u.coreDays.size>=2).length};
    repeat.apiRepeatRate=pct(repeat.apiRepeatUsers,repeat.apiUsers);repeat.coreRepeatRate=pct(repeat.coreRepeatUsers,repeat.coreUsers);
    repeat.activeDayDistribution=[['1일',1,1],['2~3일',2,3],['4~7일',4,7],['8~14일',8,14],['15일 이상',15,Infinity]].map(([bucket,a,b])=>({bucket,apiUsers:users.filter(u=>u.days.size>=a&&u.days.size<=b).length,coreUsers:users.filter(u=>u.coreDays.size>=a&&u.coreDays.size<=b).length}));
    const ranked=users.filter(u=>u.coreRequests>0).sort((a,b)=>b.coreRequests-a.coreRequests||b.coreDays.size-a.coreDays.size||a.id.localeCompare(b.id));
    const videoRows=registrations||[];
    const topActiveMembers=ranked.slice(0,10).map((u,i)=>{
        const profile=profileMap.get(u.id),vr=registrations===null?null:videoRows.filter(v=>v.requested_by===u.id);
        const routes=[...new Set(u.rows.map(r=>r.route))].map(route=>({route,requests:u.rows.filter(r=>r.route===route).length})).sort((a,b)=>b.requests-a.requests||a.route.localeCompare(b.route));
        return {rank:i+1,name:profile?.name??'식별정보 없음',email:profile?.email??null,apiRequests:u.rows.length,apiActiveDays:u.days.size,coreRequests:u.coreRequests,coreActiveDays:u.coreDays.size,coreRequestShare:pct(u.coreRequests,coreTotal),firstActivityAt:new Date(u.rows.reduce((n,r)=>Math.min(n,r.time),Infinity)).toISOString(),lastActivityAt:new Date(u.rows.reduce((n,r)=>Math.max(n,r.time),-Infinity)).toISOString(),routes,registeredVideos:vr?.length??null,completedVideos:vr?.filter(v=>v.status==='completed').length??null,failedVideos:vr?.filter(v=>v.status==='failed').length??null,registeredVideoList:vr?.map(v=>({videoId:v.videoId,title:v.title??'제목 기록 없음',status:v.status,durationSeconds:v.duration,registeredAt:v.createdAt}))??null};
    });
    const delays=[],newProfiles=profiles?.filter(p=>{const t=parseInstant(p.createdAt);return t>=low&&t<high;})??null;
    const onboarding=newProfiles===null?null:{newMembers:newProfiles.length,apiUsedMembers:0,coreUsedMembers:0,coreRepeatMembers:0,eligible7DayMembers:0,returnedWithin7DayMembers:0,uncoveredRegistrations:0};
    for(const p of newProfiles||[]) {
        const created=parseInstant(p.createdAt),list=memberRows.filter(r=>r.userId===p.id&&r.time>=created).sort((a,b)=>a.time-b.time),core=list.filter(r=>isCore(r.route));
        if(created<earliestBoundary)onboarding.uncoveredRegistrations++;
        if(list.length)onboarding.apiUsedMembers++;
        if(core.length){onboarding.coreUsedMembers++;if(created>=earliestBoundary)delays.push((core[0].time-created)/1000);}
        if(new Set(core.map(r=>kstDate(r.time))).size>=2)onboarding.coreRepeatMembers++;
        if(core.length&&created>=earliestBoundary&&core[0].time+7*dayMs<=observedEnd) {
            onboarding.eligible7DayMembers++;
            if(core.some(r=>kstDate(r.time)!==kstDate(core[0].time)&&r.time<=core[0].time+7*dayMs))onboarding.returnedWithin7DayMembers++;
        }
    }
    if(onboarding) {
        delays.sort((a,b)=>a-b);const n=delays.length;
        Object.assign(onboarding,{firstCoreDelaySamples:n,firstCoreDelayAverageSeconds:n?delays.reduce((a,b)=>a+b,0)/n:null,firstCoreDelayMedianSeconds:n?(delays[Math.floor((n-1)/2)]+delays[Math.floor(n/2)])/2:null,coreActivationRate:onboarding.uncoveredRegistrations?null:pct(onboarding.coreUsedMembers,onboarding.newMembers),returnWithin7DayRate:pct(onboarding.returnedWithin7DayMembers,onboarding.eligible7DayMembers)});
    }
    const byVideo=new Map();
    for(const r of current) {
        const p=String(r.apiPath).split('?')[0].replace(/^\/api(?=\/)/,''),match=/^\/(script|video|video-exists|comments)\/([A-Za-z0-9_-]{11})$/.exec(p);
        if(!match)continue;
        const id=match[2];if(!byVideo.has(id))byVideo.set(id,{videoId:id,requests:0,users:new Set(),scriptRequests:0,scriptUsers:new Set()});
        const v=byVideo.get(id);v.requests++;if(r.userId)v.users.add(r.userId);
        if(match[1]==='script'){v.scriptRequests++;if(r.userId)v.scriptUsers.add(r.userId);}
    }
    const functions=[...routeMap.entries()].map(([route,list])=>({route,...counts(list),memberRequests:list.filter(r=>r.userId).length,guestRequests:list.filter(r=>!r.userId).length,activeDays:new Set(list.filter(r=>r.userId).map(r=>kstDate(r.time))).size})).sort((a,b)=>b.apiRequests-a.apiRequests||a.route.localeCompare(b.route));
    const functionDaily=[...dailyMap.entries()].sort(([a],[b])=>a.localeCompare(b)).flatMap(([date,list])=>[...new Set(list.map(r=>r.route))].sort().map(route=>{const filtered=list.filter(r=>r.route===route);return {date,route,apiUsers:unique(filtered).size,apiRequests:filtered.length,memberRequests:filtered.filter(r=>r.userId).length,guestRequests:filtered.filter(r=>!r.userId).length};}));
    const titleMap=new Map((videoTitles||registrations||[]).map(v=>[v.videoId,v.title]));
    return {definitions:{apiActive:'유효 토큰의 회원 ID가 기록된 API를 1회 이상 이용. 관리자·로그인·조회 요청 포함.',coreActive:'해설 생성·대본 조회·해설 TTS·Q&A 질문/음성 요청을 1회 이상 이용. 검색·인증·댓글 조회·상태 확인·Q&A 이벤트 연결/취소/접속 유지 제외.',coreRoutes,calendar:'한국 시간, 일별 00:00 경계, 주별 월요일~일요일. 주·월 경계의 기간 밖 자료는 WAU/MAU에서 제외하고 부분 기간으로 표시.',repeat:'기간 내 서로 다른 한국 날짜에 2회 이상 이용한 회원. 요청 성공·실제 청취·클릭을 보장하지 않음.',retention:'직전 주/월 이용 회원 중 다음 주/월에도 이용한 비율. 두 관측 구간이 완전할 때만 비율 표시.',onboarding:'기간 내 가입 회원의 같은 기간 첫 핵심 이용 지연과 반복 이용. 7일 재이용률은 첫 핵심 이용 후 7일을 끝까지 관측한 회원만 분모.',ranking:'핵심 기능 API 요청 수 내림차순 → 핵심 이용 일수 내림차순. 요청 수는 오디오 조각·재시도에 영향을 받으며 실제 이용 시간 순위가 아님.',coverage:'completeWindow는 최초 보존 로그 시각·수집 시각·조회 경계 기준. 로그 삭제/누락이나 추적되지 않은 요청까지 검증한 의미는 아님.',identity:'상위 회원 이름·이메일은 내부 통계용. IP·비밀번호·질문/답변·티켓은 제외.',videoActivity:'영상 ID가 경로에 포함된 대본·영상·댓글 조회/존재 확인 요청. /tts·/process 등의 본문은 미기록이므로 영상별 음성·생성 요청으로 해석하지 않음.'},summary:{apiActiveMembers:apiSet.size,coreActiveMembers:coreSet.size,averageApiDau:daily.length?daily.reduce((n,d)=>n+d.apiUsers,0)/daily.length:null,averageCoreDau:daily.length?daily.reduce((n,d)=>n+d.coreUsers,0)/daily.length:null,maxApiDau:daily.length?Math.max(...daily.map(d=>d.apiUsers)):null,maxCoreDau:daily.length?Math.max(...daily.map(d=>d.coreUsers)):null,averageDauCompleteWindow:full(low,high),coreMemberRequests:coreTotal,top10CoreRequestShare:pct(topActiveMembers.reduce((n,u)=>n+u.coreRequests,0),coreTotal)},daily,weekly,monthly,repeat,weeklyRetention:weekRetention,monthlyRetention,onboarding,functions,functionDaily,topActiveMembers,videoActivity:[...byVideo.values()].map(v=>({...v,title:titleMap.get(v.videoId)??'제목 기록 없음',users:v.users.size,scriptUsers:v.scriptUsers.size})).sort((a,b)=>b.scriptRequests-a.scriptRequests||b.requests-a.requests||a.videoId.localeCompare(b.videoId))};
}
module.exports={analyzeActivity};
