'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRuns, waitForVideo, videoParts, timedVideoPrompt } = require('./compare_model_video');
test('video prompt supplies duration and cumulative seconds rather than MMSS', () => {
  const p = timedVideoPrompt('policy', 630);
  assert.ok(p.includes('630초'));
  assert.ok(p.includes('10:00=[600]'));
  assert.ok(p.includes('[704]가 아닙니다'));
});
test('video script rejects OpenAI before media work', () => {
  assert.throws(() => validateRuns([{ provider: 'openai' }]), /Gemini/);
  validateRuns([{ provider: 'gemini' }]);
});
test('video request contains file with audio and prompt, no JPEG parts', () => {
  assert.deepEqual(videoParts({ uri: 'https://example.test/file', mimeType: 'video/mp4' }, 'policy'), [
    { fileData: { fileUri: 'https://example.test/file', mimeType: 'video/mp4' }, videoMetadata: { fps: 1 } }, { text: 'policy' }
  ]);
});
test('processing is polled until ACTIVE', async () => {
  let calls = 0;
  const file = await waitForVideo({ getFile: async name => { calls++; return { name, state: 'ACTIVE' }; } }, { name: 'files/test', state: 'PROCESSING' }, { sleep: async () => {} });
  assert.equal(file.state, 'ACTIVE'); assert.equal(calls, 1);
});
test('failed and timed out uploads do not reach generation', async () => {
  await assert.rejects(waitForVideo({}, { state: 'FAILED' }), /not ACTIVE/);
  await assert.rejects(waitForVideo({}, { state: 'PROCESSING' }, { timeoutMs: 0 }), /timed out/);
});
