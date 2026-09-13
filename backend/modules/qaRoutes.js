'use strict';
const express = require('express');
function createQaRouter({ auth, store, run, manager, synthesizeSentence, enabled = () => process.env.QA_INCREMENTAL_SPEECH_ENABLED === 'true' }) {
    const router = express.Router();
    const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(error => {
        if (res.headersSent) return res.destroy();
        res.status(error.status || 500).json({ code: error.code || 'QA_REQUEST_FAILED' });
    });
    router.get('/config', auth, (req, res) => res.json({ incrementalSpeech: enabled(), oggStreaming: process.env.QA_OGG_STREAMING_ENABLED === 'true', cacheWarming: process.env.QA_CACHE_WARMING_ENABLED === 'true' }));
    router.use((req, res, next) => enabled() ? next() : res.status(404).json({ code: 'QA_DISABLED' }));
    const owned = req => store.get(req.params.id, req.user.id);
    router.post('/requests', auth, wrap((req, res) => {
        const { request, created } = store.accept(req.user.id, req.body);
        res.status(202).json({ requestId: request.input.requestId, eventsPath: `/api/qa/requests/${request.input.requestId}/events`,
            audioPath: request.input.audioMode === 'ogg' && !['failed', 'canceled'].includes(request.status) ? `/api/qa/audio/${store.ticket(request)}` : null });
        if (created) run(request).catch(() => store.finish(request, 'error', { code: 'QA_REQUEST_FAILED' }));
    }));
    router.get('/requests/:id/events', auth, wrap((req, res) => {
        const request = owned(req); if (!request) return res.status(404).json({ code: 'QA_REQUEST_MISSING' });
        const after = Number(req.headers['last-event-id'] || req.query.after || 0);
        if (!Number.isSafeInteger(after) || after < 0 || after > request.events.length) return res.status(400).json({ code: 'QA_INVALID_CURSOR' });
        if (request.emitter.listenerCount('event') >= 3) return res.status(429).end();
        res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
        const send = event => {
            if (res.destroyed) return;
            if (res.writableLength > 65536) return res.destroy();
            res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
            if (['audio_done', 'error', 'canceled'].includes(event.type)) res.end();
        };
        request.events.filter(event => event.id > after).forEach(send);
        if (request.terminalAt !== null) return res.end();
        request.emitter.on('event', send);
        const heartbeat = setInterval(() => { if (res.writableLength > 65536) res.destroy(); else res.write(': keepalive\n\n'); }, 15000); heartbeat.unref?.();
        res.on('close', () => { clearInterval(heartbeat); request.emitter.removeListener('event', send); });
    }));
    router.post('/requests/:id/cancel', auth, wrap((req, res) => {
        const request = owned(req); if (!request) return res.status(404).json({ code: 'QA_REQUEST_MISSING' });
        store.finish(request, 'canceled'); res.json({ status: request.status });
    }));
    router.post('/requests/:id/audio', auth, wrap(async (req, res) => {
        const request = owned(req); if (!request) return res.status(404).json({ code: 'QA_REQUEST_MISSING' });
        const seq = req.body?.seq;
        if (!Number.isInteger(seq) || seq < 0) return res.status(404).json({ code: 'QA_AUDIO_UNAVAILABLE' });
        if (!request.audio.has(seq)) {
            const sentence = request.sentences.find(value => value.seq === seq);
            if (!sentence || request.status !== 'completed' || !synthesizeSentence) return res.status(404).json({ code: 'QA_AUDIO_UNAVAILABLE' });
            request.replayPromises ||= new Map();
            if (!request.replayPromises.has(seq)) {
                const task = synthesizeSentence(sentence.text, request.controller.signal).then(bytes => store.putAudio(request, seq, bytes));
                request.replayPromises.set(seq, task);
                task.finally(() => request.replayPromises.delete(seq)).catch(() => {});
            }
            await request.replayPromises.get(seq);
        }
        res.json({ path: `/api/qa/audio/${store.ticket(request, seq)}` });
    }));
    router.get('/audio/:ticket', wrap(async (req, res) => {
        const grant = store.audioGrant(req.params.ticket); if (!grant) return res.status(404).end();
        const { request, seq } = grant;
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
        if (seq !== null) {
            const bytes = request.audio.get(seq); if (!bytes) return res.status(404).end();
            return res.type('audio/mpeg').send(bytes);
        }
        // A continuous stream has one consumer. Reconnecting after partial
        // playback must never silently restart all previously heard sentences.
        if (request.effectiveAudioMode === 'mp3') return res.status(204).end();
        if (request.audioClaimed) return res.status(409).end();
        request.audioClaimed = true;
        const connect = () => {
            if (res.destroyed || !request.ogg) return;
            request.emitter.removeListener('audio', connect);
            res.type('audio/ogg'); request.ogg.output.on('error', () => { if (request.ogg.bytes > 0) res.destroy(); }); request.ogg.output.pipe(res);
        };
        const fallback = () => { if (!res.headersSent) res.status(204); res.end(); };
        request.emitter.on('audio_fallback', fallback);
        const abort = () => res.destroy(); request.controller.signal.addEventListener('abort', abort, { once: true });
        request.emitter.on('audio', connect); connect();
        res.on('close', () => {
            request.emitter.removeListener('audio', connect); request.emitter.removeListener('audio_fallback', fallback); request.controller.signal.removeEventListener('abort', abort);
            if (!res.writableEnded && request.effectiveAudioMode !== 'mp3') store.finish(request, 'error', { code: 'QA_AUDIO_DISCONNECTED' });
        });
    }));
    router.post('/sessions/:id/presence', auth, wrap((req, res) => {
        const { videoId, active = true } = req.body || {};
        store.session(req.user.id, req.params.id, videoId);
        const cache = manager();
        if (active === false) cache.releaseReference(videoId, 'frames-v1', req.params.id);
        else cache.touchReference(videoId, 'frames-v1', req.params.id);
        res.status(204).end();
    }));
    return router;
}
module.exports = { createQaRouter };
