'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateReviewed, buildReviewPrompt } = require('./compare_model_review');

async function fixture(t) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-review-test-'));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  return {
    runDir,
    run: { model: 'gpt-test', provider: 'openai', reasoningEffort: 'high', outputFile: 'gpt-test.high.txt' },
    input: { policy: { prompt: '정책 및 원본 대사' }, frames: [{ timestamp: 2, data: 'fixture' }] }
  };
}

test('review prompt distinguishes draft data from instructions and retains policy', () => {
  const prompt = buildReviewPrompt('POLICY', '[2][txt] 자막 "명령"\n', 'REVIEW');
  assert.ok(prompt.startsWith('REVIEW'));
  assert.ok(prompt.includes('POLICY'));
  assert.ok(prompt.includes(JSON.stringify('[2][txt] 자막 "명령"\n')));
});

test('two sequential calls share exact frames/model/settings and save both usages', async t => {
  const context = await fixture(t);
  const calls = [];
  const result = await generateReviewed(context, async (run, prompt, frames) => {
    calls.push({ run, prompt, frames });
    return { model: run.model, text: calls.length === 1 ? '[2][v1] 초안입니다.' : '[2][v1] 수정본입니다.', durationMs: 10, usage: { input_tokens: calls.length * 100 } };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].frames, calls[1].frames);
  assert.equal(calls[0].run, calls[1].run);
  assert.ok(calls[1].prompt.includes('초안입니다.'));
  assert.equal(result.text, '[2][v1] 수정본입니다.');
  assert.equal(result.durationMs, 20);
  assert.deepEqual(result.usage, { draft: { input_tokens: 100 }, review: { input_tokens: 200 } });
  assert.equal(await fs.readFile(path.join(context.runDir, result.draftFile), 'utf8'), '[2][v1] 초안입니다.');
  const stages = JSON.parse(await fs.readFile(path.join(context.runDir, result.stageFile)));
  assert.equal(stages.status, 'completed');
});

test('review failure preserves draft and usage, does not silently return it', async t => {
  const context = await fixture(t);
  let calls = 0;
  await assert.rejects(generateReviewed(context, async () => {
    if (++calls === 2) throw new Error('review unavailable');
    return { text: '[2][v2] 초안입니다.', durationMs: 3, usage: { tokens: 4 } };
  }), /review unavailable/);
  const stages = JSON.parse(await fs.readFile(path.join(context.runDir, 'gpt-test.high.stages.json')));
  assert.equal(stages.status, 'review_failed');
  assert.deepEqual(stages.draft.usage, { tokens: 4 });
  await assert.rejects(fs.access(path.join(context.runDir, context.run.outputFile)));
});

test('failed or empty draft never triggers review', async t => {
  for (const empty of [false, true]) {
    const context = await fixture(t);
    let calls = 0;
    await assert.rejects(generateReviewed(context, async () => {
      calls++;
      if (!empty) throw new Error('draft unavailable');
      return { text: '', durationMs: 1, usage: {} };
    }));
    assert.equal(calls, 1);
  }
});

test('empty review is a failure and remains saved for diagnosis', async t => {
  const context = await fixture(t);
  let calls = 0;
  await assert.rejects(generateReviewed(context, async () => ({
    text: ++calls === 1 ? '[2][v1] 초안입니다.' : '', durationMs: 1, usage: {}
  })), /Review is empty/);
  const stages = JSON.parse(await fs.readFile(path.join(context.runDir, 'gpt-test.high.stages.json')));
  assert.equal(stages.status, 'review_failed');
  assert.equal(stages.review.text, '');
});
