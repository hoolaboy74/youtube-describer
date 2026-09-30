#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const core = require('./stats_core');

async function main(argv = process.argv.slice(2)) {
    const positional = [], options = {};
    const valid = new Set(['output-dir','host','db','sqlite-module','nginx-dir','backend-log-dir','pm2-dir','qa-cache-root','audio-root','temp-root']);
    for (let i=0;i<argv.length;i++) {
        const arg=argv[i];
        if(arg==='--local'){options.local=true;continue;}
        if(arg.startsWith('--')){const key=arg.slice(2);if(!valid.has(key)||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('지원하지 않거나 값이 없는 옵션: '+arg);options[key]=argv[++i];}
        else positional.push(arg);
    }
    if(positional.length>2)throw new Error('사용법: node stats_collector.js [YYYY-MM-DD] [YYYY-MM-DD] [--output-dir DIR]');
    for(const date of positional)core.dateStart(date);
    if(positional.length===2 && core.dateStart(positional[0])>core.dateStart(positional[1]))throw new Error('시작일이 종료일보다 늦습니다.');
    const backend=options.local?path.resolve(__dirname,'../../../../backend'):'/app/youtube-describer/backend';
    const qaRoot=options['qa-cache-root']||path.join(backend,'cache/qa');
    const audio=options['audio-root']||path.join(backend,'public/audio');
    const config={startDate:positional[0],endDate:positional[1],dbPath:options.db||path.join(backend,'db/cache.db'),
        sqliteModule:options['sqlite-module']||path.join(backend,'node_modules/better-sqlite3'),
        nginxDir:options['nginx-dir']||'/var/log/nginx',backendLogDir:options['backend-log-dir']||path.join(backend,'logs'),
        pm2Dir:options['pm2-dir']||'/home/chacha/.pm2/logs',qaCacheRoot:qaRoot,
        cacheDirs:{descriptionTts:path.join(audio,'tts_cache'),legacyQaTts:path.join(audio,'qa_tts_cache'),qaMedia:qaRoot,temp:options['temp-root']||path.join(backend,'temp')}};
    console.log('운영 통계 수집 v2: 읽기 전용 DB 및 스트리밍 로그 분석을 시작합니다.');
    let report;
    if(options.local)report=await core.collectStats(config);
    else{
        const host=options.host||'mom';if(!/^[A-Za-z0-9_.@-]+$/.test(host)||host.startsWith('-'))throw new Error('잘못된 SSH 대상');
        const helpers=['parseInstant','dateStart','kstDate','makeRange','routeGroup','parseNginx','analyzeActivity','collectStats'];
        const code=helpers.map(name=>`const ${name}=${core[name].toString()};`).join('\n')+`\ncollectStats(${JSON.stringify(config)}).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>{process.stderr.write('Collection failed: '+e.message+'\\n');process.exitCode=1;});`;
        const remote=spawnSync('ssh',['-o','BatchMode=yes',host,'node'],{input:code,encoding:'utf8',maxBuffer:32*1024*1024,timeout:600000});
        if(remote.error||remote.status!==0)throw new Error('통계 수집 실패: '+(remote.error?.message||remote.stderr.trim()));
        report=JSON.parse(remote.stdout);
    }
    if(report.schemaVersion!==2)throw new Error('지원하지 않는 수집 결과 버전');
    report.collector={version:2,sha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).update(fs.readFileSync(require.resolve('./stats_core'))).update(fs.readFileSync(require.resolve('./stats_text'))).update(fs.readFileSync(require.resolve('./stats_activity'))).digest('hex')};
    const dir=path.resolve(options['output-dir']||path.join(process.cwd(),'prod_report'));fs.mkdirSync(dir,{recursive:true});
    const stem=`system_stats_report_${report.range.startDate.replaceAll('-','')}_${report.range.endDate.replaceAll('-','')}`;
    for(const [extension,body] of [['json',JSON.stringify(report,null,2)+'\n'],['txt',core.formatReport(report)]]){
        const destination=path.join(dir,stem+'.'+extension),temporary=destination+'.pending';fs.writeFileSync(temporary,body);fs.renameSync(temporary,destination);console.log('생성: '+destination);
    }
    console.log(`등록 영상 ${report.data.videos?.registered??'N/A'}개, 경고 ${report.warnings.length}개 (출처·제약은 결과물에 명시)`);
    return report;
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
