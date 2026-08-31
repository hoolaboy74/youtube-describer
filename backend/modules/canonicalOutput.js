'use strict';

const crypto = require('node:crypto');

const POLICY_VERSION = 'codex-v2';
const CANONICAL_TAGS = Object.freeze(['v1', 'v2', 'v3', 'txt', 'trans']);
const LEGACY_VERBOSITY = Object.freeze({
    v1: 'v1',
    v2: 'v2',
    v3: 'v3',
    txt: 'text',
    trans: 'translation'
});
const AUDIO_LANGUAGES = new Set(['korean', 'foreign', 'mixed', 'unknown']);
const PROVENANCE_KINDS = new Set(['visual', 'screen_text', 'foreign_dialogue']);
const DEFAULT_MAX_TEXT_LENGTH = 120;
const DEFAULT_DUPLICATE_WINDOW = 4;
// The canonical contract is strict by default. The model-generation path
// opts into a one-second tolerance because its timestamps are integers while
// WebVTT cue starts commonly contain milliseconds.
const DEFAULT_DIALOGUE_TIMESTAMP_TOLERANCE = 0;
const MAX_REASON_COUNT = 12;

function normalizeText(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s*([,.!?;:，。！？；：])\s*/g, '$1')
        .toLocaleLowerCase('ko-KR');
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function boundedString(value, max = 240) {
    if (typeof value !== 'string') return undefined;
    const normalized = normalizeText(value);
    return normalized ? normalized.slice(0, max) : undefined;
}

function firstDefined(...values) {
    return values.find(value => value !== undefined && value !== null);
}

function getAudioLanguage(candidate, context) {
    const value = firstDefined(
        candidate.audioLanguage,
        candidate.audioClassification,
        candidate.languageContext,
        context.audioLanguage,
        context.audioClassification
    );
    return typeof value === 'string' ? value.toLowerCase() : undefined;
}

function frameEvidenceFrom(provenance) {
    const evidence = firstDefined(provenance.frameEvidence, provenance.frames, provenance.frame);
    if (Array.isArray(evidence)) return evidence;
    if (evidence && typeof evidence === 'object') return [evidence];
    return [];
}

function dialogueIntervalFrom(provenance, candidate, context) {
    return firstDefined(
        provenance.dialogueInterval,
        provenance.dialogue,
        candidate.dialogueInterval,
        context.dialogueInterval
    );
}

function normalizeDialogueInterval(interval) {
    if (!interval || typeof interval !== 'object') return null;
    const start = Number(interval.start);
    const end = Number(interval.end);
    if (!finiteNumber(start) || !finiteNumber(end) || end <= start) return null;

    const sourceLanguage = firstDefined(
        interval.sourceLanguage,
        interval.language,
        interval.detectedLanguage
    );
    return {
        ...(boundedString(interval.id, 80) ? { id: boundedString(interval.id, 80) } : {}),
        start,
        end,
        ...(typeof sourceLanguage === 'string' ? { sourceLanguage: sourceLanguage.toLowerCase() } : {}),
        ...(boundedString(interval.sourceText, 240) ? { sourceText: boundedString(interval.sourceText, 240) } : {}),
        confirmed: interval.confirmed === true || interval.languageConfirmed === true,
        ...(interval.needed === false || interval.isNeeded === false ? { needed: false } : {}),
        ...(interval.foreign === true || interval.isForeign === true ? { foreign: true } : {})
    };
}

