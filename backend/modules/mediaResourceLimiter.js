'use strict';
const { spawn } = require('node:child_process');
const { mediaDiskBudget, directoryBytes } = require('./mediaDiskBudget');

function abortError() { return Object.assign(new Error('Media operation aborted'), { name: 'AbortError' }); }

function createMediaResourceLimiter(limits = { download: 3, fullDownload: 1, ffmpeg: 3, backfill: 2, whisper: 2 }) {
    limits = { ...limits };
    for (const value of Object.values(limits)) if (!Number.isInteger(value) || value < 1) throw new Error('Invalid resource limit');
    const used = Object.fromEntries(Object.keys(limits).map(key => [key, 0]));
    const queue = [];
    let sequence = 0;
    function pump() {
        queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        for (let i = 0; i < queue.length;) {
            const item = queue[i];
            if (!Object.entries(item.needs).every(([key, value]) => used[key] + value <= limits[key])) { i++; continue; }
            queue.splice(i, 1);
            item.signal?.removeEventListener('abort', item.abort);
            for (const [key, value] of Object.entries(item.needs)) used[key] += value;
            let released = false;
            item.resolve(() => {
                if (released) return;
                released = true;
                for (const [key, value] of Object.entries(item.needs)) used[key] -= value;
                pump();
            });
        }
    }
    return {
        acquire(needs, { priority = 0, signal } = {}) {
            if (!needs || typeof needs !== 'object' || Array.isArray(needs) || !Number.isFinite(priority) || !Object.keys(needs).length || Object.entries(needs).some(([key, n]) =>
                !Object.hasOwn(limits, key) || !Number.isInteger(n) || n < 1 || n > limits[key])) return Promise.reject(new Error('Invalid resource reservation'));
            if (signal?.aborted) return Promise.reject(abortError());
            return new Promise((resolve, reject) => {
                const item = { needs: { ...needs }, priority, signal, resolve, reject, sequence: sequence++ };
                item.abort = () => {
                    const index = queue.indexOf(item);
                    if (index >= 0) queue.splice(index, 1);
                    reject(abortError());
                    pump();
                };
                signal?.addEventListener('abort', item.abort, { once: true });
                queue.push(item); pump();
            });
        },
        snapshot: () => ({ limits: { ...limits }, used: { ...used }, queued: queue.length }),
    };
}
const mediaResourceLimiter = createMediaResourceLimiter();

// One atomic reservation covers yt-dlp AND any FFmpeg child it starts. A queue
// waiter holds no partial permits. Keep permits until the process group exits.
async function runMediaProcess(file, args, { needs, priority = 0, signal, timeoutMs = 180000,
    cwd, env, onStdout, onStderr, disk, maxOutputBytes = 1024 * 1024, limiter = mediaResourceLimiter } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid process limits');
    const release = await limiter.acquire(needs, { priority, signal });
    let reservation;
    try {
        if (disk) {
            reservation = mediaDiskBudget.reserve(disk.root, disk.maxBytes);
            reservation.check(directoryBytes(disk.root));
        }
        if (signal?.aborted) throw abortError();
        return await new Promise((resolve, reject) => {
            let child;
            let timeout;
            let killTimer;
            let diskTimer;
            let failure;
            let stdout = '';
            let stderr = '';
            let outputBytes = 0;
            let closed = false;
            const killGroup = signalName => {
                try {
                    if (process.platform !== 'win32') process.kill(-child.pid, signalName);
                    else child.kill(signalName);
                } catch (error) { if (error.code !== 'ESRCH') failure ||= error; }
            };
            const stop = error => {
                if (closed || failure) return;
                failure = error;
                killGroup('SIGTERM');
                killTimer = setTimeout(() => killGroup('SIGKILL'), 1000);
            };
            const abort = () => stop(abortError());
            const consume = (chunk, callback, stream) => {
                if (closed || failure) return;
                outputBytes += chunk.length;
                if (outputBytes > maxOutputBytes) return stop(Object.assign(new Error('Media output limit exceeded'), { code: 'MEDIA_OUTPUT_LIMIT' }));
                try { callback?.(chunk); } catch (error) { stop(error); }
                if (stream === 'stdout') stdout += chunk.toString();
                else stderr += chunk.toString();
            };
            try { child = spawn(file, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
            catch (error) { reject(error); return; }
            child.stdout.on('data', chunk => consume(chunk, onStdout, 'stdout'));
            child.stderr.on('data', chunk => consume(chunk, onStderr, 'stderr'));
            child.on('error', error => { failure ||= error; });
            child.on('close', async (code, exitSignal) => {
                closed = true;
                clearTimeout(timeout); clearTimeout(killTimer); clearInterval(diskTimer);
                signal?.removeEventListener('abort', abort);
                // The main process may close while a helper with independent
                // stdio remains. Terminate and reap the group before releasing permits.
                if (child.pid && process.platform !== 'win32') {
                    killGroup('SIGKILL');
                    for (let attempt = 0; attempt < 50; attempt++) {
                        try { process.kill(-child.pid, 0); }
                        catch (error) {
                            if (error.code !== 'ESRCH') failure ||= error;
                            break;
                        }
                        await new Promise(done => setTimeout(done, 20));
                        if (attempt === 49) failure ||= Object.assign(new Error('Media process group did not exit'), { code: 'MEDIA_GROUP_TIMEOUT' });
                    }
                }
                if (!failure && reservation) {
                    try { reservation.check(directoryBytes(disk.root)); } catch (error) { failure = error; }
                }
                if (failure) reject(failure);
                else if (code !== 0) reject(Object.assign(new Error('Media process failed'), { code: 'MEDIA_EXIT', exitCode: code, exitSignal, stderr }));
                else resolve({ stdout, stderr });
            });
            timeout = setTimeout(() => stop(Object.assign(new Error('Media process timed out'), { code: 'MEDIA_TIMEOUT' })), timeoutMs);
            if (reservation) diskTimer = setInterval(() => {
                try { reservation.check(directoryBytes(disk.root)); } catch (error) { stop(error); }
            }, 1000);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        });
    } finally { reservation?.release(); release(); }
}
// Event facade for legacy spawn call sites. It queues before spawning and keeps
// existing data/error/close handlers while enforcing the common process budget.
function spawnLimitedMedia(file, args, options = {}, needs, priority = 0) {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const controller = new AbortController();
    child.kill = () => { controller.abort(); return true; };
    runMediaProcess(file, args, { ...options, needs, priority, signal: controller.signal,
        onStdout: bytes => child.stdout.emit('data', bytes),
        onStderr: bytes => child.stderr.emit('data', bytes),
    }).then(() => child.emit('close', 0), error => {
        if (error.code !== 'MEDIA_EXIT') child.emit('error', error);
        child.emit('close', error.exitCode || 1);
    });
    return child;
}
module.exports = { createMediaResourceLimiter, mediaResourceLimiter, runMediaProcess, spawnLimitedMedia };
