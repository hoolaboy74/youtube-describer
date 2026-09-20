'use strict';
const { StringDecoder } = require('node:string_decoder');
const POLICY_VERSION = 'qa-format-v1';
const UNKNOWN = '현재 화면에서 확인할 수 있는 정보가 부족합니다.';
// Gemini may occasionally echo an internal evidence/citation token even when
// the prompt says not to. Never expose long opaque IDs to the user or TTS.
function removeInternalReferences(text) {
    const cleaned = text.replace(/\[(?:[a-f0-9]{32,}|(?:frame|script|cue|video-title)-[^\]]+)\]/gi, '');
    return cleaned === text ? text : cleaned.replace(/[ \t]{2,}/g, ' ').trim();
}
// Transport validation only. No evidence, language, meaning, relationship,
// repetition, grounding-support or politeness tests are applied to answer text.
function validateSentence(candidate, context, accepted = []) {
    const reject = reason => ({ accepted: false, reason });
    if (!candidate || !Number.isSafeInteger(candidate.seq) || candidate.seq < 0 || typeof candidate.text !== 'string') return reject('schema');
    const text = removeInternalReferences(candidate.text);
    if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return reject('text-format');
    if (Buffer.byteLength(text) > 8192) return reject('text-size');
    return { accepted: true, sentence: Object.freeze({ seq: accepted.length, text, policyVersion: POLICY_VERSION }) };
}
function createSentenceParser(onCandidate) {
    const decoder = new StringDecoder('utf8');
    let pending = '', next = 0, fenced = false, closed = false;
    function record(line) {
        if (!line) return;
        if (!fenced && next === 0 && /^```(?:jsonl?|ndjson)?$/i.test(line)) { fenced = true; return; }
        if (fenced && !closed && line === '```') { closed = true; return; }
        if (closed) throw new Error('QA_RECORD_AFTER_END');
        const value = JSON.parse(line);
        if (value.seq !== next++) throw new Error('QA_RECORD_SEQUENCE');
        onCandidate(value);
    }
    function consume(text) {
        pending += text;
        if (Buffer.byteLength(pending) > 16384) throw new Error('QA_RECORD_TOO_LARGE');
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
            record(line);
        }
    }
    return { push(chunk) { consume(typeof chunk === 'string' ? chunk : decoder.write(chunk)); },
        end() {
            consume(decoder.end()); const tail = pending.trim(); pending = '';
            if (!tail) return { count: next, unfinished: false };
            if (fenced && tail === '```') { record(tail); return { count: next, unfinished: false }; }
            try { JSON.parse(tail); } catch { return { count: next, unfinished: true }; }
            record(tail); return { count: next, unfinished: false };
        } };
}
module.exports = { POLICY_VERSION, UNKNOWN, removeInternalReferences, validateSentence, createSentenceParser };