function normalizeProvenance(provenance) {
    if (!provenance || typeof provenance !== 'object') return null;
    const kind = typeof provenance.kind === 'string' ? provenance.kind : undefined;
    const frames = frameEvidenceFrom(provenance).slice(0, 8).map(frame => {
        if (!frame || typeof frame !== 'object') return null;
        const result = {};
        const id = firstDefined(frame.id, frame.frameId, frame.keyframeId);
        const timestamp = firstDefined(frame.timestamp, frame.time);
        const visibleText = firstDefined(frame.visibleText, frame.ocrText, frame.textEvidence);
        if (boundedString(id, 80)) result.id = boundedString(id, 80);
        if (finiteNumber(Number(timestamp))) result.timestamp = Number(timestamp);
        if (boundedString(visibleText, 240)) result.visibleText = boundedString(visibleText, 240);
        if (frame.visible === true) result.visible = true;
        return Object.keys(result).length > 0 ? result : null;
    }).filter(Boolean);
    const visibleTextEvidence = firstDefined(provenance.visibleTextEvidence, provenance.visibleText);
    const dialogueInterval = normalizeDialogueInterval(
        firstDefined(provenance.dialogueInterval, provenance.dialogue)
    );

    return {
        kind,
        ...(frames.length > 0 ? { frameEvidence: frames } : {}),
        ...(boundedString(visibleTextEvidence, 240) ? {
            visibleTextEvidence: boundedString(visibleTextEvidence, 240)
        } : {}),
        ...(dialogueInterval ? { dialogueInterval } : {}),
        ...(typeof provenance.source === 'string' && boundedString(provenance.source, 80)
            ? { source: boundedString(provenance.source, 80) }
            : {})
    };
}

function effectiveProvenance(candidate, context) {
    const provenance = candidate && candidate.provenance && typeof candidate.provenance === 'object'
        ? candidate.provenance
        : null;
    const interval = firstDefined(
        provenance && provenance.dialogueInterval,
        candidate && candidate.dialogueInterval,
        context.dialogueInterval
    );
    if (!provenance || !interval || provenance.dialogueInterval) return provenance;
    return { ...provenance, dialogueInterval: interval };
}

function createCanonicalEventId(event) {
    const provenance = event && event.provenance ? event.provenance : {};
    const interval = provenance.dialogueInterval || {};
    const identity = [
        POLICY_VERSION,
        Number.isFinite(Number(event && event.timestamp)) ? Number(event.timestamp) : '',
        event && event.tag ? String(event.tag) : '',
        normalizeText(event && event.text),
        provenance.kind || '',
        Number.isFinite(Number(interval.start)) ? Number(interval.start) : '',
        Number.isFinite(Number(interval.end)) ? Number(interval.end) : '',
        interval.id || ''
    ].join('|');
    return crypto.createHash('sha256').update(identity).digest('hex');
}

function addReason(reasons, code) {
    if (!reasons.includes(code) && reasons.length < MAX_REASON_COUNT) reasons.push(code);
}

function maxTextLength(context) {
    const configured = firstDefined(
        context.maxTextLength,
        context.maxSentenceLength,
        context.sentenceLimit,
        context.maxChars
    );
    return finiteNumber(Number(configured)) && Number(configured) > 0
        ? Math.floor(Number(configured))
        : DEFAULT_MAX_TEXT_LENGTH;
}

function intervalOverlaps(timestamp, interval, guardBand = 0) {
    return timestamp >= interval.start - guardBand && timestamp < interval.end + guardBand;
}

function dialogueTimestampMatches(timestamp, interval, tolerance = DEFAULT_DIALOGUE_TIMESTAMP_TOLERANCE) {
    if (!interval || !finiteNumber(Number(timestamp))) return false;
    const start = Number(interval.start);
    const end = Number(interval.end);
    if (!finiteNumber(start) || !finiteNumber(end) || end <= start) return false;
    const numericTolerance = Number(tolerance);
    const boundedTolerance = finiteNumber(numericTolerance)
        ? Math.min(1, Math.max(0, numericTolerance))
        : DEFAULT_DIALOGUE_TIMESTAMP_TOLERANCE;
    return intervalOverlaps(Number(timestamp), { start, end }) ||
        Math.abs(Number(timestamp) - start) <= boundedTolerance;
}

function findDialogueInterval(timestamp, intervals, tolerance = DEFAULT_DIALOGUE_TIMESTAMP_TOLERANCE) {
    if (!Array.isArray(intervals)) return null;
    return intervals
        .filter(interval => dialogueTimestampMatches(timestamp, interval, tolerance))
        .sort((left, right) => {
            const leftInside = intervalOverlaps(Number(timestamp), {
                start: Number(left.start),
                end: Number(left.end)
            });
            const rightInside = intervalOverlaps(Number(timestamp), {
                start: Number(right.start),
                end: Number(right.end)
            });
            if (leftInside !== rightInside) return leftInside ? -1 : 1;
            return Math.abs(Number(left.start) - Number(timestamp)) -
                Math.abs(Number(right.start) - Number(timestamp));
        })[0] || null;
}

