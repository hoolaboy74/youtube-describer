'use strict';
// Durable idempotency/accounting metadata only. Conversation text and media
// capabilities remain in memory; restarting never silently starts a paid job.
function createQaRequestReceipts(db, { now = Date.now } = {}) {
    db.exec(`CREATE TABLE IF NOT EXISTS qa_request_receipts (
        requestId TEXT PRIMARY KEY, userId TEXT NOT NULL, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', usageStatus TEXT NOT NULL DEFAULT 'not_started',
        usageJson TEXT, costId INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    )`);
    const get = requestId => db.prepare('SELECT * FROM qa_request_receipts WHERE requestId=?').get(requestId);
    return { get,
        save(request) {
            db.prepare('INSERT INTO qa_request_receipts(requestId,userId,fingerprint,createdAt,updatedAt) VALUES(?,?,?,?,?)')
                .run(request.input.requestId, String(request.userId), request.fingerprint, now(), now());
        },
        started(request) {
            db.prepare("UPDATE qa_request_receipts SET usageStatus='unconfirmed',updatedAt=? WHERE requestId=? AND usageStatus='not_started'")
                .run(now(), request.input.requestId);
        },
        finish(request) {
            db.prepare('UPDATE qa_request_receipts SET status=?,updatedAt=? WHERE requestId=?').run(request.status, now(), request.input.requestId);
        },
        record(request, usage, persistCost) {
            return db.transaction(() => {
                const receipt = get(request.input.requestId);
                if (!receipt || receipt.userId !== String(request.userId) || receipt.fingerprint !== request.fingerprint) throw new Error('QA_RECEIPT_MISMATCH');
                if (receipt.usageStatus === 'recorded') return { id: receipt.costId, duplicate: true };
                // Existing detailed and daily QA ledgers use this same SQLite
                // connection, so the receipt and both ledgers commit together.
                const cost = persistCost();
                db.prepare("UPDATE qa_request_receipts SET usageStatus='recorded',usageJson=?,costId=?,updatedAt=? WHERE requestId=?")
                    .run(JSON.stringify(usage), cost.id, now(), request.input.requestId);
                return cost;
            }).immediate();
        },
    };
}
module.exports = { createQaRequestReceipts };
