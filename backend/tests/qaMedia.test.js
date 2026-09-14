const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const Database=require('better-sqlite3');const sharp=require('sharp');
const {createQaCacheManager}=require('../modules/qaCacheManager');const {createQaMedia,createDefaultMediaAdapter,classifyYtdlpFailure,FRAME_VERSION}=require('../modules/qaMedia');const {parseVtt}=require('../modules/qaSubtitles');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
async function setup(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'qa-media-'));const db=new Database(path.join(root,'test.db'));t.after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true});});const manager=createQaCacheManager({db,root});const image=path.join(root,'frame.jpg');await sharp({create:{width:640,height:360,channels:3,background:'#123456'}}).jpeg().toFile(image);const frame=timestampMs=>({path:image,sourcePtsMs:timestampMs,originPtsMs:0,timestampMs,sourceKind:'keyframe'});return{root,manager,frame};}
test('current window and VTT begin together and answer before blocked full warming; same-bucket requests share work',async t=>{const{manager,frame}=await setup(t);const full=deferred();const started=[];let sections=0;const service=createQaMedia({manager,adapter:{full:async()=>{started.push('full');return full.promise;},section:async()=>{sections++;started.push('window');return{file:'fake',originPtsMs:0};},subtitles:async()=>{started.push('vtt');return null;}},windowExtract:async()=>[frame(12000),frame(14000)],extract:async()=>({ready:true})});
const a=service.prepare('abcdefghijk',12500,20000);const b=service.prepare('abcdefghijk',12900,20000);const result=await Promise.all([a,b]);assert.equal(sections,1);assert.ok(started.includes('vtt'));assert.ok(started.includes('full'));assert.equal(result[0].frames[0].timestampMs,12000);assert.ok(result.every(r=>r.frames.every(f=>f.timestampMs<=16900)));full.reject(new Error('injected full failure'));await service.ensureFullCache('abcdefghijk',20000).catch(()=>{});});
test('canceling one waiter does not cancel a shared current window',async t=>{const{manager,frame}=await setup(t);const gate=deferred();const service=createQaMedia({manager,adapter:{section:async()=>{await gate.promise;return{file:'fake',originPtsMs:0};}},windowExtract:async()=>[frame(12000)]});const controller=new AbortController();const a=service.ensureCurrentWindow('abcdefghijk',12500,20000,{signal:controller.signal});const b=service.ensureCurrentWindow('abcdefghijk',12500,20000);controller.abort();await assert.rejects(a,{name:'AbortError'});gate.resolve();assert.equal((await b).length,1);});
test('warm frames never download again, and a VTT crossing T is excluded from past context',async t=>{const{manager,frame}=await setup(t);const lease=manager.store.claim('abcdefghijk',FRAME_VERSION,'test');await manager.publishFrame(lease,frame(12000));manager.store.release(lease);const service=createQaMedia({manager,adapter:{section:()=>{throw new Error('unexpected download');}}});assert.equal((await service.ensureCurrentWindow('abcdefghijk',12500,20000)).length,1);const cues=parseVtt('WEBVTT\n\n00:10.000 --> 00:13.000\n대사\n\n');assert.equal(cues.filter(c=>c.end<=12).length,0);assert.equal(cues[0].confirmed,false);});
test('pipeline publishes before model completion and shares its source without another download/extraction',async t=>{
const{manager,frame,root}=await setup(t);const service=createQaMedia({manager,adapter:{full:()=>{throw new Error('duplicate full');}},extract:()=>{throw new Error('duplicate extraction');}});
const pipeline=service.beginPipeline('abcdefghijk');const source=path.join(root,'source.mp4');await fs.writeFile(source,'fixture');const warming=service.ensureFullCache('abcdefghijk',4000);pipeline.ready(source);await pipeline.publish(frame(0));await pipeline.publish(frame(2000));pipeline.complete();await warming;await pipeline.finish();assert.equal(manager.store.job('abcdefghijk',FRAME_VERSION).state,'ready');assert.ok(await fs.stat(source));
});

