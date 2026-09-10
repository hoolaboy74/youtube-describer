'use strict';

const crypto = require('crypto');
const { normalizeText } = require('./canonicalOutput');

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function createQaTtsStore({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    const answers = new Map();

    function removeExpired() {
        const timestamp = now();
        for (const [id, value] of answers) {
            if (value.expiresAt <= timestamp) answers.delete(id);
        }
    }

    function issue({ userId, text, dialogueTexts = [] }) {
        removeExpired();
        const safeText = normalizeText(text);
        if (!userId || !safeText || safeText.length > 1000) return null;

        // Do not synthesize a Q&A answer that is exactly confirmed dialogue
        // already audible in the surrounding Korean subtitle context.
        const normalizedDialogue = dialogueTexts.map(normalizeText).filter(Boolean);
        if (normalizedDialogue.includes(safeText)) return null;

        const id = crypto.randomUUID();
        answers.set(id, { userId, text: String(text).trim(), expiresAt: now() + ttlMs });
        return id;
    }

    function get({ id, userId }) {
        removeExpired();
        const answer = answers.get(id);
        if (!answer || answer.userId !== userId) return null;
        return { text: answer.text };
    }

    return { issue, get };
}

module.exports = { createQaTtsStore };