function contextDialogueIntervals(context) {
    const intervals = firstDefined(
        context.dialogueTrack,
        context.dialogues,
        context.dialogueIntervals,
        context.speechIntervals
    );
    if (!Array.isArray(intervals)) return [];
    return intervals.map(normalizeDialogueInterval).filter(Boolean);
}

function isOwnForeignInterval(event, interval) {
    const own = event.provenance && event.provenance.dialogueInterval;
    if (!own) return false;
    if (own.id && interval.id && own.id === interval.id) return true;
    return own.start === interval.start && own.end === interval.end;
}

function hasVisibleTextEvidence(provenance) {
    if (boundedString(provenance.visibleTextEvidence, 240)) return true;
    return frameEvidenceFrom(provenance).some(frame => {
        if (!frame || typeof frame !== 'object') return false;
        const visibleText = firstDefined(frame.visibleText, frame.ocrText, frame.textEvidence);
        return typeof visibleText === 'string' && normalizeText(visibleText).length > 0;
    });
}

function makeBaseEvent(candidate, context, fallbackReasons = []) {
    const provenance = normalizeProvenance(effectiveProvenance(candidate, context));
    const event = {
        id: '',
        timestamp: candidate && candidate.timestamp,
        text: normalizeText(candidate && candidate.text),
        tag: candidate && candidate.tag,
        legacyVerbosity: LEGACY_VERBOSITY[candidate && candidate.tag],
        provenance: provenance || null,
        policyVersion: POLICY_VERSION,
        validationStatus: 'rejected',
        validationReasons: [...fallbackReasons],
        ttsEligible: false
    };
    const audioLanguage = getAudioLanguage(candidate || {}, context);
    if (audioLanguage) event.audioLanguage = audioLanguage;
    event.id = candidate && candidate.id ? candidate.id : createCanonicalEventId(event);
    return event;
}

