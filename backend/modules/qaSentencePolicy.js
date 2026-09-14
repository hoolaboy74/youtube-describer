'use strict';
const { StringDecoder } = require('node:string_decoder');
const { normalizeText } = require('./canonicalOutput');
const { SEARCH_UNAVAILABLE, EXTERNAL_PREFIX } = require('./qaSearch');
const POLICY_VERSION = 'qa-sentence-v2';
const UNKNOWN = '현재 화면에서 확인할 수 있는 정보가 부족합니다.';
const EXPLANATIONS = new Set([SEARCH_UNAVAILABLE, UNKNOWN, '화면만으로는 알 수 없습니다.', '확인된 외국어 대사가 없어 번역할 수 없습니다.']);
const compact = text => normalizeText(text).replace(/[^\p{L}\p{N}]/gu, '');
function duplicate(a, b) {
    const left = compact(a), right = compact(b);
    if (!left || !right) return false;
    if (left === right) return true;
    if (Math.min(left.length, right.length) >= 6 && (left.includes(right) || right.includes(left))) return true;
    // Conservative lexical near-duplicate gate; paraphrase factuality still
    // requires evaluation. This is deliberately not a semantic-proof claim.
    const grams = value => new Set(Array.from({ length: Math.max(0, value.length - 1) }, (_, i) => value.slice(i, i + 2)));
    const x = grams(left), y = grams(right);
    const overlap = [...x].filter(g => y.has(g)).length;
    return Math.min(left.length, right.length) >= 8 && 2 * overlap / (x.size + y.size) >= 0.72;
}
function validateSentence(candidate, context, accepted = []) {
    const reject = reason => ({ accepted: false, reason });
    if (!candidate || !Number.isSafeInteger(candidate.seq) || candidate.seq < 0 || typeof candidate.text !== 'string'
        || !Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.length > 8) return reject('schema');
    const text = candidate.text.trim();
    if (!text || text.length > 240 || /[\r\n\u0000-\u001f<>`]/.test(text) || /https?:|\[[^\]]*\]/.test(text)
        || !/[가-힣]/.test(text) || !/(?:습니다|입니다|니다|세요|어요|아요|해요|예요|이에요|지요|네요)[.!?]$/.test(text)) return reject('sentence');
    if (accepted.some(value => duplicate(value.text, text))) return reject('duplicate');
    const evidence = candidate.evidenceIds.map(id => context.evidence.get(id));
    if (evidence.some(value => !value)) return reject('evidence');
    const window = context.frameWindow || { startMs: 0, endMs: context.timestampMs };
    if (evidence.some(value => value.kind === 'frame' ? value.timestampMs > window.endMs || value.timestampMs < window.startMs
        : value.kind === 'cue' && value.end * 1000 > window.endMs)) return reject('future');
    if (/(?:분명히|틀림없이|아마도|인 것 같)/.test(text)) return reject('unsupported-inference');
    const restricted = text.match(/(?:때문에|의도|속마음|연인|부부|아버지|어머니|슬퍼|행복해|화가 나)/g) || [];
    // A relationship/causal term explicitly in a cited description is usable;
    // a visual frame ID alone cannot justify invented narrative information.
    if (restricted.some(term => !evidence.some(item => item.kind === 'script' && item.text.includes(term)))) return reject('unsupported-inference');
    if (candidate.kind === 'explanation') {
        const external = evidence.length === 1 && evidence[0].kind === 'external' && text === EXTERNAL_PREFIX + evidence[0].claim;
        if (!external && (!EXPLANATIONS.has(text) || evidence.length)) return reject('explanation');
    } else if (candidate.kind === 'context') {
        if (!evidence.some(value => ['script', 'title'].includes(value.kind))
            || evidence.some(value => !['script', 'title', 'frame'].includes(value.kind))) return reject('context-evidence');
    } else if (candidate.kind === 'translation') {
        if (!['foreign', 'mixed'].includes(context.audioClassification) || !evidence.length
            || evidence.some(value => value.kind !== 'cue' || !value.confirmed || !value.sourceLanguage
                || ['ko', 'unknown'].includes(value.sourceLanguage.toLowerCase()) || value.sourceLanguage.toLowerCase().startsWith('ko-'))) return reject('translation-provenance');
    } else if (['visual', 'screen_text'].includes(candidate.kind)) {
        if (!evidence.length || evidence.some(value => value.kind !== 'frame')) return reject('visual-evidence');
    } else return reject('kind');
    const spoken = context.cues.filter(cue => cue.sourceLanguage === 'ko' || ['korean', 'mixed', 'unknown'].includes(context.audioClassification));
    if (spoken.some(cue => duplicate(text, cue.sourceText))) return reject('audible-duplicate');
    return { accepted: true, sentence: Object.freeze({ seq: accepted.length, text, kind: candidate.kind,
        evidenceIds: Object.freeze([...candidate.evidenceIds]), policyVersion: POLICY_VERSION,
        ...(evidence[0]?.kind === 'external' ? { sources: Object.freeze(evidence[0].sources.map(source => Object.freeze({ ...source }))) } : {}) }) };
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
module.exports = { POLICY_VERSION, UNKNOWN, validateSentence, duplicate, createSentenceParser };
