'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const {
  parseArguments,
  resolveRequestedPromptFile,
  loadComparisonPrompt,
  providerForModel,
  parseModelSpecifier,
  modelRuns,
  countLines,
  isOpenAIComparisonModel,
  isGpt6Astra,
  openAIRequestSettings,
  responseJson,
  assertModelsAvailable,
  isValidAssetManifestShape,
  loadCachedAssets
} = require('./compare_model');

test('parses repeated -m options and one video ID', () => {
  assert.deepEqual(parseArguments([
    '-m', 'gemini-3.1-pro-preview',
    '-m', 'gpt-5.6-sol',
    '-v', 'xsasfDdds12'
  ]), {
    help: false,
    listAvailable: false,
    models: ['gemini-3.1-pro-preview', 'gpt-5.6-sol'],
    promptFile: null,
    videoId: 'xsasfDdds12'
  });
});

test('-a is standalone and does not require a video ID', () => {
  assert.deepEqual(parseArguments(['-a']), {
    help: false,
    listAvailable: true,
    models: [],
    promptFile: null,
    videoId: null
  });
  assert.throws(() => parseArguments(['-a', '-m', 'gpt-5.6-sol']), /cannot be combined/);
});

test('accepts -p and otherwise requires PROMPT_FILE without a fallback', () => {
  assert.equal(parseArguments(['-m', 'gpt-5.6-sol', '-v', 'xsasfDdds12', '-p', 'prompts/test.txt']).promptFile, 'prompts/test.txt');
  assert.equal(resolveRequestedPromptFile(null, { PROMPT_FILE: 'prompt_template_codex_v2.txt' }), 'prompt_template_codex_v2.txt');
  assert.equal(resolveRequestedPromptFile('prompts/override.txt', {}, '/tmp/current-directory'), '/tmp/current-directory/prompts/override.txt');
  assert.equal(resolveRequestedPromptFile('/tmp/override.txt', {}, '/tmp/current-directory'), '/tmp/override.txt');
  assert.throws(() => resolveRequestedPromptFile(null, {}), /does not select a fallback prompt/);
});

test('uses -p comparison prompts without invoking the v2 policy validator', async () => {
  const temporaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'compare-model-prompt-'));
  const promptFile = path.join(temporaryDir, 'legacy.txt');
  try {
    await fsp.writeFile(promptFile, 'Legacy prompt for {{VIDEO_TITLE}}.', 'utf8');
    const policy = await loadComparisonPrompt({
      promptFile,
      replacements: { VIDEO_TITLE: '테스트 영상' },
      bypassPolicyValidation: true
    });
    assert.equal(policy.prompt, 'Legacy prompt for 테스트 영상.');
    assert.equal(policy.policyValidation, 'bypassed');
    assert.equal(policy.policyVersion, 'unvalidated-comparison-prompt');
  } finally {
    await fsp.rm(temporaryDir, { recursive: true, force: true });
  }
});

test('allows only Gemini and OpenAI model naming families', () => {
  assert.equal(providerForModel('gemini-3.1-pro-preview'), 'gemini');
  assert.equal(providerForModel('gpt-5.6-terra'), 'openai');
  assert.throws(() => providerForModel('claude-sonnet'), /Unsupported model provider/);
  assert.throws(() => providerForModel('../gpt-5'), /Unsafe model name/);
});

test('runs a repeated model only once', () => {
  assert.deepEqual(modelRuns(['gpt-5.6-sol', 'gpt-5.6-sol']), [
    {
      model: 'gpt-5.6-sol',
      provider: 'openai',
      reasoningEffort: 'none',
      requestedModel: 'gpt-5.6-sol',
      outputFile: 'gpt-5.6-sol.txt'
    }
  ]);
});

test('parses GPT reasoning levels and creates distinct files for distinct levels', () => {
  assert.deepEqual(parseModelSpecifier('gpt-6-astra:HIGH'), {
    model: 'gpt-6-astra',
    provider: 'openai',
    requestedReasoningEffort: 'high'
  });
  assert.throws(() => parseModelSpecifier('gemini-3.1-pro-preview:high'), /only supported for OpenAI/);
  assert.throws(() => parseModelSpecifier('gpt-6-astra:fast'), /Unsupported reasoning level/);
  assert.throws(() => modelRuns(['gpt-6-astra:none']), /does not support reasoning level "none"/);
  assert.deepEqual(modelRuns(['gpt-6-astra:low', 'gpt-6-astra:high', 'gpt-6-astra:high']), [
    {
      model: 'gpt-6-astra',
      provider: 'openai',
      reasoningEffort: 'low',
      requestedModel: 'gpt-6-astra:low',
      outputFile: 'gpt-6-astra-low.txt'
    },
    {
      model: 'gpt-6-astra',
      provider: 'openai',
      reasoningEffort: 'high',
      requestedModel: 'gpt-6-astra:high',
      outputFile: 'gpt-6-astra-high.txt'
    }
  ]);
});

test('limits OpenAI model listing to comparison-capable families', () => {
  assert.equal(isOpenAIComparisonModel('gpt-5.6-sol'), true);
  assert.equal(isOpenAIComparisonModel('o4-mini'), false);
  assert.equal(isOpenAIComparisonModel('text-embedding-3-large'), false);
});