test('generator pipeline publishes all frames through one durable cache lease',async t=>{
const{manager,frame}=await setup(t),logs=[];const service=createQaMedia({manager,log:line=>logs.push(line)});const entry=service.beginPipeline('abcdefghijk');await entry.publish(frame(1000));await entry.publish(frame(2000));await entry.complete(3000);await entry.finish();
assert.equal(logs.filter(line=>line.includes('"version":"pipeline-v1"')&&line.includes('"event":"work_started"')).length,1);assert.equal(logs.filter(line=>line.includes('"version":"pipeline-v1"')&&line.includes('"event":"work_completed"')).length,1);
});
test('complete source wins over a slow section and the section is canceled before its files are removed',async t=>{
const{manager,frame,root}=await setup(t);const started=deferred();let aborted=false;const service=createQaMedia({manager,adapter:{section:async(id,start,end,dir,signal)=>{started.resolve();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true}));}},windowExtract:async options=>{assert.equal(options.section,false);return[frame(12000)];}});
const pipeline=service.beginPipeline('abcdefghijk');const result=service.ensureCurrentWindow('abcdefghijk',12500,20000);await started.promise;pipeline.ready(path.join(root,'source.mp4'));assert.equal((await result).length,1);assert.equal(aborted,true);await pipeline.finish();
});
test('runtime corrupt subtitle is refetched and current-question frames remain available',async t=>{
const{manager,frame,root}=await setup(t);const file=path.join(root,'captions.vtt');await fs.writeFile(file,'WEBVTT\n\n00:01.000 --> 00:02.000\n원문\n');const lease=manager.store.claim('abcdefghijk','subtitles-v1','test');const asset=await manager.publishSubtitle(lease,file);manager.store.release(lease);await fs.writeFile(manager.assetPath(asset.relativePath),'corrupt');let calls=0;
const service=createQaMedia({manager,adapter:{subtitles:async()=>{calls++;return{file,metadata:{provenance:'unknown'}};}}});const result=await service.ensureSubtitles('abcdefghijk');assert.equal(calls,1);assert.equal(result.cues[0].sourceText,'원문');
});
test('Q&A-first and generator-first orderings share one complete source and preserve generator files through cache cleanup',async t=>{
for(const order of ['qa-first','generator-first']) {
const{manager,frame,root}=await setup(t);const started=deferred(),downloadGate=deferred(),extractGate=deferred();let qaDownloads=0,generatorDownloads=0;
const service=createQaMedia({manager,adapter:{full:async(id,dir)=>{qaDownloads++;started.resolve();await downloadGate.promise;const file=path.join(dir,'source.mp4');await fs.writeFile(file,'shared-source');return file;}},extract:async({onFrame})=>{await extractGate.promise;await onFrame(frame(0));await onFrame(frame(2000));return{ready:true};}});
const target=path.join(root,'generator','video.mp4');let pipeline,warming,preparing;
const generate=async()=>{generatorDownloads++;started.resolve();await downloadGate.promise;await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'shared-source');};
if(order==='qa-first'){warming=service.ensureFullCache('abcdefghijk',4000);await started.promise;pipeline=service.beginPipeline('abcdefghijk');preparing=pipeline.withSource(target,generate);}
else{pipeline=service.beginPipeline('abcdefghijk');preparing=pipeline.withSource(target,generate);await started.promise;warming=service.ensureFullCache('abcdefghijk',4000);}
downloadGate.resolve();await preparing;assert.equal(await fs.readFile(target,'utf8'),'shared-source');assert.equal(qaDownloads+generatorDownloads,1);await pipeline.publish(frame(0));await pipeline.publish(frame(2000));pipeline.complete(4000);extractGate.resolve();await warming;await pipeline.finish();assert.equal(await fs.readFile(target,'utf8'),'shared-source');assert.equal(manager.store.job('abcdefghijk',FRAME_VERSION).state,'ready');
}
});
test('a restarted coordinator reuses the durable complete source after frame extraction failed',async t=>{
const{manager,frame}=await setup(t);let downloads=0;
const first=createQaMedia({manager,adapter:{full:async(id,dir)=>{downloads++;const file=path.join(dir,'source.mp4');await fs.writeFile(file,'complete-source');return file;}},extract:async()=>{throw new Error('injected extraction failure');}});
await assert.rejects(first.ensureFullCache('abcdefghijk',20000));
const restarted=createQaMedia({manager,adapter:{section:()=>{throw new Error('unexpected section');},full:()=>{throw new Error('unexpected download');}},windowExtract:async({inputPath})=>{assert.equal(await fs.readFile(inputPath,'utf8'),'complete-source');return[frame(12000)];}});
assert.equal((await restarted.ensureCurrentWindow('abcdefghijk',12500,20000)).length,1);assert.equal(downloads,1);
});
test('completed two-second-grid caches do not re-extract ordinary questions between grid points',async t=>{
const{manager,frame}=await setup(t);const lease=manager.store.claim('abcdefghijk',FRAME_VERSION,'test');manager.store.transition(lease,'extracting');await manager.publishFrame(lease,frame(0));await manager.publishFrame(lease,frame(2000));manager.markReady(lease,4000);
const service=createQaMedia({manager,adapter:{section:()=>{throw new Error('warm cache unexpectedly downloaded');}}});const frames=await service.ensureCurrentWindow('abcdefghijk',3500,4000);assert.equal(frames.at(-1).timestampMs,2000);
});

