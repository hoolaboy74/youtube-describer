'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_POLICY_PROMPT_FILE,
  POLICY_VERSION,
  PolicyPromptError,
  assertV2PolicyPrompt,
  loadPolicyPrompt
} = require('./modules/promptPolicy');

test('default prompt resolution uses the v2 baseline and resolves all placeholders', async () => {
  const previous = process.env.PROMPT_FILE;
  delete process.env.PROMPT_FILE;
  try {
    const loaded = await loadPolicyPrompt();
    assert.equal(path.basename(loaded.promptFile), DEFAULT_POLICY_PROMPT_FILE);
    assert.equal(loaded.policyVersion, POLICY_VERSION);
    assert.equal(loaded.context.policyVersion, POLICY_VERSION);
    for (const tag of ['[v1]', '[v2]', '[v3]', '[txt]', '[trans]']) {
      assert.ok(loaded.prompt.includes(tag), `missing ${tag}`);
    }
    assert.equal(/{{[^{}]+}}/.test(loaded.prompt), false);
    assert.equal(loaded.prompt.includes('(제목 없음)'), true);
  } finally {
    if (previous === undefined) delete process.env.PROMPT_FILE;
    else process.env.PROMPT_FILE = previous;
  }
});

test('prompt replacements are global and policy context is returned', async () => {
  const loaded = await loadPolicyPrompt({
    replacements: {
      VIDEO_TITLE: 'A test title',
      AUDIO_CLASSIFICATION: 'foreign',
      AUDIO_LANGUAGE: 'en',
      DIALOGUE_TRACK: '[{"start": 1}]'
    }
  });
  assert.equal(loaded.prompt.includes('{{VIDEO_TITLE}}'), false);
  assert.equal(loaded.prompt.includes('A test title'), true);
  assert.equal(loaded.context.policyVersion, 'codex-v2');
});

test('legacy and unsupported prompt paths fail closed before generation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-describer-prompt-'));
  const legacyPath = path.join(directory, 'legacy.txt');
  const unsupportedPath = path.join(directory, 'unsupported.txt');
  try {
    fs.writeFileSync(legacyPath, '[desc] legacy prompt {{VIDEO_TITLE}}');
    await assert.rejects(
      loadPolicyPrompt({ promptFile: legacyPath }),
      error => error instanceof PolicyPromptError && error.code === 'MISSING_V2_POLICY_MARKER'
    );

    const baseline = fs.readFileSync(path.join(__dirname, DEFAULT_POLICY_PROMPT_FILE), 'utf8');
    fs.writeFileSync(unsupportedPath, `${baseline}\n[desc]`);
    await assert.rejects(
      loadPolicyPrompt({ promptFile: unsupportedPath }),
      error => error instanceof PolicyPromptError && error.code === 'UNSUPPORTED_TAG_MARKER'
    );

    await assert.rejects(
      loadPolicyPrompt({ promptFile: path.join(directory, 'missing.txt') }),
      error => error instanceof PolicyPromptError && error.code === 'POLICY_PROMPT_NOT_FOUND'
    );
    assert.throws(() => assertV2PolicyPrompt('[desc] only'), PolicyPromptError);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
