'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), Database = require('better-sqlite3');
const { createQaRequestReceipts } = require('../modules/qaRequestReceipts');
const { createQaRequestStore } = require('../modules/qaRequestStore');
const body = { requestId: 'request-123', sessionId: 'session-123', videoId: 'abcdefghijk', timestamp: 12, question: '질문입니다.', history: [], audioMode: 'mp3' };
test('restart refuses automatic regeneration and retains unconfirmed usage without storing conversation text', t => {
    const db = new Database(':memory:'); t.after(() => db.close()); const receipts = createQaRequestReceipts(db);
    const first = createQaRequestStore({ receipts }), { request } = first.accept(1, body); first.markModelStarted(request);
    const restarted = createQaRequestStore({ receipts: createQaRequestReceipts(db) });
    assert.throws(() => restarted.accept(1, body), { code: 'QA_REQUEST_INTERRUPTED', status: 410 });
    assert.equal(receipts.get(body.requestId).usageStatus, 'unconfirmed'); assert.ok(!JSON.stringify(receipts.get(body.requestId)).includes(body.question));
    first.finish(request, 'canceled'); assert.equal(receipts.get(body.requestId).status, 'canceled'); assert.equal(receipts.get(body.requestId).usageStatus, 'unconfirmed');
});
test('cost and receipt commit atomically once; failed ledger transaction is retryable without double charging', t => {
    const db = new Database(':memory:'); t.after(() => db.close()); db.exec('CREATE TABLE costs(id INTEGER PRIMARY KEY, amount INTEGER)');
    const receipts = createQaRequestReceipts(db), store = createQaRequestStore({ receipts }), { request } = store.accept(1, body);
    const usage = { totalTokenCount: 123 }; store.markModelStarted(request);
    assert.throws(() => receipts.record(request, usage, () => { db.prepare('INSERT INTO costs(amount) VALUES(5)').run(); throw new Error('rollback'); }));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM costs').get().n, 0); assert.equal(receipts.get(body.requestId).usageStatus, 'unconfirmed');
    let calls = 0; const persist = () => { calls++; return { id: db.prepare('INSERT INTO costs(amount) VALUES(5)').run().lastInsertRowid }; };
    receipts.record(request, usage, persist); receipts.record(request, usage, persist);
    assert.equal(calls, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM costs').get().n, 1); assert.deepEqual(JSON.parse(receipts.get(body.requestId).usageJson), usage);
});
