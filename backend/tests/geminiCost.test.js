const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    GOOGLE_SEARCH_COST_PER_QUERY_USD,
    calculateGeminiCost,
    extractGoogleSearchQueryCount
} = require('../modules/geminiCost');

const assertClose = (actual, expected) => {
    assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not close to ${expected}`);
};

test('Gemini 3.8 Flash charges input, cache, tool, output, and thinking tokens at 2026 rates', () => {
    const cost = calculateGeminiCost({
        modelName: 'gemini-3.8-flash',
        occurredAt: new Date('2026-09-10T00:00:00.000Z'),
        billableSearchQueries: 2,
        usageMetadata: {
            promptTokenCount: 1_000_000,
            cachedContentTokenCount: 200_000,
            toolUsePromptTokenCount: 100_000,
            candidatesTokenCount: 200_000,
            thoughtsTokenCount: 100_000
        }
    });

    assertClose(cost.inputCost, 0.6);
    assertClose(cost.cachedCost, 0.015);
    assertClose(cost.toolCost, 0.075);
    assertClose(cost.outputCost, 1.125);
    assertClose(cost.searchCost, 2 * GOOGLE_SEARCH_COST_PER_QUERY_USD);
    assertClose(cost.totalCost, 1.815 + 2 * GOOGLE_SEARCH_COST_PER_QUERY_USD);
});

test('Gemini 3.8 Flash switches to the documented 2027 standard rates', () => {
    const cost = calculateGeminiCost({
        modelName: 'gemini-3.8-flash',
        occurredAt: new Date('2027-01-01T00:00:00.000Z'),
        usageMetadata: {
            promptTokenCount: 1_000_000,
            candidatesTokenCount: 1_000_000
        }
    });

    assert.equal(cost.version, 'gemini-3.8-flash-standard-2027');
    assert.equal(cost.totalCost, 9);
});

test('Google Search query count comes from provider grounding metadata', () => {
    assert.equal(extractGoogleSearchQueryCount({
        candidates: [
            { groundingMetadata: { webSearchQueries: ['first', 'second'] } },
            { groundingMetadata: { webSearchQueries: ['third'] } }
        ]
    }), 3);
});

test('Q&A cost ledger atomically applies the shared monthly Search allowance', () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-describer-cost-test-'));
    process.env.YOUTUBE_DESCRIBER_DB_PATH = path.join(dbDir, 'costs.db');
    const database = require('../database');
    database.init();
    database.db.prepare(`
        INSERT INTO users (id, email, password, name, phone, birthdate)
        VALUES ('user-1', 'cost-test@example.test', 'test', 'cost test', '01000000000', '2000-01-01')
    `).run();
    database.db.prepare(
        "INSERT INTO videos (videoId, title, duration, status) VALUES ('video-1', 'cost test', 1, 'completed')"
    ).run();

    const usageMetadata = { promptTokenCount: 1_000_000, candidatesTokenCount: 0 };
    database.recordGeminiUsage({
        videoId: 'video-1',
        userId: 'user-1',
        requestType: 'qa',
        modelName: 'gemini-3.8-flash',
        usageMetadata,
        searchQueries: 5000,
        occurredAt: new Date('2026-09-10T00:00:00.000Z')
    });
    const second = database.recordGeminiUsage({
        videoId: 'video-1',
        userId: 'user-1',
        requestType: 'qa',
        modelName: 'gemini-3.8-flash',
        usageMetadata,
        searchQueries: 2,
        occurredAt: new Date('2026-09-10T00:00:00.000Z')
    });

    assert.equal(second.billableSearchQueries, 2);
    assert.equal(second.searchCost, 2 * GOOGLE_SEARCH_COST_PER_QUERY_USD);
    const ledger = database.db.prepare(
        'SELECT request_type, model_used, search_queries, search_cost, thinking_tokens FROM api_costs ORDER BY id DESC LIMIT 1'
    ).get();
    assert.deepEqual(ledger, {
        request_type: 'qa',
        model_used: 'gemini-3.8-flash',
        search_queries: 2,
        search_cost: 2 * GOOGLE_SEARCH_COST_PER_QUERY_USD,
        thinking_tokens: 0
    });
    const daily = database.db.prepare(
        'SELECT queryCount, searchQueries, searchCost FROM qa_user_daily_costs'
    ).get();
    assert.deepEqual(daily, {
        queryCount: 2,
        searchQueries: 5002,
        searchCost: 2 * GOOGLE_SEARCH_COST_PER_QUERY_USD
    });
    assertClose(database.getAggregatedCosts().totalApiCosts, 1.5 + 2 * GOOGLE_SEARCH_COST_PER_QUERY_USD);

    database.db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
});
