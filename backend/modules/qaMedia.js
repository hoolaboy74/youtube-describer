'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const logger = require('../logger');
const { runMediaProcess } = require('./mediaResourceLimiter');
const { mediaDiskBudget } = require('./mediaDiskBudget');
const { extractFrames, extractFrameWindow } = require('./frameExtraction');
const { FRAME_RADIUS_MS } = require('./qaContext');
const { createSubtitleReader, parseVtt } = require('./qaSubtitles');
const { getIsImpersonateAvailable } = require('../utils');
const FRAME_VERSION = 'frames-v1', SUB_VERSION = 'subtitles-v1';
const abortError = () => Object.assign(new Error('Q&A media canceled'), { name: 'AbortError' });
function classifyYtdlpFailure(error) {
    const message = String(error?.stderr || error?.message || '').toLowerCase();
    if (/sign in to confirm|not a bot|bot check|use --cookies/.test(message)) return 'YTDLP_AUTH_REQUIRED';
    if (/http error 403|forbidden|access denied/.test(message)) return 'YTDLP_ACCESS_DENIED';
    if (/requested format is not available|no video formats found/.test(message)) return 'YTDLP_FORMAT_UNAVAILABLE';
    if (/impersonat|curl_cffi/.test(message)) return 'YTDLP_IMPERSONATION';
    if (/javascript runtime|js runtime|deno|node/.test(message)) return 'YTDLP_JS_RUNTIME';
    if (/plugin|pot provider|po token/.test(message)) return 'YTDLP_PLUGIN';
    if (/timed out|network is unreachable|temporary failure|connection refused|name or service not known/.test(message)) return 'YTDLP_NETWORK';
    return 'YTDLP_UNKNOWN';
}
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
function createDefaultMediaAdapter({ backendRoot, getVideo, run = runMediaProcess, pickCookie = paths => paths[Math.floor(Math.random() * paths.length)] }) {
    async function availableCookies() {
        const cookiesDir = path.join(backendRoot,'cookies');
        const names = await fs.readdir(cookiesDir).catch(() => []);
        const accountCookies = (await Promise.all(names.filter(name => name.endsWith('_cookies.txt')).map(async name => {
            const file = path.join(cookiesDir,name);
            try { return (await fs.stat(file)).size > 0 ? file : null; } catch { return null; }
        }))).filter(Boolean);
        if (accountCookies.length) return accountCookies;
        const fallback = path.join(backendRoot,'cookies.txt');
        try { return (await fs.stat(fallback)).size > 0 ? [fallback] : []; } catch { return []; }
    }
    async function commonArgs(directory, cookiePath) {
        const args = ['--ignore-config','--no-playlist','--no-progress','--retries','0','--fragment-retries','0','--socket-timeout','15',
            '--force-ipv4','--legacy-server-connect','--no-check-certificate','--plugin-dirs',path.join(backendRoot,'yt_dlp_plugins'),
            '--remote-components','ejs:github','--js-runtimes','node'];
        if (cookiePath) {
            const copy = path.join(directory,'cookies.txt');
            await fs.copyFile(cookiePath,copy); args.push('--cookies',copy);
        }
        if (process.env.YTDLP_PROXY) args.push('--proxy',process.env.YTDLP_PROXY);
        if (getIsImpersonateAvailable()) args.push('--impersonate','safari');
        return args;
    }
    async function ytdlp(directory, args, options) {
        const cookies = await availableCookies();
        const selected = cookies.length ? pickCookie(cookies) : null;
        try {
            return await run('yt-dlp',[...await commonArgs(directory,selected),...args],options);
        } catch (error) {
            // Retry a bot-blocked account with another account first. Public
            // videos still get one no-cookie attempt when no alternative exists.
            if (error?.code !== 'MEDIA_EXIT') throw error;
            const alternatives = cookies.filter(cookie => cookie !== selected);
            const replacement = alternatives.length ? pickCookie(alternatives) : null;
            try {
                return await run('yt-dlp',[...await commonArgs(directory,replacement),...args],options);
            } catch (retryError) {
                if (retryError?.code === 'MEDIA_EXIT') retryError.mediaFailure = classifyYtdlpFailure(retryError);
                throw retryError;
            }
        }
    }
    // Q&A only needs visual evidence. Match the generator's 360p ceiling and
    // avoid downloading/merging an audio track that this path never reads.
    const format = 'bestvideo[height<=360][ext=mp4]/best[height<=360][ext=mp4]';
    return {
        async full(videoId, directory, signal) {
            const file = path.join(directory,'source.mp4');
            await ytdlp(directory,['-f',format,'-o',file,`https://www.youtube.com/watch?v=${videoId}`],
                { needs: { download: 1, fullDownload: 1 }, signal, timeoutMs:180000, disk:{root:directory,maxBytes:1024**3} });
            return file;
        },
        async section(videoId, startMs, endMs, directory, signal) {
            // Probe the original source, rather than treating the section's first
            // packet as the source origin. Signed metadata never leaves memory.
            const metadata = await ytdlp(directory,['-f',format,'--dump-single-json',`https://www.youtube.com/watch?v=${videoId}`],
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
        async subtitles(videoId,directory,signal,{forceDownload=false}={}) {
            const video = getVideo(videoId);
            const audioClassification = ['korean','foreign','mixed'].includes(video?.audio_language) ? video.audio_language : 'unknown';
            await ytdlp(directory,['--skip-download','--write-sub','--write-auto-sub','--sub-lang','en,ko','--sub-format','vtt','-o',path.join(directory,'captions'),`https://www.youtube.com/watch?v=${videoId}`],
                {needs:{download:1},priority:20,signal,timeoutMs:45000,disk:{root:directory,maxBytes:32*1024*1024}});
            const files = (await fs.readdir(directory)).filter(f=>f.endsWith('.vtt'));
            const file = files.find(f=>audioClassification==='korean'?f.includes('.ko.'):f.includes('.en.')) || files[0];
            // A downloaded filename alone is insufficient to establish original
            // speech provenance. Pipeline-provided confirmed tracks can upgrade it.
            return file ? {file:path.join(directory,file),metadata:{audioClassification,provenance:'unknown'}} : null;
        },
    };
}
function createQaMedia({ manager, adapter, log = message => logger.info(message), now = Date.now, extract = extractFrames, windowExtract = extractFrameWindow }) {
    // Log only identifiers/states, never questions, signed URLs or raw process stderr.
    const report = (videoId, event, details = {}) => log(`[QA-MEDIA] ${JSON.stringify({ videoId, event, ...details })}`);
    const rawJobs = new Map(), fullJobs = new Map(), windowJobs = new Map(), subtitleJobs = new Map(), sources = new Map(), pipeline = new Map();
    const reader = createSubtitleReader(manager);
    const sourceEvents = new (require('node:events').EventEmitter)();
    sourceEvents.setMaxListeners(0);
    const priorities = new Map();
    const workRoot = path.join(manager.root,'jobs');
    const legacyIdFolder = id => crypto.createHash('sha256').update(id).digest('hex');
    const idFolder = id => {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid cache video ID');
        return id;
    };
    const idFolders = id => [idFolder(id), legacyIdFolder(id)];
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
        report(videoId,'work_started',{version});
        try { const result = await fn(lease,controller.signal);report(videoId,'work_completed',{version});return result; }
        catch(error) { report(videoId,'work_failed',{version,code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'CACHE_WORK_FAILED', ...(Number.isInteger(error.exitCode) ? {exitCode:error.exitCode} : {}), ...(typeof error.mediaFailure === 'string' ? {mediaFailure:error.mediaFailure} : {})});try { manager.store.transition(lease,'retryable_failed',{retryAfter:now()+60000,lastError:error.code||'cache-work-failed'}); } catch {} throw error; }
        finally {clearInterval(timer);try{manager.store.release(lease);}catch{}}
    }
    async function rememberedSource(videoId) {
        if(sources.has(videoId))return sources.get(videoId);
        for (const name of idFolders(videoId)) {
            const manifest=path.join(workRoot,name,'source.json');
            try {
                const data=JSON.parse(await fs.readFile(manifest,'utf8'));
                if(data.sourceVersion!=='av-v1')continue;
                const file=manager.assetPath(data.relativePath);
                const stat=await fs.stat(file);
                if(stat.size!==data.bytes || await checksum(file)!==data.checksum) continue;
                const source={file,owned:true,readers:0,manifest};sources.set(videoId,source);return source;
            } catch {}
        }
        return null;
    }
    async function materialize(source, target) {
        if(path.resolve(source)===path.resolve(target))return;
        await fs.mkdir(path.dirname(target),{recursive:true});
        const pending=target+'.shared-'+crypto.randomUUID();let reservation;
        try {
            try { await fs.link(source,pending); }
            catch(error) {
                if(error.code!=='EXDEV')throw error;
                const bytes=(await fs.stat(source)).size;reservation=mediaDiskBudget.reserve(path.dirname(target),bytes);
                await fs.copyFile(source,pending);reservation.check((await fs.stat(pending)).size);
            }
            await fs.rename(pending,target);
        } finally { reservation?.release();await fs.rm(pending,{force:true}); }
    }
    async function ensureRawSource(videoId, produce) {
        if(rawJobs.has(videoId))return rawJobs.get(videoId);
        const task=owned(videoId,'raw-source-v1',async(lease,signal)=>{
            const saved=await rememberedSource(videoId);if(saved)return saved;
            manager.store.transition(lease,'downloading');
            const dir=await directory(videoId,'source');
            const downloaded=produce ? await produce(signal) : await adapter.full(videoId,dir,signal);
            const file=path.join(dir,'source.mp4');await materialize(downloaded,file);
            const bytes=(await fs.stat(file)).size;
            if(!bytes||bytes>1024**3)throw Object.assign(new Error('Invalid source size'),{code:'SOURCE_SIZE_LIMIT'});
            const manifest=path.join(workRoot,idFolder(videoId),'source.json');
            const pending=manifest+'.'+lease.fencingToken;
            await fs.writeFile(pending,JSON.stringify({sourceVersion:'av-v1',relativePath:path.relative(manager.root,file),bytes,checksum:await checksum(file)}));
            manager.store.fenced(lease,()=>require('node:fs').renameSync(pending,manifest));
            const source={file,owned:true,readers:0,manifest};sources.set(videoId,source);sourceEvents.emit(videoId,source);return source;
        });
        rawJobs.set(videoId,task);task.catch(()=>{}).finally(()=>rawJobs.delete(videoId));return task;
    }
    async function getSource(videoId,lease,signal) {
        const saved=await rememberedSource(videoId);if(saved)return saved;
        if(pipeline.has(videoId))return waitFor(pipeline.get(videoId).promise,signal);
        return waitFor(ensureRawSource(videoId),signal);
    }
    async function cleanupSource(videoId,source) {
        if(source.owned && !source.readers && !pipeline.has(videoId) && ![...windowJobs.keys()].some(key=>key.startsWith(videoId+':')) && manager.store.job(videoId,FRAME_VERSION)?.state==='ready') {
            sources.delete(videoId);await fs.rm(path.dirname(source.file),{recursive:true,force:true});await fs.rm(source.manifest,{force:true});
        }
    }
    function current(videoId,timestampMs,durationMs,around=false) {
        const end=around?Math.min(durationMs-1,timestampMs+FRAME_RADIUS_MS):timestampMs;
        if (around) return manager.framesInRange(videoId, FRAME_VERSION, Math.max(0,timestampMs-FRAME_RADIUS_MS), end, timestampMs);
        return manager.framesBefore(videoId,FRAME_VERSION,end,4).filter(f=>f.timestampMs>=Math.max(0,timestampMs-FRAME_RADIUS_MS));
    }
    function windowReady(videoId, frames, timestampMs, durationMs, around) {
        const freshness=manager.store.job(videoId,FRAME_VERSION)?.state==='ready'?2000:1000;
        return frames.length > 0 && (around
            ? frames.some(f=>f.timestampMs<=timestampMs)
                && frames[0].timestampMs<=Math.max(0,timestampMs-FRAME_RADIUS_MS)+freshness
                && frames.at(-1).timestampMs>=Math.min(durationMs-1,timestampMs+FRAME_RADIUS_MS)-freshness
            : timestampMs-frames.at(-1).timestampMs<=freshness);
    }
    const service = {
        FRAME_VERSION, SUB_VERSION,
        async cleanupJobs({ ttlMs = 3600000 } = {}) {
            const activeIds = manager.store.db.prepare('SELECT DISTINCT videoId FROM qa_cache_jobs WHERE leaseUntil>?').all(now()).flatMap(row=>idFolders(row.videoId));
            for(const id of pipeline.keys())activeIds.push(...idFolders(id));
            for(const [id,source] of sources)if(source.readers)activeIds.push(...idFolders(id));
            const active=new Set(activeIds);
            for(const entry of await fs.readdir(workRoot,{withFileTypes:true}).catch(()=>[])) {
                if(entry.name.startsWith('.expired-')) { await fs.rm(path.join(workRoot,entry.name),{recursive:true,force:true});continue; }
                if(!entry.isDirectory()||active.has(entry.name))continue;
                const folder=path.join(workRoot,entry.name);
                for(const child of await fs.readdir(folder,{withFileTypes:true})) {
                    const file=path.join(folder,child.name),stat=await fs.stat(file).catch(()=>null);
                    if(stat && stat.mtimeMs+ttlMs<=now()) {
                        const tombstone=path.join(workRoot,`.expired-${crypto.randomUUID()}`);
                        const moved=manager.store.db.transaction(()=>{
                            const live=manager.store.db.prepare('SELECT DISTINCT videoId FROM qa_cache_jobs WHERE leaseUntil>?').all(now());
                            if(live.some(row=>idFolders(row.videoId).includes(entry.name))||[...pipeline.keys()].some(id=>idFolders(id).includes(entry.name)))return false;
                            try { require('node:fs').renameSync(file,tombstone);return true; } catch(error) { if(error.code==='ENOENT')return false;throw error; }
                        }).immediate();
                        if(moved)await fs.rm(tombstone,{recursive:true,force:true});
                    }
                }
            }
            for(const [id,source] of sources)if(source.owned&&!source.readers && !await fs.stat(source.file).catch(()=>null))sources.delete(id);
        },
        beginPipeline(videoId) {
            if(pipeline.has(videoId))return pipeline.get(videoId);
            // Reserve immediately before the generator starts its download. Q&A
            // then waits for this source rather than issuing another full download.
            let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});
            let readySource, finishFrames, failFrames, pinned=false, framesComplete=false;
            const framesDone=new Promise((a,b)=>{finishFrames=a;failFrames=b;});framesDone.catch(()=>{});
            // The generator calls publish once per extracted frame. Keep one
            // fenced lease for the pipeline instead of claiming/releasing a
            // cache job and writing two log lines for every individual frame.
            let publishLease, publishLeasePromise, publishTimer;
            async function publisher() {
                if(publishLeasePromise)return publishLeasePromise;
                publishLeasePromise=(async()=>{
                    const controller=new AbortController();const lease=await leaseFor(videoId,'pipeline-v1',controller.signal);
                    if(!lease)return null;
                    publishLease=lease;
                    publishTimer=setInterval(()=>{try{manager.store.renew(lease);}catch{controller.abort();}},15000);publishTimer.unref?.();
                    report(videoId,'work_started',{version:'pipeline-v1'});
                    return lease;
                })();
                return publishLeasePromise;
            }
            async function closePublisher(error) {
                let lease;try { lease=await publishLeasePromise; } catch { return; }
                if(!lease)return;
                clearInterval(publishTimer);
                if(error) {
                    const code=typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'CACHE_WORK_FAILED';
                    report(videoId,'work_failed',{version:'pipeline-v1',code});
                    try { manager.store.transition(lease,'retryable_failed',{retryAfter:now()+60000,lastError:error.code||'cache-work-failed'}); } catch {}
                } else report(videoId,'work_completed',{version:'pipeline-v1'});
                try { manager.store.release(lease); } catch {}
                publishLease=null;
            }
            const entry={promise,framesDone,
                async publish(frame) { const lease=await publisher();if(lease)await manager.publishFrame(lease,frame,FRAME_VERSION); },
                async complete(durationMs){
                    if(!framesComplete){framesComplete=true;finishFrames();if(durationMs)service.ensureFullCache(videoId,durationMs).catch(()=>{});}
                    await closePublisher();
                },
                async withSource(target,download) {
                    let downloaded=false;
                    const source=await ensureRawSource(videoId,async signal=>{await download(signal);downloaded=true;return target;});
                    source.readers++;pinned=true;readySource=source;
                    await materialize(source.file,target);entry.ready(source.file);
                    if(!downloaded && adapter.subtitles) {
                        try { await adapter.subtitles(videoId,path.dirname(target),new AbortController().signal,{forceDownload:true}); } catch { /* Missing captions leave the generator's dialogue track empty. */ }
                    }
                },
                ready(file){readySource=sources.get(videoId)||{file,owned:false,readers:0};sources.set(videoId,readySource);sourceEvents.emit(videoId,readySource);resolve(readySource);},
                async fail(){const error=new Error('Pipeline frames failed');reject(new Error('Pipeline source failed'));failFrames(error);await closePublisher(error);pipeline.delete(videoId);},
                async finish(){
                    reject(new Error('Pipeline source closed'));
                    if(!framesComplete){const error=new Error('Pipeline frames closed');failFrames(error);await closePublisher(error);}
                    // Stop new readers before allowing the generator to remove its MP4.
                    pipeline.delete(videoId);
                    if(!readySource?.owned && sources.get(videoId)===readySource)sources.delete(videoId);
                    await fullJobs.get(videoId)?.catch(()=>{});
                    if(pinned){readySource.readers--;pinned=false;}
                    while(readySource?.readers)await pause(25);
                    if(readySource)await cleanupSource(videoId,readySource);
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
                        const result=await extract({inputPath:source.file,outputDir:out,durationMs,signal,priorityTimestampMs:priorities.get(videoId)||0,onFrame:async frame=>{
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
        async ensureCurrentWindow(videoId,timestampMs,durationMs,{signal,around=false}={}) {
            priorities.set(videoId,timestampMs);
            let frames=current(videoId,timestampMs,durationMs,around);
            if(windowReady(videoId,frames,timestampMs,durationMs,around)){report(videoId,'window_hit',{timestampMs,frames:frames.length});return frames;}
            report(videoId,'window_miss',{timestampMs});
            const bucket=Math.floor(timestampMs/10000);const key=videoId+':'+bucket;
            if(!windowJobs.has(key)) {
                const task=owned(videoId,`window-v2-${bucket}`,async(lease,taskSignal)=>{
                    const dir=await directory(videoId,'window');let source=await rememberedSource(videoId);let section=null;let reading=false;
                    try {
                        if(!source) {
                            try {
                                const cancelSection=new AbortController();
                                let onSource;
                                const available=new Promise(resolve=>{onSource=value=>{value.readers++;reading=true;source=value;resolve({source:value});};sourceEvents.once(videoId,onSource);});
                                const downloading=adapter.section(videoId,Math.max(0,bucket*10000-4000),Math.min(durationMs,(bucket+1)*10000+FRAME_RADIUS_MS+1000),dir,AbortSignal.any([taskSignal,cancelSection.signal]));
                                try {
                                    const winner=await Promise.race([downloading.then(value=>({section:value})),available]);
                                    if(source){cancelSection.abort();await downloading.catch(()=>{});}
                                    else section=winner.section;
                                } finally {sourceEvents.removeListener(videoId,onSource);}
                            }
                            catch (error) {
                                if(taskSignal.aborted)throw abortError();
                                report(videoId,'window_source_fallback',{code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'SECTION_UNAVAILABLE'});
                                // Only the downloaded source is needed for a small window.
                                // Waiting for full-cache extraction here serializes the
                                // first answer behind every keyframe and backfill.
                                source ||= await getSource(videoId,lease,taskSignal);
                            }
                        }
                        if(source&&!reading){source.readers++;reading=true;}
                        const end=Math.min(durationMs-1,(bucket+1)*10000+FRAME_RADIUS_MS-1);
                        const window=await windowExtract({inputPath:source?.file||section.file,outputDir:path.join(dir,'frames'),startMs:Math.max(0,bucket*10000-4000),endMs:end,
                            sourceOriginPtsMs:section?.originPtsMs,section:!!section,signal:taskSignal});
                        for(const frame of window)await manager.publishFrame(lease,frame,FRAME_VERSION);
                    } finally {if(reading){source.readers--;await cleanupSource(videoId,source);}await fs.rm(dir,{recursive:true,force:true});}
                });
                windowJobs.set(key,task);task.catch(()=>{}).finally(async()=>{windowJobs.delete(key);const source=sources.get(videoId);if(source)await cleanupSource(videoId,source);}).catch(()=>{});
            }
            await waitFor(windowJobs.get(key),signal);frames=current(videoId,timestampMs,durationMs,around);
            if(!frames.length){await waitFor(service.ensureFullCache(videoId,durationMs),signal);frames=current(videoId,timestampMs,durationMs,around);}
            if(!frames.length)throw new Error('No verified past frame');return frames;
        },
        async publishSubtitles(videoId, file, metadata = {}) {
            // Serialize with an in-flight Q&A download before publishing generator captions.
            await subtitleJobs.get(videoId)?.catch(() => {});
            return owned(videoId, SUB_VERSION, async lease => {
                if (file) {
                    parseVtt(await fs.readFile(file, 'utf8'), metadata);
                    await manager.publishSubtitle(lease, file, metadata);
                } else {
                    // No generator captions does not prove YouTube has no subtitles.
                    // Leave absence discovery to the ordinary bounded downloader.
                    report(videoId, 'pipeline_subtitle_missing');
                }
            });
        },
        async ensureSubtitles(videoId,{signal}={}) {
            const existing=manager.store.subtitle(videoId,SUB_VERSION);
            if(existing && (existing.state==='ready'||existing.retryAfter>now())) {
                try { const result=await reader(videoId,SUB_VERSION);report(videoId,'subtitle_hit',{state:result.state,cues:result.cues.length});return result; } catch { manager.invalidateSubtitle(videoId,SUB_VERSION); }
            }
            if(!subtitleJobs.has(videoId)) {
                report(videoId,'subtitle_miss');
                const task=owned(videoId,SUB_VERSION,async(lease,taskSignal)=>{
                    const dir=await directory(videoId,'subtitles');
                    try {const result=await adapter.subtitles(videoId,dir,taskSignal);
                        if(result){parseVtt(await fs.readFile(result.file,'utf8'),result.metadata);await manager.publishSubtitle(lease,result.file,result.metadata);}
                        else {manager.subtitleUnavailable(lease,'absent');report(videoId,'subtitle_absent');}
                    }catch(error){if(taskSignal.aborted||error.code==='STALE_CACHE_LEASE')throw error;manager.subtitleUnavailable(lease,'retryable_failed');report(videoId,'subtitle_failed',{code:'SUBTITLE_DOWNLOAD_OR_VALIDATION_FAILED'});}
                    finally{await fs.rm(dir,{recursive:true,force:true});}
                });
                subtitleJobs.set(videoId,task);task.catch(()=>{}).finally(()=>subtitleJobs.delete(videoId));
            }
            await waitFor(subtitleJobs.get(videoId),signal);return reader(videoId,SUB_VERSION);
        },
        async prepare(videoId,timestampMs,durationMs,{signal,warm=true,referenceId}={}) {
            if(!/^[A-Za-z0-9_-]{11}$/.test(videoId)||!Number.isSafeInteger(timestampMs)||timestampMs<0||!Number.isSafeInteger(durationMs)||durationMs<=0||timestampMs>=durationMs)throw new Error('Invalid Q&A media request');
            if(referenceId)manager.touchReference(videoId,FRAME_VERSION,referenceId);
            const fromCache=windowReady(videoId,current(videoId,timestampMs,durationMs,true),timestampMs,durationMs,true);
            const subtitles=service.ensureSubtitles(videoId,{signal});
            const frames=service.ensureCurrentWindow(videoId,timestampMs,durationMs,{signal,around:true});
            report(videoId,'prepare',{timestampMs,warm,cacheRoot:manager.root});
            if(warm)service.ensureFullCache(videoId,durationMs).catch(()=>report(videoId,'warming_failed'));
            const values=await Promise.all([frames,subtitles]);report(videoId,'prepared',{frames:values[0].length,subtitleState:values[1].state,cues:values[1].cues.length});return {fromCache,frames:values[0].map(frame=>({...frame,path:manager.assetPath(frame.relativePath)})),subtitles:values[1]};
        },
        // This deliberately does not share prepare(): prepare may acquire a
        // lease, download media, extract frames, fetch captions, or schedule a
        // warm-up.  Opening a chat must never make a cold video wait.
        async prepareCacheOnly(videoId, timestampMs, durationMs) {
            if(!/^[A-Za-z0-9_-]{11}$/.test(videoId)||!Number.isSafeInteger(timestampMs)||timestampMs<0||!Number.isSafeInteger(durationMs)||durationMs<=0||timestampMs>=durationMs) {
                throw Object.assign(new Error('QA_OPENING_SUMMARY_CACHE_MISS'), { code: 'QA_OPENING_SUMMARY_CACHE_MISS' });
            }
            const miss = () => { throw Object.assign(new Error('QA_OPENING_SUMMARY_CACHE_MISS'), { code: 'QA_OPENING_SUMMARY_CACHE_MISS' }); };
            const frames = current(videoId, timestampMs, durationMs, true);
            if (!windowReady(videoId, frames, timestampMs, durationMs, true)) miss();
            let subtitles;
            try { subtitles = await reader(videoId, SUB_VERSION); } catch { miss(); }
            try {
                // Make corrupted frame assets an eligibility miss before the
                // context builder can access them. No cache state is mutated.
                const verified = await Promise.all(frames.map(async frame => {
                    const file = manager.assetPath(frame.relativePath);
                    const stat = await fs.stat(file);
                    if (!stat.isFile() || (frame.checksum && await checksum(file) !== frame.checksum)) throw new Error('invalid frame');
                    return { ...frame, path: file };
                }));
                return { fromCache: true, frames: verified, subtitles };
            } catch { miss(); }
        },
    };
    return service;
}
module.exports={createQaMedia,createDefaultMediaAdapter,classifyYtdlpFailure,FRAME_VERSION,SUB_VERSION,waitFor};
