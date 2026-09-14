'use strict';
const fs = require('node:fs/promises');
const FRAME_RADIUS_MS = 4000;
// Full script/history are context, not instructions. Keep their original fields,
// ordering and text; separate citable evidence from rejected/dialogue records.
async function createQaContext({ request, media, video = {} }) {
    const timestampMs = Math.floor(request.timestamp * 1000);
    const frameWindow = { startMs: Math.max(0, timestampMs - FRAME_RADIUS_MS),
        endMs: Math.min(Number.isFinite(video.duration) ? Math.ceil(video.duration * 1000) - 1 : Infinity, timestampMs + FRAME_RADIUS_MS) };
    const frames = media.frames.filter(frame => frame.timestampMs >= frameWindow.startMs && frame.timestampMs <= frameWindow.endMs);
    const cues = media.subtitles.cues.filter(cue => cue.end * 1000 <= frameWindow.endMs && cue.start * 1000 >= frameWindow.startMs);
    const evidence = new Map(), imageParts = [];
    const title = typeof video.title === 'string' ? video.title : '';
    const script = Array.isArray(video.script) ? video.script : [];
    if (title) evidence.set('video-title', { id: 'video-title', kind: 'title', text: title });
    const scriptEvidence = [];
    script.forEach((line, index) => {
        const tag = line.tag || ({ text: 'txt', translation: 'trans' }[line.verbosity] || line.verbosity);
        if (line.validationStatus === 'rejected' || !['v1', 'v2', 'v3', 'txt'].includes(tag)
            || typeof line.text !== 'string' || !line.text.trim() || !Number.isFinite(line.timestamp) || line.timestamp < 0) return;
        const item = { id: `script-${index}`, kind: 'script', timestampMs: Math.round(line.timestamp * 1000), text: line.text, tag };
        evidence.set(item.id, item); scriptEvidence.push({ id: item.id, index, timestamp: line.timestamp });
    });
    const pastFrames = frames.filter(frame => frame.timestampMs <= timestampMs);
    const questionFrame = pastFrames.reduce((latest, frame) => !latest || frame.timestampMs > latest.timestampMs ? frame : latest, null);
    const currentFrameId = questionFrame ? `frame-${frames.indexOf(questionFrame)}` : null;
    const frameEvidence = [];
    for (const [index, frame] of frames.entries()) {
        const id = `frame-${index}`;
        frameEvidence.push({ id, timestamp: frame.timestampMs / 1000, sourcePtsMs: frame.sourcePtsMs, isQuestionFrame: id === currentFrameId });
        evidence.set(id, { ...frame, id, kind: 'frame' });
        imageParts.push({ text: JSON.stringify({ frameId: id, isQuestionFrame: id === currentFrameId, timestamp: frame.timestampMs / 1000, relationToQuestion: frame.timestampMs > timestampMs ? 'after' : 'at_or_before' }) },
            { inlineData: { mimeType: 'image/jpeg', data: (await fs.readFile(frame.path)).toString('base64') } });
    }
    for (const cue of cues) evidence.set(cue.id, { ...cue, kind: 'cue' });
    return { timestampMs, frameWindow, evidence, cues, imageParts, audioClassification: media.subtitles.audioClassification || 'unknown',
        title, script, currentFrameId, frameEvidence, history: request.history, question: request.question,
        promptData: JSON.stringify({ videoTitle: title, screenDescriptionScript: script, scriptEvidence, frameEvidence, currentFrameId, allowedEvidenceIds: [...evidence.keys()],
            timestamp: request.timestamp, frameWindow, question: request.question, history: request.history, subtitleEvidence: cues }) };
}
module.exports = { createQaContext, FRAME_RADIUS_MS };
