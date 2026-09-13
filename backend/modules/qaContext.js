'use strict';
const fs = require('node:fs/promises');

// Conversation is kept verbatim, including failed/partial turns and turns after
// a backward seek. It is untrusted conversational data, never video evidence.
async function createQaContext({ request, media }) {
    const timestampMs = Math.floor(request.timestamp * 1000);
    const frames = media.frames.filter(frame => frame.timestampMs <= timestampMs);
    const cues = media.subtitles.cues.filter(cue => cue.end * 1000 <= timestampMs);
    const evidence = new Map();
    const imageParts = [];
    for (const frame of frames) {
        const id = `frame-${frame.sourcePtsMs}`;
        evidence.set(id, { ...frame, id, kind: 'frame' });
        imageParts.push({ text: JSON.stringify({ frameId: id, timestamp: frame.timestampMs / 1000 }) },
            { inlineData: { mimeType: 'image/jpeg', data: (await fs.readFile(frame.path)).toString('base64') } });
    }
    for (const cue of cues) evidence.set(cue.id, { ...cue, kind: 'cue' });
    return { timestampMs, evidence, cues, imageParts, audioClassification: media.subtitles.audioClassification || 'unknown',
        // Never slice, summarize, normalize or rewrite history.
        history: request.history, question: request.question,
        promptData: JSON.stringify({ timestamp: request.timestamp, question: request.question, history: request.history,
            subtitleEvidence: cues }) };
}
module.exports = { createQaContext };