test('cold-cache diagnostics expose work and subtitle failure without leaking process secrets',async t=>{
const {manager,frame}=await setup(t);const logs=[];
const service=createQaMedia({manager,log:line=>logs.push(line),adapter:{section:async()=>({file:'fixture',originPtsMs:0}),subtitles:async()=>{throw new Error('secret signed URL and cookies');}},windowExtract:async()=>[frame(12000)]});
const result=await service.prepare('abcdefghijk',12500,20000,{warm:false});assert.equal(result.subtitles.state,'retryable_failed');
for(const event of ['window_miss','subtitle_miss','subtitle_failed','prepared']) assert.ok(logs.some(line=>line.includes(`"event":"${event}"`)));
assert.ok(logs.some(line=>line.includes(manager.root)));assert.ok(!logs.join('').includes('secret signed'));
await service.ensureCurrentWindow('abcdefghijk',12500,20000);assert.ok(logs.some(line=>line.includes('window_hit')));
});
test('cold windows span both sides even at bucket edges, and warmed windows preserve both sides without downloads',async t=>{
const {manager,frame}=await setup(t);let downloads=0;
const service=createQaMedia({manager,adapter:{section:async(id,start,end)=>{downloads++;assert.equal(start,6000);assert.equal(end,25000);return{file:'fixture',originPtsMs:0};},subtitles:async()=>null},windowExtract:async options=>{assert.equal(options.startMs,6000);assert.equal(options.endMs,23999);return Array.from({length:18},(_,i)=>frame(6000+i*1000));}});
const cold=await service.prepare('abcdefghijk',19900,30000,{warm:false});assert.ok(cold.frames.some(f=>f.timestampMs<19900));assert.ok(cold.frames.some(f=>f.timestampMs>19900));assert.ok(cold.frames.every(f=>f.timestampMs>=15900&&f.timestampMs<=23900));assert.ok(cold.frames.length<=8);
const warm=await service.prepare('abcdefghijk',19900,30000,{warm:false});assert.equal(downloads,1);assert.deepEqual(warm.frames,cold.frames);assert.equal(cold.fromCache,false);assert.equal(warm.fromCache,true);
});


test('dense cached windows retain the nearest past frame and hit on repeated questions',async t=>{
    const {manager,frame}=await setup(t);
    const lease=manager.store.claim('densevideo1',FRAME_VERSION,'test');
    for(let ms=0;ms<14000;ms+=33) await manager.publishFrame(lease,frame(ms));
    manager.store.release(lease);
    const logs=[];
    const service=createQaMedia({manager,log:line=>logs.push(line),adapter:{section:()=>{throw new Error('unexpected extraction');}}});
    for(let attempt=0;attempt<2;attempt++) {
        const frames=await service.ensureCurrentWindow('densevideo1',9247,20000,{around:true});
        assert.equal(frames.length,8);
        assert.ok(frames.some(f=>f.timestampMs===9240));
        assert.ok(frames[0].timestampMs<=5300);
        assert.ok(frames.at(-1).timestampMs>=13200);
        assert.ok(frames.every(f=>f.timestampMs>=5247&&f.timestampMs<=13247));
    }
    assert.equal(logs.filter(line=>line.includes('window_hit')).length,2);
});