test('uses Astra-compatible OpenAI request settings without changing Sol none-mode settings', () => {
  assert.equal(isGpt6Astra('gpt-6-astra'), true);
  assert.equal(isGpt6Astra('gpt-6-astra-2026-09-01'), true);
  assert.equal(isGpt6Astra('gpt-5.6-sol'), false);
  assert.deepEqual(openAIRequestSettings('gpt-6-astra'), {
    reasoningEffort: 'low',
    temperature: undefined
  });
  assert.deepEqual(openAIRequestSettings('gpt-5.6-sol'), {
    reasoningEffort: 'none',
    temperature: 0.7
  });
  assert.deepEqual(openAIRequestSettings('gpt-6-astra', 'high'), {
    reasoningEffort: 'high',
    temperature: undefined
  });
});

test('omits temperature for Sol and Luna reasoning requests, including dated models', () => {
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-sol-2026-09-01', 'gpt-5.6-luna', 'gpt-5.6-luna-2026-09-01']) {
    for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const settings = openAIRequestSettings(model, reasoningEffort);
      assert.deepEqual(settings, { reasoningEffort, temperature: undefined });
      assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(settings)), 'temperature'), false);
    }
    assert.equal(openAIRequestSettings(model, 'none').temperature, 0.7);
  }
  assert.equal(openAIRequestSettings('gpt-6-astra', 'medium').temperature, undefined);
  assert.throws(() => openAIRequestSettings('gpt-6-astra', 'none'), /does not support/);
});

test('rejects a model absent from the live provider list before processing starts', () => {
  const runs = modelRuns(['gemini-3.1-pro-preview', 'gpt-5.6-sol']);
  assert.doesNotThrow(() => assertModelsAvailable(runs, {
    gemini: new Set(['gemini-3.1-pro-preview']),
    openai: new Set(['gpt-5.6-sol'])
  }));
  assert.throws(() => assertModelsAvailable(runs, {
    gemini: new Set(['gemini-3.1-pro-preview']),
    openai: new Set()
  }), /Unavailable -m model\(s\): gpt-5\.6-sol/);
});

test('retains the legacy tagged-line summary', () => {
  assert.deepEqual(countLines('[1][v1] 장면입니다.\n[2][trans] 번역입니다.\nplain'), {
    lines: 3,
    tagged: 2,
    tags: { v1: 1, v2: 0, v3: 0, txt: 0, trans: 1 }
  });
});

test('reports an API proxy HTML page without exposing its body', async () => {
  const response = new Response('<!DOCTYPE html>', {
    status: 502,
    headers: { 'content-type': 'text/html' }
  });
  await assert.rejects(responseJson(response, 'OpenAI'), /non-JSON response \(HTTP 502, text\/html\)/);
});

test('requires a complete versioned asset manifest before reusing cached media', () => {
  const asset = {
    version: 1,
    videoId: 'xsasfDdds12',
    videoFile: 'xsasfDdds12.mp4',
    audioLanguage: 'korean',
    dialogueTrack: [],
    frames: [{
      timestamp: 0,
      filename: 'frame-0001.jpg',
      sha256: 'a'.repeat(64)
    }]
  };
  assert.equal(isValidAssetManifestShape(asset, 'xsasfDdds12'), true);
  assert.equal(isValidAssetManifestShape({ ...asset, frames: [] }, 'xsasfDdds12'), false);
  assert.equal(isValidAssetManifestShape({ ...asset, videoId: 'anotherId12' }, 'xsasfDdds12'), false);
  assert.equal(isValidAssetManifestShape({ ...asset, frames: [{ ...asset.frames[0], filename: '../frame.jpg' }] }, 'xsasfDdds12'), false);
  assert.equal(isValidAssetManifestShape({ ...asset, subtitleSelection: { file: '../unsafe.vtt' } }, 'xsasfDdds12'), false);
});

test('reuses a complete asset cache and rejects a changed frame', async () => {
  const videoId = 'xsasfDdds12';
  const assetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'compare-model-assets-'));
  const frameBytes = Buffer.from('test frame bytes');
  try {
    await fsp.writeFile(path.join(assetDir, `${videoId}.mp4`), 'video bytes');
    await fsp.writeFile(path.join(assetDir, 'frame-0001.jpg'), frameBytes);
    await fsp.writeFile(path.join(assetDir, 'asset_manifest.json'), JSON.stringify({
      version: 1,
      videoId,
      videoFile: `${videoId}.mp4`,
      audioLanguage: 'korean',
      subtitleSelection: null,
      dialogueTrack: [],
      frames: [{
        timestamp: 0,
        filename: 'frame-0001.jpg',
        sha256: crypto.createHash('sha256').update(frameBytes).digest('hex')
      }]
    }));
    const cached = await loadCachedAssets(videoId, assetDir);
    assert.equal(cached.assetCache, 'hit');
    assert.equal(cached.frames[0].timestamp, 0);

    await fsp.writeFile(path.join(assetDir, 'frame-0001.jpg'), 'corrupted');
    assert.equal(await loadCachedAssets(videoId, assetDir), null);
  } finally {
    await fsp.rm(assetDir, { recursive: true, force: true });
  }
});
