'use strict';

const {
  CANONICAL_TAGS,
  POLICY_VERSION,
  validateEvents
} = require('./canonicalOutput');

function audioClassificationFor(language) {
  const normalized = String(language || '').toLowerCase();
  if (['ko', 'kor', 'korean'].includes(normalized)) return 'korean';
  if (['mixed'].includes(normalized)) return 'mixed';
  if (['unknown', 'und', 'undetermined'].includes(normalized)) return 'unknown';
  return 'foreign';
}

function nearestFrameEvidence(timestamp, frames = []) {
  return frames
    .filter(frame => frame && Number.isFinite(Number(frame.timestamp)))
    .map(frame => ({
      id: frame.id || frame.frameId || frame.path,
      timestamp: Number(frame.timestamp)
    }))
    .sort((left, right) => Math.abs(left.timestamp - timestamp) - Math.abs(right.timestamp - timestamp))
    .slice(0, 8);
}

function dialogueIntervalAt(timestamp, dialogueTrack = []) {
  return dialogueTrack.find(interval => Number(interval.start) === timestamp) || null;
}

function tagForItem(item, context) {
  const directTag = item && (item.tag || item.type);
  if (CANONICAL_TAGS.includes(directTag)) return directTag;

  // Compatibility for the old synchronizer's `type: text` output is only
  // allowed when it lines up with a confirmed foreign dialogue interval.
  if (directTag === 'text') {
    const timestamp = Number(item.timestamp);
    const interval = dialogueIntervalAt(timestamp, context.dialogueTrack);
    if (interval && ['foreign', 'mixed'].includes(context.audioClassification)) return 'trans';
  }
  return directTag;
}

function provenanceForItem(item, tag, context) {
  const timestamp = Number(item.timestamp);
  const frameEvidence = nearestFrameEvidence(timestamp, context.frames);

  if (tag === 'v1' || tag === 'v2' || tag === 'v3') {
    return { kind: 'visual', frameEvidence };
  }
  if (tag === 'txt') {
    const visibleText = typeof item.visibleTextEvidence === 'string'
      ? item.visibleTextEvidence
      : undefined;
    return {
      kind: 'screen_text',
      frameEvidence,
      ...(visibleText ? { visibleTextEvidence: visibleText } : {})
    };
  }
  if (tag === 'trans') {
    const interval = dialogueIntervalAt(timestamp, context.dialogueTrack);
    return interval ? { kind: 'foreign_dialogue', dialogueInterval: interval } : null;
  }
  return null;
}

function canonicalizeCliOutput(items, context = {}) {
  const normalizedContext = {
    ...context,
    audioClassification: context.audioClassification || audioClassificationFor(context.audioLanguage),
    audioLanguage: context.audioLanguage || context.audioClassification || 'unknown',
    duration: Number(context.duration),
    frames: Array.isArray(context.frames) ? context.frames : [],
    dialogueTrack: Array.isArray(context.dialogueTrack) ? context.dialogueTrack : []
  };
  const candidates = (Array.isArray(items) ? items : []).map(item => {
    const tag = tagForItem(item, normalizedContext);
    const timestamp = Number(item && item.timestamp);
    const text = item && item.text;
    return {
      timestamp,
      text,
      tag,
      provenance: provenanceForItem(item || {}, tag, normalizedContext),
      audioLanguage: normalizedContext.audioClassification,
      rawLine: `[${item && item.timestamp}][${tag}] ${text || ''}`
    };
  });
  const validation = validateEvents(candidates, normalizedContext);
  return {
    ...validation,
    accepted: validation.accepted.slice().sort((left, right) => left.timestamp - right.timestamp),
    policyVersion: POLICY_VERSION
  };
}

module.exports = {
  audioClassificationFor,
  canonicalizeCliOutput,
  nearestFrameEvidence,
  provenanceForItem
};