test('restart can read a source manifest from the historical hashed job directory',async t=>{
    const {manager,frame,root}=await setup(t);
    const id='94L2Z6Xyoxc';
    const first=createQaMedia({manager,adapter:{full:async(id,dir)=>{
        assert.ok(dir.includes('/jobs/'+id+'/'));
        const file=path.join(dir,'source.mp4');await fs.writeFile(file,'source');return file;
    }},extract:async()=>{throw new Error('injected failure');}});
    await assert.rejects(first.ensureFullCache(id,20000));
    const old=require('crypto').createHash('sha256').update(id).digest('hex');
    const newDir=path.join(root,'jobs',id),oldDir=path.join(root,'jobs',old);
    await fs.rename(newDir,oldDir);
    const manifest=path.join(oldDir,'source.json');const data=JSON.parse(await fs.readFile(manifest,'utf8'));
    data.relativePath=data.relativePath.replace('jobs/'+id+'/','jobs/'+old+'/');
    await fs.writeFile(manifest,JSON.stringify(data));
    const restarted=createQaMedia({manager,adapter:{section:()=>{throw new Error('unexpected download');}},windowExtract:async({inputPath})=>{
        assert.equal(await fs.readFile(inputPath,'utf8'),'source');return[frame(12000)];
    }});
    assert.equal((await restarted.ensureCurrentWindow(id,12500,20000)).length,1);
});


test('generator captions are published once to the shared cache and Q&A reads without downloading',async t=>{
    const {manager,root}=await setup(t);const id='94L2Z6Xyoxc';
    const file=path.join(root,'downloaded.en.vtt');await fs.writeFile(file,'WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n');
    const service=createQaMedia({manager,adapter:{subtitles:()=>{throw new Error('unexpected download');}}});
    await service.publishSubtitles(id,file,{audioClassification:'foreign',provenance:'unknown'});
    const result=await service.ensureSubtitles(id);
    assert.equal(result.state,'ready');assert.equal(result.cues[0].sourceText,'Hello');assert.equal(result.cues[0].confirmed,false);
    assert.ok(manager.store.subtitle(id,'subtitles-v1').relativePath.startsWith('assets/'+id+'/subtitles/'));
    await service.publishSubtitles(id,null);
    assert.equal((await service.ensureSubtitles(id)).cues[0].sourceText,'Hello');
});

test('missing generator captions do not create a permanent no-subtitle marker',async t=>{
    const {manager,root}=await setup(t);const file=path.join(root,'captions.vtt');await fs.writeFile(file,'WEBVTT\n\n');let downloads=0;
    const service=createQaMedia({manager,adapter:{subtitles:async()=>{downloads++;return{file,metadata:{}};}}});
    await service.publishSubtitles('94L2Z6Xyoxc',null);
    assert.equal((await service.ensureSubtitles('94L2Z6Xyoxc')).state,'ready');assert.equal(downloads,1);
});

test('failed section falls back to the shared source without waiting for full-frame extraction',async t=>{
    const {manager,frame}=await setup(t);
    const downloadGate=deferred(), sectionFailed=deferred(), fullGate=deferred();
    let downloads=0, fullCompleted=false;
    const logs=[];
    const service=createQaMedia({manager,log:line=>logs.push(line),adapter:{
        section:async()=>{sectionFailed.resolve();throw Object.assign(new Error('section unavailable'),{code:'MEDIA_EXIT'});},
        full:async(id,dir)=>{downloads++;await downloadGate.promise;const file=path.join(dir,'source.mp4');await fs.writeFile(file,'shared source');return file;},
        subtitles:async()=>null,
    },extract:async({onFrame})=>{
        await fullGate.promise;
        for(let ms=0;ms<20000;ms+=2000)await onFrame(frame(ms));
        fullCompleted=true;return{ready:true};
    },windowExtract:async({inputPath})=>{
        assert.equal(await fs.readFile(inputPath,'utf8'),'shared source');
        return Array.from({length:9},(_,i)=>frame(5000+i*1000));
    }});
    const preparing=service.prepare('YmEnygA7pHc',8664,20000,{warm:true});
    let timer;
    try {
        await sectionFailed.promise;downloadGate.resolve();
        const result=await Promise.race([preparing,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('current window waited for full cache')),2000);})]);
        assert.equal(fullCompleted,false);
        assert.ok(result.frames.some(f=>f.timestampMs<=8664));
        assert.equal(downloads,1);
        assert.ok(logs.some(line=>line.includes('window_source_fallback')));
    } finally {
        clearTimeout(timer);downloadGate.resolve();fullGate.resolve();
        await preparing.catch(()=>{});await service.ensureFullCache('YmEnygA7pHc',20000);
    }
});

