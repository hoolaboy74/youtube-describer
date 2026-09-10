const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

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

test('Q&A streaming ticket is short-lived and can only be issued by the answer owner', () => {
    let timestamp = 1_000;
    const store = createQaTtsStore({ now: () => timestamp, ttlMs: 500, streamTicketTtlMs: 100 });
    const id = store.issue({ userId: 'user-a', text: '화면 왼쪽에 창문이 보입니다.' });

    assert.equal(store.issueStreamTicket({ id, userId: 'user-b' }), null);
    const ticket = store.issueStreamTicket({ id, userId: 'user-a' });
    assert.ok(ticket);
    assert.deepEqual(store.getByStreamTicket({ ticket }), { text: '화면 왼쪽에 창문이 보입니다.' });

    timestamp += 101;
    assert.equal(store.getByStreamTicket({ ticket }), null);
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

test('Q&A streaming TTS handler forwards Chirp OGG/Opus chunks', async () => {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
    const routes = require('../routes');
    const store = createQaTtsStore();
    const id = store.issue({ userId: 'user-a', text: '화면 중앙에 제목이 보입니다.' });
    const ticket = store.issueStreamTicket({ id, userId: 'user-a' });
    let requestConfig;
    let requestInput;
    const fakeClient = {
        streamingSynthesize() {
            const stream = new EventEmitter();
            stream.write = (request) => {
                if (request.streamingConfig) requestConfig = request.streamingConfig;
                if (request.input) requestInput = request.input;
            };
            stream.end = () => queueMicrotask(() => {
                stream.emit('data', { audioContent: Buffer.from('fake-ogg') });
                stream.emit('end');
            });
            return stream;
        }
    };
    const handler = routes.createQaTtsStreamHandler({ store, client: fakeClient });
    const response = new EventEmitter();
    response.statusCode = 200;
    response.writableEnded = false;
    response.status = function status(code) { this.statusCode = code; return this; };
    response.set = function set(headers) { this.headers = headers; return this; };
    response.flushHeaders = () => {};
    response.write = function write(chunk) { this.body = Buffer.concat([this.body || Buffer.alloc(0), Buffer.from(chunk)]); };
    response.end = function end() { this.writableEnded = true; this.emit('finish'); };

    const finished = new Promise(resolve => response.once('finish', resolve));
    handler({ params: { ticket } }, response);
    await finished;

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], 'audio/ogg; codecs=opus');
    assert.deepEqual(requestInput, { text: '화면 중앙에 제목이 보입니다.' });
    assert.equal(requestConfig.voice.name, 'ko-KR-Chirp3-HD-Sulafat');
    assert.equal(requestConfig.streamingAudioConfig.audioEncoding, 'OGG_OPUS');
    assert.equal(response.body.toString(), 'fake-ogg');
});
