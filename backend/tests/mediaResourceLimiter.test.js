const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaResourceLimiter, runMediaProcess } = require('../modules/mediaResourceLimiter');

test('multi-resource reservations never hold partial permits and prioritize current windows', async () => {
    const limiter = createMediaResourceLimiter({ download: 2, fullDownload: 1, ffmpeg: 1 });
    const hold = await limiter.acquire({ download: 1, fullDownload: 1, ffmpeg: 1 });
    const order = [];
    const full = limiter.acquire({ download: 1, fullDownload: 1, ffmpeg: 1 }).then(release => { order.push('full'); release(); });
    const current = limiter.acquire({ download: 1, ffmpeg: 1 }, { priority: 10 }).then(release => { order.push('current'); release(); });
    assert.deepEqual(limiter.snapshot().used, { download: 1, fullDownload: 1, ffmpeg: 1 });
    hold(); hold();
    await Promise.all([full, current]);
    assert.deepEqual(order, ['current', 'full']);
    assert.deepEqual(limiter.snapshot().used, { download: 0, fullDownload: 0, ffmpeg: 0 });
});
test('canceling a queued waiter preserves active permits and other waiters', async () => {
    const limiter = createMediaResourceLimiter({ ffmpeg: 1 });
    const release = await limiter.acquire({ ffmpeg: 1 });
    const controller = new AbortController();
    const waiter = limiter.acquire({ ffmpeg: 1 }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(waiter, { name: 'AbortError' });
    assert.equal(limiter.snapshot().used.ffmpeg, 1);
    release();
    await assert.rejects(limiter.acquire({ unknown: 1 }));
});
test('process timeout, spawn failure and output limit return their permits', async () => {
    const limiter = createMediaResourceLimiter({ ffmpeg: 1 });
    const options = { limiter, needs: { ffmpeg: 1 } };
    await assert.rejects(runMediaProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, timeoutMs: 40 }), { code: 'MEDIA_TIMEOUT' });
    await assert.rejects(runMediaProcess('/no-such-qa-executable', [], options), { code: 'ENOENT' });
    await assert.rejects(runMediaProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024))'], { ...options, maxOutputBytes: 20 }), { code: 'MEDIA_OUTPUT_LIMIT' });
    assert.equal(limiter.snapshot().used.ffmpeg, 0);
});
test('running cancellation terminates a child process group', async () => {
    if (process.platform === 'win32') return;
    const controller = new AbortController();
    let descendant;
    const operation = runMediaProcess(process.execPath, ['-e', `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); console.log(c.pid); setInterval(()=>{},1000);`],
        { needs: { ffmpeg: 1 }, signal: controller.signal, onStdout: bytes => { descendant = Number(bytes.toString().trim()); controller.abort(); } });
    await assert.rejects(operation, { name: 'AbortError' });
    // Process groups can take a short scheduling turn to reap descendants.
    for (let i = 0; i < 50; i++) {
        try { process.kill(descendant, 0); } catch (e) { if (e.code === 'ESRCH') return; throw e; }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('descendant still alive');
});

const { createMediaDiskBudget } = require('../modules/mediaDiskBudget');
test('disk reservations share a volume, count remaining writes once, and fail when disk fills', () => {
    let available = 1000;
    const budget = createMediaDiskBudget({ minFreeBytes: 100, statfs: () => ({ bavail: available, bsize: 1 }), deviceFor: () => 1 });
    const first = budget.reserve('a', 500);
    assert.throws(() => budget.reserve('b', 401), { code: 'MEDIA_DISK_FULL' });
    available -= 200;
    first.check(200);
    const second = budget.reserve('b', 400);
    assert.throws(() => first.check(501), { code: 'MEDIA_DISK_LIMIT' });
    available = 500;
    assert.throws(() => first.check(200), { code: 'MEDIA_DISK_FULL' });
    first.release(); first.release(); second.release();
    assert.deepEqual(budget.snapshot(), { active: 0, remainingBytes: 0 });
});
test('legacy event adapter reports spawn and exit failures without duplicate close events', async () => {
    const { spawnLimitedMedia } = require('../modules/mediaResourceLimiter');
    for (const file of ['/no-such-qa-executable', process.execPath]) {
        const result = await new Promise(resolve => {
            const child = spawnLimitedMedia(file, ['-e', 'process.exit(7)'], {}, { ffmpeg: 1 });
            const events = [];
            child.on('error', error => events.push(error.code));
            child.on('close', code => { events.push(code); resolve(events); });
        });
        assert.deepEqual(result, file === process.execPath ? [7] : ['ENOENT', 1]);
    }
});

test('invalid or inherited resource names cannot create a waiter that never resolves', async () => {
    const limiter = createMediaResourceLimiter({ ffmpeg: 1 });
    await assert.rejects(limiter.acquire(undefined));
    await assert.rejects(limiter.acquire({ toString: 1 }));
    assert.equal(limiter.snapshot().queued, 0);
});