test('default downloader retries a failed cookie request without exposing its content',async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'qa-ytdlp-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    await fs.mkdir(path.join(root,'cookies'));await fs.writeFile(path.join(root,'cookies','active_cookies.txt'),'secret-cookie');
    const calls=[];
    const adapter=createDefaultMediaAdapter({backendRoot:root,getVideo:()=>null,run:async(file,args)=>{
        calls.push(args);
        if(calls.length===1)throw Object.assign(new Error('yt-dlp failed'),{code:'MEDIA_EXIT',exitCode:1,stderr:'secret-cookie'});
        await fs.writeFile(args[args.indexOf('-o')+1],'video');return{};
    }});
    const directory=path.join(root,'work');await fs.mkdir(directory);
    const output=await adapter.full('YmEnygA7pHc',directory);
    assert.equal(await fs.readFile(output,'utf8'),'video');assert.equal(calls.length,2);
    assert.ok(calls[0].includes('--cookies'));assert.ok(!calls[1].includes('--cookies'));
    assert.ok(calls[0].includes('--force-ipv4'));assert.ok(calls[0].includes('--js-runtimes'));
    assert.equal(calls[0][calls[0].indexOf('-f')+1],'bestvideo[height<=360][ext=mp4]/best[height<=360][ext=mp4]');
    assert.ok(!calls[0].includes('--merge-output-format'));
    assert.ok(!calls.flat().join(' ').includes('secret-cookie'));
});

test('default downloader retries an authentication failure with a different valid cookie',async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'qa-ytdlp-alternative-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    await fs.mkdir(path.join(root,'cookies'));await fs.writeFile(path.join(root,'cookies','first_cookies.txt'),'first-secret');await fs.writeFile(path.join(root,'cookies','second_cookies.txt'),'second-secret');
    const copiedCookies=[];
    const adapter=createDefaultMediaAdapter({backendRoot:root,getVideo:()=>null,pickCookie:paths=>paths[0],run:async(file,args)=>{
        const cookie=args[args.indexOf('--cookies')+1];copiedCookies.push(await fs.readFile(cookie,'utf8'));
        if(copiedCookies.length===1)throw Object.assign(new Error('yt-dlp failed'),{code:'MEDIA_EXIT',exitCode:1,stderr:'ERROR: Sign in to confirm you are not a bot'});
        await fs.writeFile(args[args.indexOf('-o')+1],'video');return{};
    }});
    const directory=path.join(root,'work');await fs.mkdir(directory);
    await adapter.full('YmEnygA7pHc',directory);
    assert.deepEqual(copiedCookies,['first-secret','second-secret']);
});

test('media diagnostics retain an exit code but never process stderr',async t=>{
    const {manager}=await setup(t), logs=[];
    const failure=()=>{throw Object.assign(new Error('failed'),{code:'MEDIA_EXIT',exitCode:23,stderr:'signed-url-token'});};
    const service=createQaMedia({manager,log:line=>logs.push(line),adapter:{section:async()=>failure(),full:async()=>failure()}});
    await assert.rejects(service.ensureCurrentWindow('abcdefghijk',12500,20000),{code:'MEDIA_EXIT'});
    const line=logs.find(value=>value.includes('"event":"work_failed"'));
    assert.ok(line.includes('"exitCode":23'));assert.ok(!line.includes('signed-url-token'));
});

test('yt-dlp diagnostics classify safe failure categories without retaining raw stderr',()=>{
    assert.equal(classifyYtdlpFailure({stderr:'ERROR: Sign in to confirm you are not a bot'}),'YTDLP_AUTH_REQUIRED');
    assert.equal(classifyYtdlpFailure({stderr:'ERROR: Requested format is not available'}),'YTDLP_FORMAT_UNAVAILABLE');
    assert.equal(classifyYtdlpFailure({stderr:'ERROR: HTTP Error 403: Forbidden'}),'YTDLP_ACCESS_DENIED');
    assert.equal(classifyYtdlpFailure({stderr:'secret signed URL=abc'}),'YTDLP_UNKNOWN');
});

test('second yt-dlp failure reports only a classified reason',async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'qa-ytdlp-failure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const adapter=createDefaultMediaAdapter({backendRoot:root,getVideo:()=>null,run:async()=>{throw Object.assign(new Error('failed'),{code:'MEDIA_EXIT',exitCode:1,stderr:'ERROR: Sign in to confirm you are not a bot'});}});
    await assert.rejects(adapter.full('YmEnygA7pHc',root),error=>error.mediaFailure==='YTDLP_AUTH_REQUIRED'&&!String(error.mediaFailure).includes('confirm'));
});
