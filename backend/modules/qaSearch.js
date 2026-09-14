'use strict';
// Provider metadata is for source display and accounting only. It never selects
// a route, rewrites an answer, or decides whether a sentence reaches speech.
function searchMetadata(response) {
    const metadata = response?.candidates?.[0]?.groundingMetadata;
    const sources = new Map();
    for (const chunk of Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : []) {
        const web = chunk?.web;
        if (!web) continue;
        try {
            const url = new URL(web.uri);
            if (url.protocol !== 'https:' || url.username || url.password) continue;
            sources.set(url.href, { url: url.href, title: String(web.title || url.hostname).slice(0, 200) });
        } catch { /* Invalid link formatting must not suppress answer text. */ }
    }
    const html = metadata?.searchEntryPoint?.renderedContent;
    const queries = new Set((Array.isArray(metadata?.webSearchQueries) ? metadata.webSearchQueries : []).filter(query => typeof query === 'string' && query.trim()).map(query => query.trim()));
    return { sources: [...sources.values()].slice(0, 20), queryCount: queries.size,
        suggestions: typeof html === 'string' && Buffer.byteLength(html) <= 16000 ? html : null };
}
function createQaModel(client, modelName) {
    // Google Search is available for every request. The model decides whether
    // to call it, using the full question and conversation context.
    return client.getGenerativeModel({ model: modelName, tools: [{ googleSearch: {} }], generationConfig: { maxOutputTokens: 4096 } });
}
module.exports = { searchMetadata, createQaModel };
