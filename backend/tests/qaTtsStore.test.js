const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createQaTtsStore } = require('../modules/qaTtsStore');

test('Q&A TTS tokens are available only to their issuing user until expiry', () => {
    let timestamp = 1_000;
    const store = createQaTtsStore({ now: () => timestamp, ttlMs: 100 });
    const id = store.issue({ userId: 'user-a', text: '화면 오른쪽에 메뉴가 있습니다.' });

    assert.ok(id);
    assert.deepEqual(store.get({ id, userId: 'user-a' }), { text: '화면 오른쪽에 메뉴가 있습니다.' });
    assert.equal(store.get({ id, userId: 'user-b' }), null);

    timestamp += 101;
    assert.equal(store.get({ id, userId: 'user-a' }), null);
});

test('Q&A TTS rejects an answer that exactly repeats surrounding dialogue', () => {
    const store = createQaTtsStore();
    assert.equal(store.issue({
        userId: 'user-a',
        text: '안녕하세요.',
        dialogueTexts: ['안녕하세요.']
    }), null);
});

test('Q&A TTS handler accepts only a server-issued answer token for its user', async () => {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    const routes = require('../routes');
    const store = createQaTtsStore();
    const id = store.issue({ userId: 'user-a', text: '화면 중앙에 제목이 보입니다.' });
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-describer-qa-tts-'));
    const handler = routes.createQaTtsHandler({
        store,
        cacheRoot,
        client: {
            async synthesizeSpeech(request) {
                assert.equal(request.input.text, '화면 중앙에 제목이 보입니다.');
                return [{ audioContent: Buffer.from('fake-mp3') }];
            }
        }
    });
    const response = () => ({
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        set() { return this; },
        send(body) { this.body = body.toString(); return this; },
        sendFile(file) { this.file = file; return this; }
    });

    try {
        const allowed = response();
        await handler({ body: { qaTtsId: id }, user: { id: 'user-a' } }, allowed);
        assert.equal(allowed.statusCode, 200);
        assert.equal(allowed.body, 'fake-mp3');

        const denied = response();
        await handler({ body: { qaTtsId: id }, user: { id: 'user-b' } }, denied);
        assert.equal(denied.statusCode, 422);
    } finally {
        fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
});
