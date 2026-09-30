'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), zlib=require('node:zlib');
const Database=require('../../../../backend/node_modules/better-sqlite3');
const {parseInstant,dateStart,makeRange,parseNginx,collectStats,routeGroup,formatReport}=require('./stats_core');

test('strict calendar dates, KST exclusive boundary, registration cutoff, mixed timestamp formats',()=>{
    assert.throws(()=>dateStart('2026-02-29'));assert.throws(()=>dateStart('2026-08-32'));assert.throws(()=>makeRange('2026-09-01','2026-08-31',null));
    const r=makeRange('2026-08-01','2026-08-31','2026-07-02 02:27:51');
    assert.equal(r.start,'2026-07-31T15:00:00.000Z');assert.equal(r.endExclusive,'2026-08-31T15:00:00.000Z');
    assert.equal(makeRange('2026-07-01','2026-07-31','2026-07-02 02:27:51').start,'2026-07-02T02:27:51.000Z');
    assert.equal(parseInstant('2026-08-01 00:00:00'),parseInstant('2026-08-01T00:00:00Z'));
    assert.equal(parseInstant(1234),1234);assert.ok(Number.isNaN(parseInstant('bad')));
});
test('Nginx timestamp offsets and opaque route/ticket redaction',()=>{
    const r=parseNginx('1.2.3.4 - - [01/Aug/2026:00:00:00 +0900] "GET /video/private-video HTTP/1.1" 200 2 "-" "Mozilla iPhone"');
    assert.equal(r.time,dateStart('2026-08-01'));assert.equal(routeGroup('/api/qa/audio/secret-ticket?token=secret'),'qa.audio.fetch');
    assert.equal(routeGroup('/qa/requests/private-id/events'),'qa.events');assert.equal(parseNginx('bad'),null);
});