function validateCandidate(candidate, context = {}) {
    const input = candidate && typeof candidate === 'object' ? candidate : {};
    const reasons = [];
    const event = makeBaseEvent(input, context);
    const timestamp = input.timestamp;
    const duration = firstDefined(context.duration, context.totalDuration, input.duration);
    const provenance = event.provenance;
    const language = event.audioLanguage;

    if (!CANONICAL_TAGS.includes(input.tag)) addReason(reasons, 'UNSUPPORTED_TAG');
    if (!finiteNumber(timestamp) || !Number.isInteger(timestamp)) addReason(reasons, 'INVALID_TIMESTAMP');
    if (!finiteNumber(Number(duration))) addReason(reasons, 'MISSING_DURATION');
    else if (timestamp <= 0 || timestamp > Number(duration)) addReason(reasons, 'TIMESTAMP_OUT_OF_RANGE');
    if (!event.text) addReason(reasons, 'EMPTY_TEXT');
    if (Array.from(event.text).length > maxTextLength(context)) addReason(reasons, 'TEXT_TOO_LONG');
    if (!provenance) addReason(reasons, 'MISSING_PROVENANCE');
    else if (!PROVENANCE_KINDS.has(provenance.kind)) addReason(reasons, 'UNSUPPORTED_PROVENANCE');

    if (provenance && provenance.kind === 'visual' && frameEvidenceFrom(provenance).length === 0) {
        addReason(reasons, 'MISSING_FRAME_EVIDENCE');
    }
    if (provenance && provenance.kind === 'screen_text') {
        if (frameEvidenceFrom(provenance).length === 0) addReason(reasons, 'MISSING_FRAME_EVIDENCE');
        if (!hasVisibleTextEvidence(provenance)) addReason(reasons, 'MISSING_VISIBLE_TEXT_EVIDENCE');
    }

    const sourceInterval = provenance && provenance.kind === 'foreign_dialogue'
        ? normalizeDialogueInterval(provenance.dialogueInterval)
        : null;
    if (provenance && provenance.kind === 'foreign_dialogue') {
        if (!sourceInterval) addReason(reasons, 'MISSING_DIALOGUE_INTERVAL');
        else {
            if (!sourceInterval.confirmed) addReason(reasons, 'UNCONFIRMED_DIALOGUE');
            if (sourceInterval.needed === false) addReason(reasons, 'TRANSLATION_NOT_NEEDED');
            // Model timestamps are integer seconds while VTT cue starts are
            // often fractional. The translation may start anywhere inside
            // the confirmed cue; requiring exact equality would discard
            // otherwise valid foreign translations.
            if (!dialogueTimestampMatches(timestamp, sourceInterval, context.dialogueTimestampTolerance)) {
                addReason(reasons, 'DIALOGUE_TIMESTAMP_MISMATCH');
            }
        }
    }

    if (input.tag === 'txt' && (!provenance || provenance.kind !== 'screen_text')) {
        addReason(reasons, 'TXT_REQUIRES_SCREEN_TEXT');
    }
    if (input.tag === 'trans' && (!provenance || provenance.kind !== 'foreign_dialogue')) {
        addReason(reasons, 'TRANS_REQUIRES_FOREIGN_DIALOGUE');
    }
    if (input.tag === 'trans') {
        if (!AUDIO_LANGUAGES.has(language)) addReason(reasons, 'INVALID_AUDIO_LANGUAGE');
        else if (language === 'korean') addReason(reasons, 'TRANSLATION_NOT_ALLOWED_KOREAN');
        else if (language === 'unknown') addReason(reasons, 'TRANSLATION_NOT_ALLOWED_UNKNOWN');
        else if (language === 'mixed' && sourceInterval && !isConfirmedForeignInterval(sourceInterval)) {
            addReason(reasons, 'UNCERTAIN_MIXED_INTERVAL');
        }
        if (sourceInterval && !sourceInterval.confirmed && language === 'foreign') {
            addReason(reasons, 'UNCONFIRMED_FOREIGN_INTERVAL');
        }
    }
    if (provenance && provenance.kind === 'foreign_dialogue' && language === 'korean') {
        addReason(reasons, 'DIALOGUE_LANGUAGE_CONFLICT');
    }
    if (provenance && provenance.kind === 'foreign_dialogue' && language === 'unknown') {
        addReason(reasons, 'DIALOGUE_LANGUAGE_UNKNOWN');
    }
    if (input.transcriptEquivalent === true || input.duplicateOfDialogue === true) {
        if (input.tag === 'txt' || input.tag === 'trans') addReason(reasons, 'DIALOGUE_DUPLICATE');
    }

    const dialogues = contextDialogueIntervals(context);
    if ((input.tag === 'txt' || input.tag === 'trans') && dialogues.some(interval => (
        interval.sourceText &&
        normalizeText(interval.sourceText) === event.text &&
        intervalOverlaps(timestamp, interval)
    )) && !(input.tag === 'trans' && provenance && provenance.kind === 'foreign_dialogue' &&
        sourceInterval && isOwnForeignInterval(event, sourceInterval))) {
        addReason(reasons, 'DIALOGUE_DUPLICATE');
    }
    const guardBand = finiteNumber(Number(context.dialogueGuardBand))
        ? Math.max(0, Number(context.dialogueGuardBand))
        : 0;
    if (reasons.length === 0 && (input.tag === 'v1' || input.tag === 'v2' || input.tag === 'v3')) {
        if (dialogues.some(interval => intervalOverlaps(timestamp, interval, guardBand))) {
            addReason(reasons, 'DIALOGUE_OVERLAP');
        }
    }

    event.validationReasons = reasons;
    event.id = createCanonicalEventId(event);
    if (reasons.length === 0) {
        event.validationStatus = 'accepted';
        event.ttsEligible = true;
    } else {
        const quarantineReasons = new Set([
            'DIALOGUE_OVERLAP',
            'DIALOGUE_DUPLICATE',
            'UNCERTAIN_MIXED_INTERVAL',
            'UNCONFIRMED_FOREIGN_INTERVAL',
            'UNCONFIRMED_DIALOGUE',
            'TRANSLATION_NOT_NEEDED',
        ]);
        event.validationStatus = reasons.some(reason => quarantineReasons.has(reason))
            ? 'quarantined'
            : 'rejected';
        event.ttsEligible = false;
    }
    return event;
}

