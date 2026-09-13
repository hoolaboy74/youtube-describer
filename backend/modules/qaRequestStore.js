'use strict';
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
function validateRequest(body) {
    if (!body || !idValid(body.requestId) || !idValid(body.sessionId) || !/^[A-Za-z0-9_-]{11}$/.test(body.videoId)
        || !Number.isFinite(body.timestamp) || body.timestamp < 0 || typeof body.question !== 'string' || !body.question.trim()
        || body.question.length > 4000 || !['mp3', 'ogg'].includes(body.audioMode) || !Array.isArray(body.history)) throw fail('QA_INVALID_REQUEST');
    for (const turn of body.history) {
        if (!turn || !idValid(turn.requestId) || !Number.isFinite(turn.timestamp) || turn.timestamp < 0
            || typeof turn.question !== 'string' || typeof turn.answer !== 'string'
            || !['completed', 'partial', 'failed', 'canceled'].includes(turn.status)) throw fail('QA_INVALID_HISTORY');
    }
    // Reject explicitly rather than silently truncating a long conversation.
    if (Buffer.byteLength(JSON.stringify(body)) > 512 * 1024) throw fail('QA_CONTEXT_TOO_LARGE', 413);
    return structuredClone({ requestId: body.requestId, sessionId: body.sessionId, videoId: body.videoId,
        timestamp: body.timestamp, question: body.question, history: body.history, audioMode: body.audioMode });
}
function createQaRequestStore({ now = Date.now, ttlMs = 600000, ticketTtlMs = 60000, maxRequests = 200, receipts } = {}) {
    const requests = new Map(), sessions = new Map(), tickets = new Map();
    function sweep() {
        for (const [id, request] of requests) if (request.terminalAt !== null && request.terminalAt + ttlMs <= now()) requests.delete(id);
        for (const [ticket, grant] of tickets) if (grant.expiresAt <= now() || !requests.has(grant.requestId)) tickets.delete(ticket);
        for (const [id, session] of sessions) if (session.lastSeen + ttlMs <= now() && ![...requests.values()].some(r => r.input.sessionId === id)) sessions.delete(id);
    }
    function session(userId, sessionId, videoId) {
        if (!userId || !idValid(sessionId) || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw fail('QA_INVALID_SESSION');
        sweep(); const existing = sessions.get(sessionId);
        if (existing && (existing.userId !== userId || existing.videoId !== videoId)) throw fail('QA_SESSION_CONFLICT', 409);
        const value = existing || { userId, videoId }; value.lastSeen = now(); sessions.set(sessionId, value); return value;
    }
    function get(id, userId) { sweep(); const request = requests.get(id); return request?.userId === userId ? request : null; }
    function emit(request, type, data = {}) {
        if (request.terminalAt !== null) return null;
        const event = Object.freeze({ id: request.events.length + 1, type, data: structuredClone(data) });
        request.events.push(event); request.emitter.emit('event', event); return event;
    }
    function finish(request, type, data = {}) {
        if (request.terminalAt !== null || request.finishing) return;
        request.finishing = true;
        request.status = type === 'audio_done' ? 'completed' : type === 'canceled' ? 'canceled' : 'failed';
        emit(request, type, data); request.terminalAt = now();
        try { receipts?.finish(request); } catch { request.receiptStatus = 'write_failed'; }
        if (type !== 'audio_done') { request.controller.abort(); for (const [key, ticket] of tickets) if (ticket.requestId === request.input.requestId) tickets.delete(key); }
    }
    return { session, get, emit, finish, sweep,
        markModelStarted(request) { receipts?.started(request); },
        putAudio(request, seq, bytes) {
            const size = entry => [...entry.audio.values()].reduce((sum, value) => sum + value.length, 0);
            if (request.controller.signal.aborted) throw fail('QA_CANCELED');
            if (request.audio.has(seq)) return;
            if (size(request) + bytes.length > 2 * 1024 * 1024 || [...requests.values()].reduce((sum, entry) => sum + size(entry), 0) + bytes.length > 64 * 1024 * 1024) throw fail('QA_AUDIO_MEMORY_LIMIT', 503);
            request.audio.set(seq, bytes);
        },
        accept(userId, body) {
            const input = validateRequest(body); session(userId, input.sessionId, input.videoId);
            const fingerprint = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
            const old = requests.get(input.requestId);
            if (old) { if (old.userId !== userId || old.fingerprint !== fingerprint) throw fail('QA_REQUEST_CONFLICT', 409); return { request: old, created: false }; }
            const receipt = receipts?.get(input.requestId);
            if (receipt) {
                if (receipt.userId !== String(userId) || receipt.fingerprint !== fingerprint) throw fail('QA_REQUEST_CONFLICT', 409);
                throw fail(receipt.status === 'active' ? 'QA_REQUEST_INTERRUPTED' : 'QA_REQUEST_EXPIRED', 410);
            }
            if (requests.size >= maxRequests || [...requests.values()].filter(r => r.userId === userId && r.terminalAt === null).length >= 2) throw fail('QA_BUSY', 429);
            const request = { userId, input, fingerprint, status: 'active', terminalAt: null, controller: new AbortController(),
                events: [], sentences: [], audio: new Map(), emitter: new EventEmitter(), usageStatus: 'unconfirmed' };
            try { receipts?.save(request); } catch (error) { if (error.code?.startsWith('SQLITE_CONSTRAINT')) throw fail('QA_REQUEST_CONFLICT', 409); throw error; }
            requests.set(input.requestId, request); emit(request, 'accepted', { requestId: input.requestId, audioMode: input.audioMode });
            return { request, created: true };
        },
        ticket(request, seq = null) {
            if (['canceled', 'failed'].includes(request.status) && (seq === null || !request.audio.has(seq))) throw fail('QA_AUDIO_UNAVAILABLE', 410);
            const ticket = crypto.randomBytes(32).toString('base64url');
            tickets.set(ticket, { requestId: request.input.requestId, seq, expiresAt: now() + ticketTtlMs }); return ticket;
        },
        audioGrant(ticket) { sweep(); const grant = tickets.get(ticket); const request = grant && requests.get(grant.requestId); return request ? { request, seq: grant.seq } : null; },
    };
}
module.exports = { createQaRequestStore, validateRequest, fail };
