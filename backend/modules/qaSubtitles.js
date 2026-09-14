'use strict';
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
function parseVtt(text, metadata = {}) {
    const cues = [];
    if (!/^\uFEFF?WEBVTT(?:[ \t].*)?\r?\n/.test(text)) throw new Error('Invalid WebVTT');
    const seconds = token => {
        if (!/^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}$/.test(token)) return NaN;
        return token.split(':').reduce((total, n) => total * 60 + Number(n), 0);
    };
    for (const block of text.split(/\r?\n\s*\r?\n/)) {
        if (/^(NOTE|STYLE|REGION)\b/.test(block.trim())) continue;
        const lines = block.split(/\r?\n/);
        const i = lines.findIndex(line => line.includes('-->'));
        if (i < 0) continue;
        const [left,right] = lines[i].split('-->').map(s => s.trim());
        const start = seconds(left), end = seconds((right || '').split(/\s+/)[0]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Invalid VTT timing');
        const sourceText = lines.slice(i+1).join(' ').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').trim();
        if (!sourceText) continue;
        cues.push({ id: `cue-${cues.length}`, start, end, sourceText, sourceLanguage: metadata.originalLanguage || 'unknown',
            confirmed: metadata.provenance === 'verified' && metadata.sourceType !== 'translated' && !!metadata.originalLanguage,
            audioClassification: metadata.audioClassification || 'unknown' });
    }
    return cues;
}
function createSubtitleReader(manager) {
    const cache = new Map();
    return async (videoId, version = 'subtitles-v1') => {
        const asset = manager.store.subtitle(videoId, version);
        if (!asset || asset.state !== 'ready') return { state: asset?.state || 'unknown', cues: [], audioClassification: 'unknown' };
        const text = await fs.readFile(manager.assetPath(asset.relativePath),'utf8');
        if (crypto.createHash('sha256').update(text).digest('hex') !== asset.checksum) throw new Error('Subtitle checksum mismatch');
        const key = asset.checksum + ':' + JSON.stringify([asset.originalLanguage,asset.provenance,asset.sourceType,asset.audioClassification]);
        if (!cache.has(key)) {
            cache.set(key, parseVtt(text, asset));
            if (cache.size > 100) cache.delete(cache.keys().next().value);
        }
        return { ...asset, cues: cache.get(key) };
    };
}
module.exports = { parseVtt, createSubtitleReader };