function isConfirmedForeignInterval(interval) {
    if (!interval || !interval.confirmed) return false;
    if (interval.foreign === true) return true;
    const language = interval.sourceLanguage;
    return typeof language === 'string' &&
        !['ko', 'korean', 'unknown', 'undetermined'].includes(language);
}

function validateEvents(candidates, context = {}) {
    const inputs = Array.isArray(candidates) ? candidates : [];
    const events = inputs.map(candidate => validateCandidate(candidate, context));
    const duplicateWindow = finiteNumber(Number(context.duplicateWindow))
        ? Math.max(0, Number(context.duplicateWindow))
        : DEFAULT_DUPLICATE_WINDOW;

    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event.validationStatus !== 'accepted') continue;
        const duplicate = events.slice(0, index).find(previous => (
            previous.validationStatus === 'accepted' &&
            normalizeText(previous.text) === normalizeText(event.text) &&
            Math.abs(previous.timestamp - event.timestamp) <= duplicateWindow
        ));
        if (duplicate) {
            event.validationStatus = 'quarantined';
            event.validationReasons = [...event.validationReasons, 'DUPLICATE_EVENT'];
            event.ttsEligible = false;
        }
    }

    const accepted = events.filter(event => event.validationStatus === 'accepted');
    const quarantined = events.filter(event => event.validationStatus === 'quarantined');
    const rejected = events.filter(event => event.validationStatus === 'rejected');
    const reasons = events.flatMap(event => event.validationReasons.map(code => ({ id: event.id, code })));
    return { events, accepted, quarantined, rejected, reasons };
}

function parseLegacyLine(line, context = {}) {
    const raw = typeof line === 'string' ? line : '';
    const match = raw.match(/^\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s+([\s\S]*?)\s*$/);
    if (!match) {
        return makeBaseEvent({
            timestamp: null,
            text: '',
            tag: null,
            provenance: context.provenance
        }, context, ['MALFORMED_LINE']);
    }

    const timestampToken = match[1].trim();
    const timestamp = /^\d+$/.test(timestampToken) ? Number(timestampToken) : Number.NaN;
    return validateCandidate({
        timestamp,
        text: match[3],
        tag: match[2].trim(),
        provenance: context.provenance,
        audioLanguage: context.audioLanguage || context.audioClassification,
        transcriptEquivalent: context.transcriptEquivalent,
        duplicateOfDialogue: context.duplicateOfDialogue
    }, context);
}

function toLegacyScriptEvent(event) {
    const safeEvent = event && typeof event === 'object' ? event : {};
    const tag = CANONICAL_TAGS.includes(safeEvent.tag) ? safeEvent.tag : undefined;
    return {
        id: safeEvent.id,
        timestamp: Number(safeEvent.timestamp),
        text: safeEvent.text,
        tag,
        verbosity: LEGACY_VERBOSITY[tag] || safeEvent.legacyVerbosity,
        validationStatus: safeEvent.validationStatus,
        validationReasons: Array.isArray(safeEvent.validationReasons)
            ? [...safeEvent.validationReasons]
            : [],
        ttsEligible: safeEvent.ttsEligible === true,
        policyVersion: safeEvent.policyVersion || POLICY_VERSION,
        provenance: safeEvent.provenance || null
    };
}

module.exports = {
    POLICY_VERSION,
    CANONICAL_TAGS,
    parseLegacyLine,
    validateCandidate,
    validateEvents,
    toLegacyScriptEvent,
    normalizeText,
    createCanonicalEventId,
    dialogueTimestampMatches,
    findDialogueInterval
};
