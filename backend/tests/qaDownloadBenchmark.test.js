const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFrameHashes, classifyError } = require('../../test_scripts/qa_download_benchmark');

test('download comparison maps decoded frames through their explicit timebase', () => {
    const frames = parseFrameHashes('#tb 0: 1001/30000\n0, 3477, 3477, 1, 6, abcdef\n');
    assert.ok(Math.abs(frames[0].ptsSeconds - 3477 * 1001 / 30000) < 1e-9);
    assert.equal(frames[0].hash, 'abcdef');
    assert.throws(() => parseFrameHashes('0,0,0,1,6,hash'), /timebase/);
});
test('download errors redact signed URLs, cookies and raw provider diagnostics', () => {
    assert.equal(classifyError({ stderr: 'HTTP Error 403 https://example.test/?secret=token' }), 'http-403');
    assert.equal(classifyError({ stderr: 'Sign in to confirm you are not a bot' }), 'authentication');
    assert.equal(classifyError({ code: 'MEDIA_TIMEOUT', stderr: 'private' }), 'MEDIA_TIMEOUT');
});
