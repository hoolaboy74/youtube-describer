'use strict';

// Presentation only: never change the collected values or infer missing events.
const sections={members:'회원 가입 및 현재 인증 상태',videos:'기간 내 등록 영상 및 현재 처리 상태',costs:'AI API 비용',qaDaily:'Q&A 일별 비용 요약',qaReceipts:'Q&A 요청 기록',qaReconciliation:'Q&A 상세·일별 비용 대조',grounding:'검색 사용량 — 청구 월 전체',engagement:'보존된 시청·즐겨찾기·커뮤니티 이력',verifications:'회원 인증 이력',donations:'후원금 수입',settings:'현재 운영 설정',scriptsSnapshot:'현재 전체 대본 검증 상태',quarantine:'기간 내 대본 검증 격리',qaCacheSnapshot:'현재 Q&A 캐시 상태',api:'API 기능별 요청 및 인증 회원',descriptionAccounting:'영상별 설명 비용 및 비용 기록 지연',nginx:'웹 서버 접속 요청',backend:'백엔드 기능별 로그',pm2:'서비스 프로세스 로그',nginxErrors:'웹 서버 오류 로그',disk:'현재 디스크·캐시 파일',tts:'TTS 측정 현황'};
const names={
    registered:'등록 영상(개)',completed:'완료 상태(개)',failed:'실패 상태(개)',completedSeconds:'완료 영상 총 길이',completedDuration:'완료 영상 총 길이',averageSeconds:'평균 영상 길이',new:'신규 회원(명)',verifiedNew:'현재 인증된 신규 회원(명)',currentTotal:'현재 전체 회원(명)',newAuthMethods:'신규 회원 인증 방법',currentSegments:'현재 회원 인증 구분',memberRegistered:'회원 등록 영상(개)',verifiedRegistered:'현재 인증 회원의 등록 영상(개)',successRate:'현재 완료 상태 비율',memberRate:'회원 등록 비율',statuses:'상태별 집계',daily:'일별 집계',hours:'시간대별 등록',weekdays:'요일별 등록',hour:'시각(한국 시간)',weekday:'요일',durationBuckets:'길이 구간별 등록',bucket:'길이 구간',minSeconds:'최소 영상 길이',maxSeconds:'최대 영상 길이',languages:'음성 언어별 등록',failureCategories:'실패 유형',downloadBytes:'다운로드 용량',total:'합계',descriptionCost:'설명 API 비용',qaCost:'Q&A API 비용',calls:'원장 호출(건)',requests:'요청(건)',uniqueAuthenticatedUsers:'고유 인증 회원(명)',uniqueGuestIds:'고유 비회원 식별자(개)',retainedWatchRows:'보존된 시청 이력(건)',retainedFavorites:'보존된 즐겨찾기(건)',watchUsers:'시청 이력 보유 회원(명)',actualPlays:'실제 재생 횟수',favoriteClicks:'즐겨찾기 클릭 횟수',monthlyActiveMembers:'월간 활성 회원',comments:'영상 댓글(건)',posts:'게시글(건)',postComments:'게시글 댓글(건)',notices:'공지(건)',scope:'집계 기준',date:'날짜',count:'건수',amountKRW:'후원금 수입',hitRate:'실제 TTS 캐시 적중률',synthesisCost:'TTS 합성 비용',actualPlaybackLatency:'실제 첫 음성 재생 지연',readErrors:'읽기 실패(건)',missingObservedDays:'로그가 관측되지 않은 날짜',missingDateFiles:'누락된 일별 로그 날짜',periodModifiedFiles:'기간 내 수정된 잔존 파일(개)',
    byType:'기능별 비용',byModel:'모델별 비용',type:'기능',model:'모델',cost:'비용',breakdownRecordedCalls:'세부 비용 기록 호출(건)',breakdownStatus:'세부 기록 상태',legacyCalls:'구형 원장 호출(건)',pricingVersions:'가격 버전',image_tokens:'이미지 토큰',text_tokens:'텍스트 토큰',input_tokens:'입력 토큰',output_tokens:'출력 토큰',thinking_tokens:'추론 토큰',cached_tokens:'캐시 토큰',tool_tokens:'도구 토큰',search_queries:'검색 호출',input_cost:'입력 비용',output_cost:'출력 비용',cached_cost:'캐시 비용',tool_cost:'도구 비용',search_cost:'검색 비용',rows:'원장 행(건)',users:'회원(명)',videos:'영상(개)',states:'현재 최종 상태',earliest:'최초 관측 시각',latest:'최종 관측 시각',periodEvidence:'기간 자료 상태',detailedCalls:'상세 원장 호출(건)',dailyCalls:'일별 원장 호출(건)',callsDifference:'호출 수 차이(건)',costDifference:'비용 차이',attempts:'인증 시도(건)',methods:'방법별 집계',currentStatusesOfPeriodAttempts:'기간 내 신청의 현재 상태',decisionsInPeriod:'기간 내 인증 결정',key:'설정 항목',value:'구분',tags:'대본 태그',validation:'검증 상태',ttsEligibility:'TTS 적격 여부',policyVersions:'정책 버전',provenancePresent:'근거 기록 현황',withProvenance:'근거가 기록된 대본(개)',periodGeneratedEvents:'기간 내 대본 생성 횟수',periodCount:'격리된 대본(개)',periodReasons:'격리 사유',jobs:'캐시 작업 상태',subtitles:'자막 상태',frameKinds:'프레임 종류',subtitleProvenance:'자막 출처',expiredOwnedLeases:'만료된 작업 점유(건)',filePresence:'참조 파일 확인',referenced:'참조 파일(개)',missing:'없는 참조 파일(개)',unsafe:'안전하지 않은 경로(개)',
    routes:'기능별 요청',route:'기능',memberRequests:'회원 요청(건)',guestRequests:'비회원 요청(건)',searchKeywordTop:'검색어별 횟수 순위(원문 제외)',rank:'순위',completedVideos:'완료 상태 영상(개)',missingDescriptionCost:'설명 비용 미기록 영상(개)',costRecordDelaySeconds:'비용 기록까지 평균 지연(실제 완료 시간 아님)',topRequesters:'요청자별 등록 영상 순위(익명)',lifetimeDescriptionCostOfRegisteredVideos:'해당 영상의 전체 보존 설명 비용',topCostVideos:'설명 비용 상위 영상(익명)',actualBuildLatency:'실제 해설 생성 완료 지연',bytes:'용량',levels:'로그 수준별 집계',qaEvents:'Q&A 기능 이벤트',qaFailureCodes:'Q&A 실패 유형',statisticsEvents:'통계 이벤트(건)',firstAudioSamples:'첫 음성 지연 표본(건)',firstAudioMsAverage:'첫 음성 평균 지연',timestampedPeriodLines:'시각이 있는 기간 내 로그(줄)',untimedLines:'기간을 정할 수 없는 로그(줄)',errorLevelLines:'기간 내 오류 수준 로그(줄)',periodLines:'기간 내 로그(줄)',categories:'오류 유형별 집계',timeZone:'시간대',descriptionTts:'설명 TTS 캐시',legacyQaTts:'구형 Q&A TTS 캐시',qaMedia:'Q&A 미디어 캐시',temp:'임시 파일',available:'경로 조회 가능',files:'확인 대상 파일(개)',readFiles:'읽은 파일(개)',lines:'읽은 전체 로그(줄)',unparsedLines:'해석하지 못한 로그(줄)',days:'로그 관측 날짜',kind:'출처 종류',nginxAccess:'웹 서버 접속 로그',backendLogs:'백엔드 일별 로그',nginxError:'웹 서버 오류 로그',ips:'고유 IP(개, 사람 수 아님)',uniqueVideoPageIps:'영상 페이지 고유 IP(개)',botRequests:'자동화 추정 요청(건)',humanVideoPageRequests:'자동화 제외 영상 페이지 요청(건)',memberMatchedRequests:'회원 API와 시각·IP가 일치한 요청(건)',unmatchedRequests:'회원 API와 매칭되지 않은 요청(건)',mobileRequests:'모바일 요청(건)',pcRequests:'PC 요청(건)',billingMonth:'청구 월',searchQueries:'검색 호출(건)',updatedAt:'갱신 시각'
};
const values={completed:'완료',failed:'실패',queued:'대기',downloading:'다운로드 중',ready:'준비 완료',retryable_failed:'재시도 가능한 실패',absent:'없음',unknown:'알 수 없음',approved:'승인',unverified:'미인증',accepted:'검증 통과',siloam_api:'실로암 API',card_ocr:'복지카드 문자 인식',none:'없음',description:'화면 해설',qa:'Q&A',other:'기타',LEGACY_UNAVAILABLE:'구형 기록으로 세부 내역 확인 불가',NO_RETAINED_DATA_BEFORE_FIRST_RECEIPT:'조회 기간이 최초 보존 기록보다 앞서 있어 이용 여부 확인 불가',TIMESTAMP_OUT_OF_RANGE:'영상 길이를 벗어난 타임스탬프',keyframe:'핵심 프레임',window:'현재 구간 프레임',backfill:'전체 구간 보완 프레임',processingPaused:'영상 처리 일시 정지',proxyCostPerGB:'프록시 1GB당 비용(달러)',true:'예',false:'아니오','tts.description':'해설 음성','description.script':'해설 대본 조회','description.request':'해설 생성 요청',auth:'로그인·인증','account.favorites':'즐겨찾기','account.watch_history':'시청 이력','account.other':'기타 계정 기능',search:'검색',admin:'관리',community:'커뮤니티','page.home':'홈 페이지','page.video':'영상 페이지','qa.other':'기타 Q&A'};
const label=k=>names[k]||sections[k]||values[k]||k;
Object.assign(names,{completedDuration:'완료 영상 길이 범위',other_or_unknown:'기타·원인 불명',download:'다운로드 실패',error:'오류',crit:'심각한 오류',upstream_connection:'백엔드 연결 오류',INFO:'일반 정보',ERROR:'오류',WARN:'주의'});
Object.assign(values,{korean:'한국어',mixed:'한국어·외국어 혼합',foreign:'외국어',under5min:'5분 미만','5to15min':'5분 이상 ~ 15분 미만','15to30min':'15분 이상 ~ 30분 미만','30minPlus':'30분 이상',RECORDED:'세부 기록 있음',PARTIAL:'세부 기록 일부 있음'});
const number=(n,d=2)=>n.toLocaleString('ko-KR',{maximumFractionDigits:d});
const duration=n=>{const sec=Math.round(n),h=Math.floor(sec/3600),m=Math.floor(sec%3600/60);return [h?`${h}시간`:null,m?`${m}분`:null,`${sec%60}초`].filter(Boolean).join(' ');};
function timestamp(v) {
    if(v==null)return '확인 불가';
    const normalized=String(v).replace(' ','T');
    const t=Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)?normalized:normalized+'Z');
    return Number.isFinite(t)?new Date(t+9*3600000).toISOString().replace('T',' ').replace(/\.\d{3}Z$/,' (한국 시간)'):v;
}
function scalar(v,k='',context='') {
    if(v==null)return '확인 불가 (미측정 또는 자료 없음)';
    if(typeof v==='boolean')return v?'예':'아니오';
    if(typeof v==='number') {
        if(/Seconds$|^completedDuration$/.test(k))return duration(v);
        if(k==='firstAudioMsAverage')return number(v)+' ms';
        if(/Rate$|^hitRate$/.test(k))return number(v)+'%';
        if(k==='amountKRW')return number(v)+'원';
        if((/cost/i.test(k)&&k!=='missingDescriptionCost')||(k==='total'&&context==='costs'))return '$'+number(v,6);
        if(/Bytes$|^bytes$/.test(k))return number(v/1024**3,3)+' GiB ('+number(v,0)+'바이트)';
        if(k==='weekday')return ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'][v]||String(v);
        if(k==='value'&&context==='currentSegments')return v===1?'인증 회원':'미인증 회원';
        if(k==='value'&&context==='ttsEligibility')return v===1?'TTS 가능':'TTS 제외';
        return number(v);
    }
    if(['earliest','latest','updatedAt'].includes(k))return timestamp(v);
    if(k==='weekday')return ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'][Number(v)]||String(v);
    return values[v]||String(v).replace(/[\r\n\t]/g,' ');
}

