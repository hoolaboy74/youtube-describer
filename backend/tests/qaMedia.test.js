const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const Database=require('better-sqlite3');const sharp=require('sharp');
const {createQaCacheManager}=require('../modules/qaCacheManager');const {createQaMedia,FRAME_VERSION}=require('../modules/qaMedia');const {parseVtt}=require('../modules/qaSubtitles');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
async function setup(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'qa-media-'));const db=new Database(path.join(root,'test.db'));t.after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true});});const manager=createQaCacheManager({db,root});const image=path.join(root,'frame.jpg');await sharp({create:{width:640,height:360,channels:3,background:'#123456'}}).jpeg().toFile(image);const frame=timestampMs=>({path:image,sourcePtsMs:timestampMs,originPtsMs:0,timestampMs,sourceKind:'keyframe'});return{root,manager,frame};}
test('current window and VTT begin together and answer before blocked full warming; same-bucket requests share work',async t=>{const{manager,frame}=await setup(t);const full=deferred();const started=[];let sections=0;const service=createQaMedia({manager,adapter:{full:async()=>{started.push('full');return full.promise;},section:async()=>{sections++;started.push('window');return{file:'fake',originPtsMs:0};},subtitles:async()=>{started.push('vtt');return null;}},windowExtract:async()=>[frame(12000),frame(14000)],extract:async()=>({ready:true})});
const a=service.prepare('abcdefghijk',12500,20000);const b=service.prepare('abcdefghijk',12900,20000);const result=await Promise.all([a,b]);assert.equal(sections,1);assert.ok(started.includes('vtt'));assert.ok(started.includes('full'));assert.equal(result[0].frames[0].timestampMs,12000);assert.ok(result.every(r=>r.frames.every(f=>f.timestampMs<=12900)));full.reject(new Error('injected full failure'));await service.ensureFullCache('abcdefghijk',20000).catch(()=>{});});
test('canceling one waiter does not cancel a shared current window',async t=>{const{manager,frame}=await setup(t);const gate=deferred();const service=createQaMedia({manager,adapter:{section:async()=>{await gate.promise;return{file:'fake',originPtsMs:0};}},windowExtract:async()=>[frame(12000)]});const controller=new AbortController();const a=service.ensureCurrentWindow('abcdefghijk',12500,20000,{signal:controller.signal});const b=service.ensureCurrentWindow('abcdefghijk',12500,20000);controller.abort();await assert.rejects(a,{name:'AbortError'});gate.resolve();assert.equal((await b).length,1);});
test('warm frames never download again, and a VTT crossing T is excluded from past context',async t=>{const{manager,frame}=await setup(t);const lease=manager.store.claim('abcdefghijk',FRAME_VERSION,'test');await manager.publishFrame(lease,frame(12000));manager.store.release(lease);const service=createQaMedia({manager,adapter:{section:()=>{throw new Error('unexpected download');}}});assert.equal((await service.ensureCurrentWindow('abcdefghijk',12500,20000)).length,1);const cues=parseVtt('WEBVTT\n\n00:10.000 --> 00:13.000\n대사\n\n');assert.equal(cues.filter(c=>c.end<=12).length,0);assert.equal(cues[0].confirmed,false);});
test('pipeline publishes before model completion and shares its source without another download/extraction',async t=>{
const{manager,frame,root}=await setup(t);const service=createQaMedia({manager,adapter:{full:()=>{throw new Error('duplicate full');}},extract:()=>{throw new Error('duplicate extraction');}});
const pipeline=service.beginPipeline('abcdefghijk');const source=path.join(root,'source.mp4');await fs.writeFile(source,'fixture');const warming=service.ensureFullCache('abcdefghijk',4000);pipeline.ready(source);await pipeline.publish(frame(0));await pipeline.publish(frame(2000));pipeline.complete();await warming;await pipeline.finish();assert.equal(manager.store.job('abcdefghijk',FRAME_VERSION).state,'ready');assert.ok(await fs.stat(source));
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
