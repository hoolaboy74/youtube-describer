const GOOGLE_SEARCH_FREE_QUERIES_PER_MONTH = 5000;
const GOOGLE_SEARCH_COST_PER_QUERY_USD = 14 / 1000;

function nonNegativeInteger(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function billingMonth(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error('A valid cost-record timestamp is required.');
    }
    return date.toISOString().slice(0, 7);
}

function pricingFor(modelName, occurredAt = new Date()) {
    const normalized = String(modelName || '').toLowerCase();
    const date = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
    if (normalized.includes('gemini-3.8-flash')) {
        const introductoryPricingEnds = new Date('2027-01-01T00:00:00.000Z');
        const introductory = date < introductoryPricingEnds;
        return {
            model: 'gemini-3.8-flash',
            version: introductory ? 'gemini-3.8-flash-standard-2026' : 'gemini-3.8-flash-standard-2027',
            inputPerMillion: introductory ? 0.75 : 1.50,
            outputPerMillion: introductory ? 3.75 : 7.50,
            cachedInputPerMillion: introductory ? 0.075 : 0.15,
            toolInputPerMillion: introductory ? 0.75 : 1.50
        };
    }

    // Gemini 3.5 Flash-Lite standard pricing: $0.30/M input, $2.50/M output
    // (including thinking), and $0.03/M cached input. Tool prompt tokens are
    // input tokens and use the same input rate.
    if (normalized.includes('gemini-3.5-flash-lite')) {
        return {
            model: 'gemini-3.5-flash-lite',
            version: 'gemini-3.5-flash-lite-standard',
            inputPerMillion: 0.30,
            outputPerMillion: 2.50,
            cachedInputPerMillion: 0.03,
            toolInputPerMillion: 0.30
        };
    }

    throw new Error(`No verified Gemini pricing is configured for model: ${modelName}`);
}

function calculateGeminiCost({
    modelName,
    usageMetadata,
    billableSearchQueries = 0,
    occurredAt = new Date()
}) {
    const usage = usageMetadata || {};
    const pricing = pricingFor(modelName, occurredAt);
    const promptTokens = nonNegativeInteger(usage.promptTokenCount);
    const cachedTokens = Math.min(promptTokens, nonNegativeInteger(usage.cachedContentTokenCount));
    const toolTokens = nonNegativeInteger(usage.toolUsePromptTokenCount);
    const completionTokens = nonNegativeInteger(usage.candidatesTokenCount);
    const thinkingTokens = nonNegativeInteger(usage.thoughtsTokenCount);
    const inputTokens = promptTokens - cachedTokens;
    const outputTokens = completionTokens + thinkingTokens;
    const searchQueries = nonNegativeInteger(billableSearchQueries);

    const inputCost = inputTokens / 1_000_000 * pricing.inputPerMillion;
    const cachedCost = cachedTokens / 1_000_000 * pricing.cachedInputPerMillion;
    const toolCost = toolTokens / 1_000_000 * pricing.toolInputPerMillion;
    const outputCost = outputTokens / 1_000_000 * pricing.outputPerMillion;
    const searchCost = searchQueries * GOOGLE_SEARCH_COST_PER_QUERY_USD;

    return {
        ...pricing,
        promptTokens,
        inputTokens,
        cachedTokens,
        toolTokens,
        completionTokens,
        thinkingTokens,
        outputTokens,
        searchQueries,
        inputCost,
        cachedCost,
        toolCost,
        outputCost,
        searchCost,
        totalCost: inputCost + cachedCost + toolCost + outputCost + searchCost
    };
}

function extractGoogleSearchQueryCount(response) {
    const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
    return candidates.reduce((count, candidate) => {
        const queries = candidate?.groundingMetadata?.webSearchQueries;
        return count + (Array.isArray(queries) ? queries.length : 0);
    }, 0);
}

module.exports = {
    GOOGLE_SEARCH_FREE_QUERIES_PER_MONTH,
    GOOGLE_SEARCH_COST_PER_QUERY_USD,
    billingMonth,
    calculateGeminiCost,
    extractGoogleSearchQueryCount,
    pricingFor
};
