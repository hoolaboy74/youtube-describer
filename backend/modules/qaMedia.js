'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { runMediaProcess } = require('./mediaResourceLimiter');
const { extractFrames, extractFrameWindow } = require('./frameExtraction');
const { createSubtitleReader, parseVtt } = require('./qaSubtitles');
const FRAME_VERSION = 'frames-v1', SUB_VERSION = 'subtitles-v1';
const abortError = () => Object.assign(new Error('Q&A media canceled'), { name: 'AbortError' });
async function checksum(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of require('node:fs').createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function waitFor(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const abort = () => reject(abortError());
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve,reject).finally(() => signal.removeEventListener('abort',abort));
    });
}
function createDefaultMediaAdapter({ backendRoot, getVideo, run = runMediaProcess }) {
    async function commonArgs(directory) {
        const args = ['--ignore-config','--no-playlist','--no-progress','--retries','0','--fragment-retries','0','--socket-timeout','15'];
        const cookiesDir = path.join(backendRoot,'cookies');
        const cookies = await fs.readdir(cookiesDir).catch(() => []);
        const selected = cookies.find(name => name.endsWith('_cookies.txt'));
        if (selected) {
            const copy = path.join(directory,'cookies.txt');
            await fs.copyFile(path.join(cookiesDir,selected),copy); args.push('--cookies',copy);
        }
        if (process.env.YTDLP_PROXY) args.push('--proxy',process.env.YTDLP_PROXY);
        return args;
    }
    const format = 'bestvideo[height<=480][ext=mp4]';
    return {
        async full(videoId, directory, signal) {
            const file = path.join(directory,'source.mp4');
            await run('yt-dlp',[...await commonArgs(directory),'-f',format,'-o',file,`https://www.youtube.com/watch?v=${videoId}`],
                { needs: { download: 1, fullDownload: 1, ffmpeg: 1 }, signal, timeoutMs:180000, disk:{root:directory,maxBytes:1024**3} });
            return file;
        },
        async section(videoId, startMs, endMs, directory, signal) {
            // Probe the original source, rather than treating the section's first
            // packet as the source origin. Signed metadata never leaves memory.
            const args = await commonArgs(directory);
            const metadata = await run('yt-dlp',[...args,'-f',format,'--dump-single-json',`https://www.youtube.com/watch?v=${videoId}`],
                { needs:{download:1}, priority:20, signal, timeoutMs:30000, maxOutputBytes:4*1024*1024 });
            const source = JSON.parse(metadata.stdout);
            if (source.protocol !== 'https' || !source.url || !/\.googlevideo\.com$/.test(new URL(source.url).hostname)) throw new Error('Section protocol not verified');
            const proxy = process.env.YTDLP_PROXY ? ['-http_proxy', process.env.YTDLP_PROXY] : [];
            const headers = Object.entries(source.http_headers || {}).filter(([k,v]) => !/[\r\n]/.test(k+v)).map(([k,v])=>`${k}: ${v}\r\n`).join('');
            const probe = await run('ffprobe',['-v','error',...proxy,'-headers',headers,'-select_streams','v:0','-show_entries','stream=start_time','-of','json',source.url],
                { needs:{download:1,ffmpeg:1}, priority:20,signal,timeoutMs:15000 });
            const origin = JSON.parse(probe.stdout).streams?.[0]?.start_time;
            if (origin === undefined || !Number.isFinite(Number(origin))) throw new Error('Unproven source origin');
            const file = path.join(directory,'section.mp4');
            await run('ffmpeg',['-hide_banner','-nostdin','-copyts','-ss',String(startMs/1000),'-t',String((endMs-startMs)/1000),...proxy,'-headers',headers,
                '-i',source.url,'-map','0:v:0','-an','-c','copy','-avoid_negative_ts','disabled',file],
                {needs:{download:1,ffmpeg:1},priority:20,signal,timeoutMs:45000,disk:{root:directory,maxBytes:128*1024*1024}});
            return { file, originPtsMs:Math.round(Number(origin)*1000) };
        },
        async subtitles(videoId,directory,signal) {
            const existing = path.join(backendRoot,'public','subtitles',`${videoId}.vtt`);
            const video = getVideo(videoId);
            const audioClassification = ['korean','foreign','mixed'].includes(video?.audio_language) ? video.audio_language : 'unknown';
            if (await fs.stat(existing).catch(()=>null)) return { file:existing, metadata:{ audioClassification, provenance:'legacy' } };
            await run('yt-dlp',[...await commonArgs(directory),'--skip-download','--write-sub','--write-auto-sub','--sub-lang','en,ko','--sub-format','vtt','-o',path.join(directory,'captions'),`https://www.youtube.com/watch?v=${videoId}`],
                {needs:{download:1},priority:20,signal,timeoutMs:45000,disk:{root:directory,maxBytes:32*1024*1024}});
            const files = (await fs.readdir(directory)).filter(f=>f.endsWith('.vtt'));
            const file = files.find(f=>audioClassification==='korean'?f.includes('.ko.'):f.includes('.en.')) || files[0];
            // A downloaded filename alone is insufficient to establish original
            // speech provenance. Pipeline-provided confirmed tracks can upgrade it.
            return file ? {file:path.join(directory,file),metadata:{audioClassification,provenance:'unknown'}} : null;
        },
    };
}
function createQaMedia({ manager, adapter, now = Date.now, extract = extractFrames, windowExtract = extractFrameWindow }) {
    const fullJobs = new Map(), windowJobs = new Map(), subtitleJobs = new Map(), sources = new Map(), pipeline = new Map();
    const reader = createSubtitleReader(manager);
    const sourceEvents = new (require('node:events').EventEmitter)();
    sourceEvents.setMaxListeners(0);
    const workRoot = path.join(manager.root,'jobs');
    const idFolder = id => crypto.createHash('sha256').update(id).digest('hex');
    async function directory(videoId, kind) { const parent=path.join(workRoot,idFolder(videoId));await fs.mkdir(parent,{recursive:true}); return fs.mkdtemp(path.join(parent,kind+'-')); }
    async function leaseFor(videoId, version, signal) {
        const deadline=now()+180000;
        while (now()<deadline) {
            if(signal?.aborted) throw abortError();
            const job=manager.store.job(videoId,version);
            if(job?.state==='ready') return null;
            if(job?.retryAfter>now()) throw Object.assign(new Error('Cache retry delayed'),{code:'CACHE_RETRY_DELAYED'});
            const lease=manager.store.claim(videoId,version,crypto.randomUUID());if(lease)return lease;
            await pause(100);
        }
        throw new Error('Cache lease wait timed out');
    }
    async function owned(videoId,version,fn) {
        const controller=new AbortController();const lease=await leaseFor(videoId,version,controller.signal);if(!lease)return;
        const timer=setInterval(()=>{try{manager.store.renew(lease);}catch{controller.abort();}},15000);timer.unref?.();
        try { return await fn(lease,controller.signal); }
        catch(error) { try { manager.store.transition(lease,'retryable_failed',{retryAfter:now()+60000,lastError:error.code||'cache-work-failed'}); } catch {} throw error; }
        finally {clearInterval(timer);try{manager.store.release(lease);}catch{}}
    }
    async function rememberedSource(videoId) {
        if(sources.has(videoId))return sources.get(videoId);
        const manifest=path.join(workRoot,idFolder(videoId),'source.json');
        try {
            const data=JSON.parse(await fs.readFile(manifest,'utf8'));
            const file=manager.assetPath(data.relativePath);
            const stat=await fs.stat(file);
            if(stat.size!==data.bytes || await checksum(file)!==data.checksum) return null;
            const source={file,owned:true,readers:0,manifest};sources.set(videoId,source);return source;
        } catch{return null;}
    }
    async function getSource(videoId,lease,signal) {
        const saved=await rememberedSource(videoId);if(saved)return saved;
        if(pipeline.has(videoId))return waitFor(pipeline.get(videoId).promise,signal);
        const dir=await directory(videoId,'full');
        const file=await adapter.full(videoId,dir,signal);
        const bytes=(await fs.stat(file)).size;
        const manifest=path.join(workRoot,idFolder(videoId),'source.json');
        const pending=manifest+'.'+lease.fencingToken;
        await fs.writeFile(pending,JSON.stringify({relativePath:path.relative(manager.root,file),bytes,checksum:await checksum(file)}));
        manager.store.fenced(lease,()=>require('node:fs').renameSync(pending,manifest));
        const source={file,owned:true,readers:0,manifest};sources.set(videoId,source);sourceEvents.emit(videoId,source);return source;
    }
    async function cleanupSource(videoId,source) {
        if(source.owned && !source.readers && ![...windowJobs.keys()].some(key=>key.startsWith(videoId+':')) && manager.store.job(videoId,FRAME_VERSION)?.state==='ready') {
            sources.delete(videoId);await fs.rm(path.dirname(source.file),{recursive:true,force:true});await fs.rm(source.manifest,{force:true});
        }
    }
    function current(videoId,timestampMs) {
        return manager.framesBefore(videoId,FRAME_VERSION,timestampMs,4).filter(f=>f.timestampMs>=Math.max(0,timestampMs-4000));
    }
    const service = {
        FRAME_VERSION, SUB_VERSION,
        beginPipeline(videoId) {
            if(pipeline.has(videoId))return pipeline.get(videoId);
            // Reserve immediately before the generator starts its download. Q&A
            // then waits for this source rather than issuing another full download.
            let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});
            let readySource, finishFrames, failFrames;
            const framesDone=new Promise((a,b)=>{finishFrames=a;failFrames=b;});framesDone.catch(()=>{});
            const entry={promise,framesDone,
                publish:frame=>owned(videoId,'pipeline-v1',lease=>manager.publishFrame(lease,frame,FRAME_VERSION)),
                complete:()=>finishFrames(),
                ready(file){readySource={file,owned:false,readers:0};sources.set(videoId,readySource);sourceEvents.emit(videoId,readySource);resolve(readySource);},
                fail(){reject(new Error('Pipeline source failed'));failFrames(new Error('Pipeline frames failed'));pipeline.delete(videoId);},
                async finish(){
                    reject(new Error('Pipeline source closed'));
                    failFrames(new Error('Pipeline frames closed'));
                    // Stop new readers before allowing the generator to remove its MP4.
                    pipeline.delete(videoId);
                    if(sources.get(videoId)===readySource)sources.delete(videoId);
                    await fullJobs.get(videoId)?.catch(()=>{});
                    while(readySource?.readers)await pause(25);
                },
            };
            pipeline.set(videoId,entry);return entry;
        },
        async ensureFullCache(videoId,durationMs) {
            if(fullJobs.has(videoId))return fullJobs.get(videoId);
            const task=owned(videoId,FRAME_VERSION,async(lease,signal)=>{
                const producing=pipeline.get(videoId);
                manager.store.transition(lease,'downloading');const source=await getSource(videoId,lease,signal);source.readers++;
                try {
                    manager.store.transition(lease,'extracting');
                    if(producing){await waitFor(producing.framesDone,signal);manager.markReady(lease,durationMs);return;}
                    const out=await directory(videoId,'frames');
                    try {
                        const result=await extract({inputPath:source.file,outputDir:out,durationMs,signal,onFrame:async frame=>{
                            if(manager.referenceCount(videoId,FRAME_VERSION)===0 && now()-lease.lastAccessAt>300000) throw Object.assign(new Error('Cache warming paused'),{code:'CACHE_IDLE'});
                            await manager.publishFrame(lease,frame,FRAME_VERSION);
                        }});
                        if(!result.ready)throw Object.assign(new Error('Frame coverage incomplete'),{code:'FRAME_COVERAGE_INCOMPLETE'});
                        manager.markReady(lease,durationMs);
                    } finally {await fs.rm(out,{recursive:true,force:true});}
                } finally {source.readers--;await cleanupSource(videoId,source);}
            });
            fullJobs.set(videoId,task);task.catch(()=>{}).finally(()=>fullJobs.delete(videoId));return task;
        },
        async ensureCurrentWindow(videoId,timestampMs,durationMs,{signal}={}) {
            let frames=current(videoId,timestampMs);
            if(frames.length && timestampMs-frames.at(-1).timestampMs<=1000)return frames;
            const bucket=Math.floor(timestampMs/10000);const key=videoId+':'+bucket;
            if(!windowJobs.has(key)) {
                const task=owned(videoId,`window-v1-${bucket}`,async(lease,taskSignal)=>{
                    const dir=await directory(videoId,'window');let source=await rememberedSource(videoId);let section=null;let reading=false;
                    try {
                        if(!source) {
                            try {
                                const cancelSection=new AbortController();
                                let onSource;
                                const available=new Promise(resolve=>{onSource=value=>{value.readers++;reading=true;source=value;resolve({source:value});};sourceEvents.once(videoId,onSource);});
                                const downloading=adapter.section(videoId,Math.max(0,bucket*10000-4000),Math.min(durationMs,(bucket+1)*10000+1000),dir,AbortSignal.any([taskSignal,cancelSection.signal]));
                                try {
                                    const winner=await Promise.race([downloading.then(value=>({section:value})),available]);
                                    if(source){cancelSection.abort();await downloading.catch(()=>{});}
                                    else section=winner.section;
                                } finally {sourceEvents.removeListener(videoId,onSource);}
                            }
                            catch { if(taskSignal.aborted)throw abortError();await service.ensureFullCache(videoId,durationMs);source=await rememberedSource(videoId);if(!source)return; }
                        }
                        if(source&&!reading){source.readers++;reading=true;}
                        const end=Math.min(durationMs-1,(bucket+1)*10000-1);
                        const window=await windowExtract({inputPath:source?.file||section.file,outputDir:path.join(dir,'frames'),startMs:Math.max(0,bucket*10000-4000),endMs:end,
                            sourceOriginPtsMs:section?.originPtsMs,section:!!section,signal:taskSignal});
                        for(const frame of window)await manager.publishFrame(lease,frame,FRAME_VERSION);
                    } finally {if(reading){source.readers--;await cleanupSource(videoId,source);}await fs.rm(dir,{recursive:true,force:true});}
                });
                windowJobs.set(key,task);task.catch(()=>{}).finally(async()=>{windowJobs.delete(key);const source=sources.get(videoId);if(source)await cleanupSource(videoId,source);}).catch(()=>{});
            }
            await waitFor(windowJobs.get(key),signal);frames=current(videoId,timestampMs);
            if(!frames.length){await waitFor(service.ensureFullCache(videoId,durationMs),signal);frames=current(videoId,timestampMs);}
            if(!frames.length)throw new Error('No verified past frame');return frames;
        },
        async ensureSubtitles(videoId,{signal}={}) {
            const existing=manager.store.subtitle(videoId,SUB_VERSION);
            if(existing && (existing.state==='ready'||existing.retryAfter>now()))return reader(videoId,SUB_VERSION);
            if(!subtitleJobs.has(videoId)) {
                const task=owned(videoId,SUB_VERSION,async(lease,taskSignal)=>{
                    const dir=await directory(videoId,'subtitles');
                    try {const result=await adapter.subtitles(videoId,dir,taskSignal);
                        if(result){parseVtt(await fs.readFile(result.file,'utf8'),result.metadata);await manager.publishSubtitle(lease,result.file,result.metadata);}
                        else manager.subtitleUnavailable(lease,'absent');
                    }catch(error){if(taskSignal.aborted||error.code==='STALE_CACHE_LEASE')throw error;manager.subtitleUnavailable(lease,'retryable_failed');}
                    finally{await fs.rm(dir,{recursive:true,force:true});}
                });
                subtitleJobs.set(videoId,task);task.catch(()=>{}).finally(()=>subtitleJobs.delete(videoId));
            }
            await waitFor(subtitleJobs.get(videoId),signal);return reader(videoId,SUB_VERSION);
        },
        async prepare(videoId,timestampMs,durationMs,{signal,warm=true,referenceId}={}) {
            if(!/^[A-Za-z0-9_-]{11}$/.test(videoId)||!Number.isSafeInteger(timestampMs)||timestampMs<0||!Number.isSafeInteger(durationMs)||durationMs<=0||timestampMs>=durationMs)throw new Error('Invalid Q&A media request');
            if(referenceId)manager.touchReference(videoId,FRAME_VERSION,referenceId);
            const subtitles=service.ensureSubtitles(videoId,{signal});
            const frames=service.ensureCurrentWindow(videoId,timestampMs,durationMs,{signal});
            if(warm)service.ensureFullCache(videoId,durationMs).catch(()=>{});
            const values=await Promise.all([frames,subtitles]);return {frames:values[0],subtitles:values[1]};
        },
    };
    return service;
}
module.exports={createQaMedia,createDefaultMediaAdapter,FRAME_VERSION,SUB_VERSION,waitFor};