function fixture(){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'stats-fixture-'));
    for(const name of ['nginx','logs','pm2','qa','audio/tts_cache','audio/qa_tts_cache','temp'])fs.mkdirSync(path.join(root,name),{recursive:true});
    const dbPath=path.join(root,'fixture.db'),db=new Database(dbPath);
    db.exec(`
      CREATE TABLE users(id TEXT,createdAt TEXT,is_blind INTEGER,blind_auth_method TEXT);
      INSERT INTO users VALUES('private-user','2026-07-02 02:27:51',1,'siloam_api'),('private-new','2026-07-31 15:00:00',1,'admin_manual');
      CREATE TABLE videos(videoId TEXT,createdAt TEXT,status TEXT,requested_by TEXT,duration INTEGER,filesize INTEGER,audio_language TEXT);
      INSERT INTO videos VALUES('a','2026-07-31 15:00:00','completed','private-user',10,10,'korean'),('b','2026-08-31T14:59:59.999Z','completed','private-user',20,20,'foreign'),('outside','2026-08-31 15:00:00','failed',NULL,100,0,NULL);
      CREATE TABLE api_costs(videoId TEXT,createdAt TEXT,request_type TEXT,model_used TEXT,cost REAL,pricing_version TEXT,input_tokens INTEGER);
      INSERT INTO api_costs VALUES('a','2026-08-01 00:00:00','description','model',1,NULL,0),('a','2026-08-01T00:00:01Z','description','model',2,NULL,0),('a','2026-08-02T00:00:00Z','qa','model',9,'price',10),('b','2026-08-31T14:59:59.999Z','description','model',4,'price',1),('outside','2026-08-31T15:00:00Z','description','model',99,'price',1);
      CREATE TABLE api_requests(userId TEXT,guestId TEXT,ip TEXT,apiPath TEXT,createdAt TEXT);
      INSERT INTO api_requests VALUES('private-user',NULL,'1.2.3.4','/qa/requests','2026-07-31 15:00:00'),(NULL,'private-guest','2.3.4.5','/qa/audio/private-ticket','2026-08-01 00:00:00');
      CREATE TABLE user_watch_histories(userId TEXT,videoId TEXT,watchedAt TEXT,UNIQUE(userId,videoId));
      INSERT INTO user_watch_histories VALUES('private-user','a','2026-08-01 00:00:00');
      CREATE TABLE user_favorites(createdAt TEXT); INSERT INTO user_favorites VALUES('2026-08-01 00:00:00');
      CREATE TABLE comments(createdAt TEXT); CREATE TABLE posts(createdAt TEXT,is_notice INTEGER); CREATE TABLE post_comments(createdAt TEXT);
      CREATE TABLE qa_user_daily_costs(logDate TEXT,queryCount INTEGER,totalCost REAL,userId TEXT,videoId TEXT);
      INSERT INTO qa_user_daily_costs VALUES('2026-08-02',1,8,'private-user','a');
      CREATE TABLE qa_request_receipts(createdAt INTEGER,status TEXT,usageStatus TEXT);
      CREATE TABLE qa_cache_jobs(state TEXT,owner TEXT,leaseUntil INTEGER);
      INSERT INTO qa_cache_jobs VALUES('downloading','private-owner',1);
      CREATE TABLE qa_frame_assets(sourceKind TEXT,relativePath TEXT);
      INSERT INTO qa_frame_assets VALUES('window','missing.jpg');
      CREATE TABLE qa_subtitle_assets(state TEXT,provenance TEXT,relativePath TEXT);
      CREATE TABLE gemini_monthly_grounding_usage(billingMonth TEXT,searchQueries INTEGER);
      CREATE TABLE scripts(tag TEXT,validation_status TEXT,tts_eligible INTEGER,policy_version TEXT,provenance_json TEXT);
      CREATE TABLE script_quarantine(createdAt TEXT,reason_code TEXT);
      INSERT INTO script_quarantine VALUES('2026-08-01 00:00:00','DUPLICATE_EVENT');
      CREATE TABLE user_verifications(createdAt TEXT,verifiedAt TEXT,verificationMethod TEXT,status TEXT);
      CREATE TABLE donations(donation_date TEXT,amount INTEGER);INSERT INTO donations VALUES('2026-08-01',10000);
      CREATE TABLE settings(key TEXT,value TEXT);INSERT INTO settings VALUES('admin_password','private-secret'),('processingPaused','false');
      CREATE TABLE new_unreviewed_table(x TEXT);
    `);
    db.prepare('INSERT INTO qa_request_receipts VALUES(?,?,?)').run(dateStart('2026-08-01'),'canceled','unconfirmed');db.close();
    const line=(day,ip='1.2.3.4',url='/video/private-video',status=200)=>`${ip} - - [${day} +0900] "GET ${url} HTTP/1.1" ${status} 100 "-" "Mozilla iPhone"\n`;
    fs.writeFileSync(path.join(root,'nginx/access.log'),line('01/Aug/2026:00:00:00')+line('01/Sep/2026:00:00:00')+'malformed\n');
    fs.writeFileSync(path.join(root,'nginx/access.log.1.gz'),zlib.gzipSync(line('31/Aug/2026:23:59:59','2.3.4.5')));
    fs.writeFileSync(path.join(root,'nginx/access.log.2.gz'),'damaged gzip');
    fs.writeFileSync(path.join(root,'logs/2026-08-01.log'),'[2026-08-01 01:00:00] [INFO] [QA-MEDIA] {"event":"window_hit","videoId":"private-video"}\n[2026-08-01 01:00:01] [WARN] [QA-GENERATION] {"event":"failed","code":"QA_CANCELED","requestId":"private-id"}\n');
    fs.writeFileSync(path.join(root,'pm2/youtube-describer-backend-error.log'),'private untimed error text\n');
    fs.writeFileSync(path.join(root,'pm2/test-youtube-describer-backend-error.log'),'2026-08-01T00:00:00Z ERROR should not be included\n');
    return{root,config:{startDate:'2026-08-01',endDate:'2026-08-31',now:dateStart('2026-09-30'),dbPath,sqliteModule:require.resolve('../../../../backend/node_modules/better-sqlite3'),nginxDir:path.join(root,'nginx'),backendLogDir:path.join(root,'logs'),pm2Dir:path.join(root,'pm2'),qaCacheRoot:path.join(root,'qa'),cacheDirs:{tts:path.join(root,'audio/tts_cache')}}};
}
test('full read-only collection: boundaries, nonmultiplying cost joins, QA reconciliation, log gaps and privacy',async()=>{
    const f=fixture();try{
        const before=fs.readFileSync(f.config.dbPath);const r=await collectStats(f.config);
        assert.equal(r.data.videos.registered,2);assert.equal(r.data.videos.completedSeconds,30);assert.equal(r.data.members.new,1);assert.equal(r.data.members.verifiedNew,1);
        assert.equal(r.data.costs.total,16);assert.equal(r.data.costs.descriptionCost,7);assert.equal(r.data.costs.qaCost,9);
        assert.equal(r.data.descriptionAccounting.topRequesters[0].videos,2);assert.equal(r.data.descriptionAccounting.topRequesters[0].completedSeconds,30);
        assert.equal(r.data.qaReceipts.requests,1);assert.equal(r.data.qaReceipts.states[0].usageStatus,'unconfirmed');assert.equal(r.data.qaReconciliation.costDifference,1);
        assert.equal(r.data.nginx.requests,2);assert.equal(r.data.nginx.uniqueVideoPageIps,2);assert.equal(r.data.nginx.memberMatchedRequests,1);
        assert.equal(r.data.backend.qaEvents['QA-MEDIA:window_hit'],1);assert.equal(r.data.backend.qaFailureCodes.QA_CANCELED,1);
        assert.equal(r.data.pm2.untimedLines,1);assert.equal(r.sources.pm2.files,1);assert.equal(r.sources.nginxAccess.readErrors,1);assert.equal(r.sources.nginxAccess.unparsedLines,1);
        assert.equal(r.data.engagement.actualPlays,null);assert.equal(r.data.tts.hitRate,null);assert.equal(r.data.qaCacheSnapshot.filePresence.missing,1);
        assert.equal(r.data.donations.amountKRW,10000);assert.equal(r.data.settings.length,1);
        assert.ok(r.warnings.some(w=>w.code==='QA_LEDGER_MISMATCH'));assert.ok(r.warnings.some(w=>w.code==='UNREVIEWED_TABLE'));assert.ok(r.sources.backendLogs.missingDateFiles.includes('2026-08-02'));
        const output=JSON.stringify(r)+formatReport(r);assert.ok(!/private-user|private-guest|private-ticket|private-secret|private-id|private-video|1\.2\.3\.4/.test(output));
        assert.deepEqual(fs.readFileSync(f.config.dbPath),before);
        const again=await collectStats(f.config);assert.deepEqual(again,r);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('missing optional tables are unavailable rather than fabricated zero',async()=>{
    const f=fixture();try{const db=new Database(f.config.dbPath);db.exec('DROP TABLE qa_request_receipts; DROP TABLE qa_user_daily_costs; DROP TABLE user_favorites;');db.close();const r=await collectStats(f.config);assert.equal(r.data.qaReceipts,null);assert.equal(r.data.qaDaily,null);assert.equal(r.data.engagement.retainedFavorites,null);assert.ok(r.warnings.some(w=>w.source==='qa_request_receipts'&&w.code==='MISSING_TABLE'));}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