function formatReport(report) {
    const lines=['뷰래이터 운영 통계 보고서','='.repeat(48),`조회 기간: ${report.range.startDate} ~ ${report.range.endDate} (한국 시간)`,`자료 수집: ${timestamp(report.collectedAt)}`,'','핵심 요약','-'.repeat(48)];
    const d=report.data,m=d.members||{},v=d.videos||{},api=d.api||{},cost=d.costs||{},e=d.engagement||{};
    // Units live in labels, so unknown values never become “확인 불가명”.
    const summary=(title,n,key='',ctx='')=>lines.push('• '+title+': '+scalar(n,key,ctx));
    summary('신규 회원(명)',m.new);summary('현재 인증된 신규 회원(명)',m.verifiedNew);
    summary('등록 / 현재 완료 / 실패 영상(개)',[v.registered,v.completed,v.failed].map(n=>scalar(n)).join(' / '));
    summary('완료 영상 총 길이',v.completedSeconds,'completedSeconds');summary('현재 완료 상태 비율',v.successRate,'successRate');
    summary('AI API 기록 비용',cost.total==null?null:'$'+cost.total.toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2}));summary('비용 원장 호출(건)',cost.calls);
    summary('API 요청(건)',api.requests);summary('고유 인증 회원(명)',api.uniqueAuthenticatedUsers);
    summary('보존된 시청 이력 / 즐겨찾기(건)',[e.retainedWatchRows,e.retainedFavorites].map(n=>scalar(n)).join(' / '));
    lines.push('','※ 영상·인증 상태는 수집 시점 기준입니다. 시청 이력·즐겨찾기는 실제 재생·클릭 횟수가 아닙니다.');
    if(d.qaReceipts?.periodEvidence)lines.push('※ Q&A: '+scalar(d.qaReceipts.periodEvidence));
    lines.push('','자료를 읽기 전에','-'.repeat(48),...(report.limitations||[]).map(s=>'• '+s),'','수집 경고','-'.repeat(48));
    const warningMessages={LEGACY_COST_BREAKDOWN_UNAVAILABLE:'구형 비용 기록에는 입력·출력·검색 등 세부 비용이 없습니다.',PM2_UNTIMED_LINES_UNASSIGNABLE:'프로세스 로그에 시각이 없는 줄이 있어 조회 기간에 배정할 수 없습니다.',CACHE_SCAN_INCOMPLETE:'캐시 경로가 없거나 일부 파일을 읽지 못했습니다.',MISSING_TABLE:'필요한 테이블이 없습니다.',UNREVIEWED_TABLE:'새 테이블의 통계 수집 범위를 검토해야 합니다.',QUERY_FAILED:'통계 조회에 실패한 항목이 있습니다.'};
    for(const w of report.warnings||[])lines.push('• '+(warningMessages[w.code]||w.code)+' ['+label(w.source||'')+']'+(w.calls!=null?' — '+number(w.calls)+'건':'')+' ('+w.code+')');
    if(!report.warnings?.length)lines.push('추가 수집 경고 없음');
    function render(value,key,depth=0,context='') {
        const pad='  '.repeat(depth);
        if(value==null||typeof value!=='object'){lines.push(pad+label(key)+': '+scalar(value,key,context));return;}
        lines.push(pad+label(key));
        if(Array.isArray(value)) {
            if(!value.length){lines.push(pad+'  해당 집계에 보존된 항목 없음');return;}
            if(value.every(x=>typeof x!=='object'||x===null)){lines.push(pad+'  '+value.map(x=>scalar(x,key)).join(', '));return;}
            const keys=[...new Set(value.flatMap(x=>Object.keys(x||{})))];
            if(keys.length<=6&&value.every(x=>x&&Object.values(x).every(v=>v===null||typeof v!=='object'))){
                const rows=[keys.map(label),...value.map(row=>keys.map(k=>scalar(row[k],k,key)))];
                const width=s=>Array.from(s).reduce((n,c)=>n+(/[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff01-\uff60]/.test(c)?2:1),0);
                const widths=keys.map((_,i)=>Math.max(...rows.map(row=>width(row[i]))));
                const tableRow=row=>pad+'  '+row.map((cell,i)=>cell+' '.repeat(widths[i]-width(cell))).join(' | ').trimEnd();
                lines.push(tableRow(rows[0]),pad+'  '+widths.map(w=>'-'.repeat(w)).join('-+-'));
                for(const row of rows.slice(1))lines.push(tableRow(row));
            }else for(const [i,row] of value.entries()){lines.push(pad+'  항목 '+(i+1));for(const [k,val] of Object.entries(row))render(val,k,depth+2,key);}
        }else if(key==='methods'&&Object.values(value).every(x=>typeof x==='number')) {
            // Keep all counts without printing binary probe payloads as HTTP methods.
            const bad=Object.entries(value).filter(([k])=>! /^[A-Z]{1,20}$/.test(k));
            for(const [k,n] of Object.entries(value))if(/^[A-Z]{1,20}$/.test(k))lines.push(pad+'  '+k+': '+number(n)+'건');
            if(bad.length)lines.push(pad+'  비정상 요청 방식(원문 생략): '+number(bad.reduce((n,[,c])=>n+c,0))+'건 / '+number(bad.length)+'종류');
        }else for(const [k,val] of Object.entries(value)) {
            if(key==='failureCategories'&&k==='model')lines.push(pad+'  AI 모델 처리 실패: '+scalar(val));
            else render(val,k,depth+1,key);
        }
    }
    let i=1;
    for(const [key,value] of Object.entries(d)) {
        lines.push('',`${i++}. ${sections[key]||key}`,'-'.repeat(48));
        if(value&&typeof value==='object'&&!Array.isArray(value)){for(const [k,val] of Object.entries(value))render(val,k,0,key);}else render(value,key);
    }
    lines.push('','부록 A. 로그 수집 범위','-'.repeat(48));
    for(const [key,s] of Object.entries(report.sources||{})) {
        lines.push('',label(key));
        for(const [k,val] of Object.entries(s)) {
            if(k==='kind')continue;
            if(k==='days'&&Array.isArray(val)){lines.push('  관측 날짜: '+(val.length?val[0]+' ~ '+val[val.length-1]+' / '+val.length+'일':'관측된 날짜 없음'));continue;}
            if(['missingObservedDays','missingDateFiles'].includes(k)&&Array.isArray(val)){lines.push('  '+label(k)+': '+(val.length?val.join(', '):'없음'));continue;}
            render(val,k,1);
        }
    }
    lines.push('','부록 B. DB 테이블 수집 범위','-'.repeat(48),`확인한 테이블: ${(report.coverage||[]).length}개`,'테이블 | 수집 범위 | 컬럼 수');
    const scopes={api_costs:'기간 내 상세 API 비용',api_requests:'기간 내 기능·회원·일별 요청',comments:'보존된 영상 댓글',donations:'기간 내 후원금 수입',gemini_monthly_grounding_usage:'청구 월 전체 검색 사용량',post_comments:'보존된 게시글 댓글',posts:'보존된 게시글·공지',qa_cache_jobs:'현재 Q&A 캐시 작업',qa_frame_assets:'현재 Q&A 프레임',qa_request_receipts:'기간 내 Q&A 요청과 현재 최종 상태',qa_subtitle_assets:'현재 Q&A 자막',qa_user_daily_costs:'기간 내 Q&A 일별 비용 대조',script_quarantine:'기간 내 대본 검증 격리',scripts:'현재 전체 대본의 검증·근거·TTS 상태',settings:'허용된 현재 운영 설정',user_favorites:'보존된 즐겨찾기',user_verifications:'기간 내 인증 신청·결정',user_watch_histories:'보존된 시청 이력',users:'기간 내 가입 및 현재 인증',videos:'기간 내 등록 영상과 현재 상태'};
    for(const row of report.coverage||[])lines.push(row.table+' | '+(scopes[row.table]||row.scope)+' | '+(row.columns?.length??'확인 불가'));
    lines.push('','부록 C. 집계 기준 및 원자료','-'.repeat(48),`실제 UTC 범위: ${report.range.start} 이상 ~ ${report.range.endExclusive} 미만`,'숫자는 표시 자리에서 반올림했습니다. 비용은 최대 소수 6자리, 시간은 초 단위입니다.','원래 정밀도, 전체 DB 컬럼 목록, 비정상 요청 방식 원문은 같은 이름의 JSON에 있습니다.','');
    return lines.join('\n');
}
module.exports={formatReport};
if(require.main===module) {
    const fs=require('node:fs'),path=require('node:path');
    const [input,output]=process.argv.slice(2);
    if(!input||!input.endsWith('.json'))throw new Error('사용법: node stats_text.js INPUT.json [OUTPUT.txt]');
    const destination=path.resolve(output||input.replace(/\.json$/,'.txt'));
    if(destination===path.resolve(input))throw new Error('JSON 원자료를 덮어쓸 수 없습니다.');
    const report=JSON.parse(fs.readFileSync(input,'utf8'));
    if(report.schemaVersion!==2)throw new Error('지원하지 않는 통계 버전');
    fs.writeFileSync(destination+'.pending',formatReport(report));
    fs.renameSync(destination+'.pending',destination);
    console.log('TXT 생성: '+destination);
}
