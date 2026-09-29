'use strict';

// Compare one or more Gemini/OpenAI models against the exact same video input.
// This script reuses the backend media and prompt pipeline, but never saves a
// video or generated script to the application database.

const { createRequire } = require('node:module');
const { spawn, execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const RESULTS_ROOT = path.join(__dirname, 'result');
const requireBackend = createRequire(path.join(BACKEND, 'package.json'));

requireBackend('dotenv').config({ path: path.join(BACKEND, '.env'), quiet: true });

const { GoogleGenerativeAI } = requireBackend('@google/generative-ai');
const { google } = requireBackend('googleapis');
const db = require(path.join(BACKEND, 'database'));
const audioLanguageDetector = require(path.join(BACKEND, 'modules/audioLanguageDetector'));
const { loadPolicyPrompt } = require(path.join(BACKEND, 'modules/promptPolicy'));
const {
  extractKeyframesHybrid,
  parseVttToDialogueTrack,
  selectDialogueSubtitle
} = require(path.join(BACKEND, 'videoProcessor'));

const TEMPERATURE = 0.7;
const ASSET_CACHE_VERSION = 1;
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const SAFE_MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_ASSET_FRAME_NAME_PATTERN = /^frame-\d{4}\.jpg$/;
const OPENAI_REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

function usage() {
  return [
    'Usage:',
    '  node test_scripts/compare_model.js -m MODEL[:LEVEL] [-m MODEL[:LEVEL] ...] -v VIDEO_ID [-p PROMPT_FILE]',
    '  node test_scripts/compare_model.js -a',
    '',
    'Options:',
    '  -m MODEL[:LEVEL]  Gemini or GPT model ID. LEVEL sets GPT reasoning: none, low, medium, high, xhigh, max.',
    '                    Repeat for each model/configuration; duplicates run once.',
    '  -v VIDEO_ID  Eleven-character YouTube video ID.',
    '  -p PROMPT_FILE  Comparison-only prompt file, resolved from the current directory; bypasses policy validation.',
    '  -a  List account-available Gemini generateContent and OpenAI GPT model IDs in real time.',
    '  -h, --help  Show this help.'
  ].join('\n');
}

function parseArguments(argv) {
  const models = [];
  let videoId = null;
  let promptFile = null;
  let listAvailable = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-m') {
      const model = argv[++index];
      if (!model) throw new Error('-m requires a model name.\n\n' + usage());
      models.push(model);
    } else if (arg === '-v') {
      const value = argv[++index];
      if (!value) throw new Error('-v requires a YouTube video ID.\n\n' + usage());
      videoId = value;
    } else if (arg === '-p') {
      const value = argv[++index];
      if (!value) throw new Error('-p requires a prompt file path.\n\n' + usage());
      promptFile = value;
    } else if (arg === '-a') {
      listAvailable = true;
    } else if (arg === '-h' || arg === '--help') {
      return { help: true, models: [], videoId: null, promptFile: null, listAvailable: false };
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  if (listAvailable) {
    if (models.length > 0 || videoId || promptFile) throw new Error('-a cannot be combined with -m, -v, or -p.\n\n' + usage());
    return { help: false, models, videoId, promptFile, listAvailable };
  }
  if (models.length === 0) throw new Error('Provide at least one -m MODEL.\n\n' + usage());
  if (!videoId || !YOUTUBE_ID_PATTERN.test(videoId)) {
    throw new Error('Provide an eleven-character YouTube video ID with -v.\n\n' + usage());
  }
  return { help: false, models, videoId, promptFile, listAvailable };
}

function resolveRequestedPromptFile(promptFile, environment = process.env, currentDirectory = process.cwd()) {
  const optionValue = String(promptFile || '').trim();
  if (optionValue) return path.resolve(currentDirectory, optionValue);
  const environmentValue = String(environment.PROMPT_FILE || '').trim();
  if (!environmentValue) {
    throw new Error('Provide -p PROMPT_FILE or set PROMPT_FILE. The test script does not select a fallback prompt.');
  }
  return environmentValue;
}

function substitutePromptPlaceholders(prompt, replacements = {}) {
  return Object.entries(replacements).reduce(
    (result, [name, value]) => result.split(`{{${name}}}`).join(String(value ?? '')),
    prompt
  );
}

async function loadComparisonPrompt({ promptFile, replacements, bypassPolicyValidation }) {
  if (!bypassPolicyValidation) {
    const policy = await loadPolicyPrompt({ promptFile, replacements });
    return { ...policy, policyValidation: 'enforced' };
  }
  let source;
  try {
    source = await fsp.readFile(promptFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Comparison prompt file not found: ${promptFile}`);
    throw error;
  }
  return {
    prompt: substitutePromptPlaceholders(source, replacements),
    policyVersion: 'unvalidated-comparison-prompt',
    promptFile,
    policyValidation: 'bypassed',
    context: { promptFile, replacements: Object.keys(replacements || {}) }
  };
}

function providerForModel(model) {
  if (!SAFE_MODEL_NAME_PATTERN.test(model)) {
    throw new Error(`Unsafe model name: ${model}`);
  }
  if (model.startsWith('gemini-')) return 'gemini';
  if (model.startsWith('gpt-')) return 'openai';
  throw new Error(`Unsupported model provider for "${model}". Use a gemini-* or gpt-* model listed by -a.`);
}

function parseModelSpecifier(specifier) {
  const parts = String(specifier || '').split(':');
  if (parts.length > 2 || !parts[0] || (parts.length === 2 && !parts[1])) {
    throw new Error(`Invalid model specifier: ${specifier}. Use MODEL or MODEL:LEVEL.`);
  }
  const model = parts[0];
  const provider = providerForModel(model);
  const requestedReasoningEffort = parts[1] ? parts[1].toLowerCase() : null;
  if (requestedReasoningEffort && provider !== 'openai') {
    throw new Error(`Reasoning level is only supported for OpenAI GPT models: ${specifier}`);
  }
  if (requestedReasoningEffort && !OPENAI_REASONING_EFFORTS.has(requestedReasoningEffort)) {
    throw new Error(`Unsupported reasoning level "${parts[1]}". Use one of: ${[...OPENAI_REASONING_EFFORTS].join(', ')}.`);
  }
  return { model, provider, requestedReasoningEffort };
}

function modelRuns(models) {
  const configurations = new Map();
  for (const specifier of models) {
    const parsed = parseModelSpecifier(specifier);
    const settings = parsed.provider === 'openai'
      ? openAIRequestSettings(parsed.model, parsed.requestedReasoningEffort)
      : null;
    const reasoningEffort = settings?.reasoningEffort || null;
    const key = `${parsed.model}\u0000${reasoningEffort || ''}`;
    if (!configurations.has(key)) {
      configurations.set(key, {
        model: parsed.model,
        provider: parsed.provider,
        reasoningEffort,
        requestedModel: parsed.requestedReasoningEffort
          ? `${parsed.model}:${reasoningEffort}`
          : parsed.model
      });
    }
  }
  const runs = [...configurations.values()];
  const configurationsPerModel = runs.reduce((counts, run) => {
    counts.set(run.model, (counts.get(run.model) || 0) + 1);
    return counts;
  }, new Map());
  return runs.map(run => ({
    ...run,
    outputFile: configurationsPerModel.get(run.model) > 1
      ? `${run.model}-${run.reasoningEffort}.txt`
      : `${run.model}.txt`
  }));
}

function parseISO8601Duration(duration) {
  const match = String(duration || '').match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  if (!match) return 0;
  return (parseInt(match[1], 10) || 0) * 3600
    + (parseInt(match[2], 10) || 0) * 60
    + (parseInt(match[3], 10) || 0);
}

function assetManifestPath(assetDir) {
  return path.join(assetDir, 'asset_manifest.json');
}

function isSafeAssetSubtitleName(filename) {
  return typeof filename === 'string' && filename.endsWith('.vtt') && path.basename(filename) === filename;
}

function isValidAssetManifestShape(manifest, videoId) {
  return Boolean(
    manifest
    && manifest.version === ASSET_CACHE_VERSION
    && manifest.videoId === videoId
    && manifest.videoFile === `${videoId}.mp4`
    && typeof manifest.audioLanguage === 'string'
    && Array.isArray(manifest.dialogueTrack)
    && Array.isArray(manifest.frames)
    && manifest.frames.length > 0
    && (!manifest.subtitleSelection || isSafeAssetSubtitleName(manifest.subtitleSelection.file))
    && manifest.frames.every(frame => (
      frame
      && Number.isFinite(frame.timestamp)
      && SAFE_ASSET_FRAME_NAME_PATTERN.test(frame.filename)
      && /^[a-f0-9]{64}$/.test(frame.sha256)
    ))
  );
}

async function readFramesFromAsset(assetDir, frameDescriptors) {
  const frames = [];
  for (const descriptor of frameDescriptors) {
    const framePath = path.join(assetDir, descriptor.filename);
    const bytes = await fsp.readFile(framePath);
    if (bytes.length === 0) throw new Error(`Cached frame is empty: ${descriptor.filename}`);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== descriptor.sha256) throw new Error(`Cached frame checksum mismatch: ${descriptor.filename}`);
    frames.push({
      timestamp: descriptor.timestamp,
      filename: descriptor.filename,
      data: bytes.toString('base64'),
      sha256
    });
  }
  return frames;
}

async function loadCachedAssets(videoId, assetDir) {
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(assetManifestPath(assetDir), 'utf8'));
    if (!isValidAssetManifestShape(manifest, videoId)) return null;
    const video = await fsp.stat(path.join(assetDir, manifest.videoFile));
    if (!video.isFile() || video.size === 0) return null;
    if (manifest.subtitleSelection) {
      const subtitle = await fsp.stat(path.join(assetDir, manifest.subtitleSelection.file));
      if (!subtitle.isFile() || subtitle.size === 0) return null;
    }
    const frames = await readFramesFromAsset(assetDir, manifest.frames);
    return {
      audioLanguage: manifest.audioLanguage,
      subtitleSelection: manifest.subtitleSelection || null,
      dialogueTrack: manifest.dialogueTrack,
      frames,
      assetCache: 'hit'
    };
  } catch (error) {
    return null;
  }
}

async function writeAssetManifest(assetDir, manifest) {
  const targetPath = assetManifestPath(assetDir);
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await fsp.writeFile(temporaryPath, JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.rename(temporaryPath, targetPath);
}

function getRandomCookiePath(excludedPaths = []) {
  const cookiesDir = path.join(BACKEND, 'cookies');
  if (fs.existsSync(cookiesDir)) {
    const cookieFiles = fs.readdirSync(cookiesDir)
      .filter(file => file.endsWith('_cookies.txt') && fs.statSync(path.join(cookiesDir, file)).size > 0)
      .map(file => path.join(cookiesDir, file))
      .filter(file => !excludedPaths.includes(file));
    if (cookieFiles.length > 0) return cookieFiles[Math.floor(Math.random() * cookieFiles.length)];
  }
  const defaultCookiePath = path.join(BACKEND, 'cookies.txt');
  return fs.existsSync(defaultCookiePath) && !excludedPaths.includes(defaultCookiePath) ? defaultCookiePath : null;
}

function getSafariImpersonateArgs() {
  try {
    const output = execSync('yt-dlp --list-impersonate-targets', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const safariLine = output.split('\n').find(line => line.includes('Safari') || line.includes('safari'));
    if (safariLine && !safariLine.toLowerCase().includes('unavailable')) return ['--impersonate', 'safari'];
  } catch (error) {
    try {
      execSync('yt-dlp --impersonate safari -s --playlist-items 0 ""', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return ['--impersonate', 'safari'];
    } catch (fallbackError) {
      const output = `${fallbackError.stderr || ''}${fallbackError.stdout || ''}`;
      if (!output.includes('Impersonate target') && !output.includes('missing dependencies') && !output.includes('curl_cffi')) {
        return ['--impersonate', 'safari'];
      }
    }
  }
  return [];
}

function runYtDlp(args, cwd, tempVideoPath, activeCookiePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { cwd });
    let stderrData = '';
    child.stderr.on('data', data => { stderrData += data.toString(); });
    child.on('error', error => reject(new Error(`Failed to spawn yt-dlp: ${error.message}`)));
    child.on('close', code => {
      const hasVideo = fs.existsSync(tempVideoPath) && fs.statSync(tempVideoPath).size > 0;
      if (code === 0 || (hasVideo && stderrData.includes('subtitle'))) return resolve();
      const stderrLower = stderrData.toLowerCase();
      const isBotError = stderrLower.includes('confirm you’re not a bot')
        || stderrLower.includes('cookies are no longer valid')
        || stderrLower.includes('http error 403')
        || stderrLower.includes('login required')
        || stderrLower.includes('sign in to confirm');
      if (isBotError && activeCookiePath) return reject({ type: 'bot_detected', message: stderrData });
      return reject(new Error(`yt-dlp download failed with code ${code}. Stderr: ${stderrData}`));
    });
  });
}

async function downloadVideo(videoId, baseTempDir) {
  const tempVideoFilename = `${videoId}.mp4`;
  const tempVideoPath = path.join(baseTempDir, tempVideoFilename);
  const proxyArgs = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];
  const impersonateArgs = getSafariImpersonateArgs();
  const usedCookiePaths = [];

  for (let downloadAttempt = 1; downloadAttempt <= 2; downloadAttempt += 1) {
    const currentCookiePath = getRandomCookiePath(usedCookiePaths);
    if (downloadAttempt === 2) {
      for (const file of await fsp.readdir(baseTempDir)) await fsp.unlink(path.join(baseTempDir, file));
    }
    const cookieArgs = currentCookiePath ? ['--cookies', currentCookiePath] : [];
    const ytdlpArgs = [
      '-f', 'best[height<=360][vcodec!=none][acodec!=none]/best[height<=360]',
      '-o', tempVideoFilename,
      '--force-ipv4',
      '--legacy-server-connect',
      '--no-check-certificate',
      '--plugin-dirs', path.join(BACKEND, 'yt_dlp_plugins'),
      '--remote-components', 'ejs:github',
      '--js-runtimes', 'node',
      ...impersonateArgs,
      '--newline',
      '--write-auto-sub', '--write-sub', '--sub-lang', 'ko,en',
      ...cookieArgs,
      ...proxyArgs,
      `https://www.youtube.com/watch?v=${videoId}`
    ];
    try {
      await runYtDlp(ytdlpArgs, baseTempDir, tempVideoPath, currentCookiePath);
      return { tempVideoFilename, tempVideoPath };
    } catch (error) {
      if (error.type === 'bot_detected' && downloadAttempt === 1) {
        if (currentCookiePath) usedCookiePaths.push(currentCookiePath);
        continue;
      }
      throw error;
    }
  }
  throw new Error('yt-dlp did not download a video.');
}

async function loadBackendInitialInputs(videoId, assetDir, promptFile, bypassPolicyValidation) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const youtube = google.youtube({
    version: 'v3',
    auth: process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY
  });
  const metadataResponse = await youtube.videos.list({ part: 'snippet,contentDetails,status', id: videoId });
  const videoItem = metadataResponse.data.items && metadataResponse.data.items[0];
  if (!videoItem) throw new Error('Invalid or missing YouTube URL');
  if (videoItem.status && videoItem.status.embeddable === false) throw new Error('This video cannot be embedded and played on external sites.');
  if (videoItem.snippet.liveBroadcastContent === 'live') throw new Error('Live streams cannot be processed.');

  const title = videoItem.snippet.title;
  const duration = parseISO8601Duration(videoItem.contentDetails.duration);
  const durationLimitMinutes = parseInt(db.getSetting('videoDurationLimit') || '30', 10);
  if (durationLimitMinutes > 0 && duration >= durationLimitMinutes * 60) {
    throw new Error(`Video duration (${duration}s) exceeds the limit of ${durationLimitMinutes} minutes.`);
  }

  await fsp.mkdir(assetDir, { recursive: true });
  const cachedAssets = await loadCachedAssets(videoId, assetDir);
  if (cachedAssets) {
    const policy = await loadComparisonPrompt({
      promptFile,
      bypassPolicyValidation,
      replacements: {
        VIDEO_TITLE: title,
        AUDIO_CLASSIFICATION: cachedAssets.audioLanguage,
        AUDIO_LANGUAGE: cachedAssets.audioLanguage,
        DIALOGUE_TRACK: JSON.stringify(cachedAssets.dialogueTrack, null, 2)
      }
    });
    return {
      videoUrl,
      title,
      duration,
      inputDir: assetDir,
      tempVideoPath: path.join(assetDir, `${videoId}.mp4`),
      ...cachedAssets,
      policy
    };
  }

  const { tempVideoFilename, tempVideoPath } = await downloadVideo(videoId, assetDir);
  const [allTimestamps, audioLanguage] = await Promise.all([
    extractKeyframesHybrid({
      tempVideoPath,
      tempVideoFilename,
      baseTempDir: assetDir,
      totalDuration: duration,
      requestHash: `compare-${videoId}`,
      sseHandler: null
    }),
    audioLanguageDetector.detectLanguage(tempVideoPath, duration, `compare-${videoId}`)
  ]);
  const subtitleSelection = selectDialogueSubtitle(
    fs.readdirSync(assetDir).filter(file => file.endsWith('.vtt')),
    audioLanguage
  );
  const dialogueTrack = subtitleSelection
    ? parseVttToDialogueTrack(path.join(assetDir, subtitleSelection.file), subtitleSelection.sourceLanguage, subtitleSelection)
    : [];
  const frameDescriptors = allTimestamps.map((timestamp, index) => ({
    timestamp,
    filename: `frame-${String(index + 1).padStart(4, '0')}.jpg`
  }));
  const framesWithoutChecksums = await readFramesFromAsset(assetDir, await Promise.all(frameDescriptors.map(async frame => {
    const bytes = await fsp.readFile(path.join(assetDir, frame.filename));
    return { ...frame, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  })));
  const manifest = {
    version: ASSET_CACHE_VERSION,
    videoId,
    videoFile: tempVideoFilename,
    audioLanguage,
    subtitleSelection,
    dialogueTrack,
    frames: framesWithoutChecksums.map(({ data, ...frame }) => frame)
  };
  await writeAssetManifest(assetDir, manifest);
  const policy = await loadComparisonPrompt({
    promptFile,
    bypassPolicyValidation,
    replacements: {
      VIDEO_TITLE: title,
      AUDIO_CLASSIFICATION: audioLanguage,
      AUDIO_LANGUAGE: audioLanguage,
      DIALOGUE_TRACK: JSON.stringify(dialogueTrack, null, 2)
    }
  });
  return {
    videoUrl,
    title,
    duration,
    inputDir: assetDir,
    tempVideoPath,
    audioLanguage,
    subtitleSelection,
    dialogueTrack,
    frames: framesWithoutChecksums,
    assetCache: 'miss',
    policy
  };
}

function countLines(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  const tags = Object.fromEntries(['v1', 'v2', 'v3', 'txt', 'trans'].map(tag => [tag, 0]));
  const tagged = lines.filter(line => /^\[\d+\]\[(?:v1|v2|v3|txt|trans)\]\s+/.test(line));
  for (const line of tagged) tags[line.match(/^\[\d+\]\[([^\]]+)\]/)[1]] += 1;
  return { lines: lines.length, tagged: tagged.length, tags };
}

async function runGemini(modelName, prompt, frames) {
  const model = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY).getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: TEMPERATURE, mediaResolution: 'MEDIA_RESOLUTION_LOW' }
  });
  const imageParts = [];
  for (const frame of frames) {
    imageParts.push({ inlineData: { data: frame.data, mimeType: 'image/jpeg' } });
    imageParts.push({ text: `Timestamp: [${Math.round(frame.timestamp)}]` });
  }
  const startedAt = Date.now();
  const result = await model.generateContentStream([prompt, ...imageParts]);
  let text = '';
  for await (const chunk of result.stream) if (chunk.text) text += chunk.text();
  const response = await result.response;
  return { model: modelName, durationMs: Date.now() - startedAt, text, usage: response.usageMetadata || null };
}

function responseText(response) {
  if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
  return (response.output || [])
    .filter(item => item.type === 'message')
    .flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text')
    .map(item => item.text || '')
    .join('');
}

function isGpt6Astra(modelName) {
  return modelName === 'gpt-6-astra' || modelName.startsWith('gpt-6-astra-');
}

function openAIRequestSettings(modelName, requestedReasoningEffort = null) {
  const reasoningEffort = requestedReasoningEffort || (isGpt6Astra(modelName) ? 'low' : 'none');
  if (!OPENAI_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`Unsupported reasoning level "${reasoningEffort}". Use one of: ${[...OPENAI_REASONING_EFFORTS].join(', ')}.`);
  }
  if (isGpt6Astra(modelName) && reasoningEffort === 'none') {
    throw new Error(`gpt-6-astra does not support reasoning level "none". Use low, medium, high, xhigh, or max.`);
  }
  if (isGpt6Astra(modelName)) {
    // Astra requires a reasoning level and does not accept temperature.
    return { reasoningEffort, temperature: undefined };
  }
  if (/^gpt-5\.6-(sol|luna)(?:-|$)/.test(modelName) && reasoningEffort !== 'none') {
    // Sol and Luna reject temperature when reasoning is enabled.
    return { reasoningEffort, temperature: undefined };
  }
  return { reasoningEffort, temperature: TEMPERATURE };
}

async function responseJson(apiResponse, provider) {
  const raw = await apiResponse.text();
  let response;
  try {
    response = JSON.parse(raw);
  } catch (error) {
    const contentType = apiResponse.headers.get('content-type') || 'unknown content type';
    throw new Error(`${provider} returned a non-JSON response (HTTP ${apiResponse.status}, ${contentType}).`);
  }
  return response;
}

async function runOpenAI(modelName, prompt, frames, requestedReasoningEffort = null) {
  const content = [{ type: 'input_text', text: prompt }];
  for (const frame of frames) {
    content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${frame.data}`, detail: 'low' });
    content.push({ type: 'input_text', text: `Timestamp: [${Math.round(frame.timestamp)}]` });
  }
  const settings = openAIRequestSettings(modelName, requestedReasoningEffort);
  const requestBody = {
    model: modelName,
    reasoning: { effort: settings.reasoningEffort },
    input: [{ role: 'user', content }]
  };
  if (settings.temperature !== undefined) requestBody.temperature = settings.temperature;
  const startedAt = Date.now();
  const apiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(15 * 60 * 1000)
  });
  const response = await responseJson(apiResponse, 'OpenAI');
  if (!apiResponse.ok) throw new Error(`OpenAI ${apiResponse.status}: ${JSON.stringify(response).slice(0, 2000)}`);
  return {
    model: modelName,
    durationMs: Date.now() - startedAt,
    text: responseText(response),
    usage: response.usage || null,
    responseId: response.id || null
  };
}

async function writeModelResult(runDir, run, settled) {
  if (settled.status === 'fulfilled') {
    await fsp.writeFile(path.join(runDir, run.outputFile), settled.value.text, 'utf8');
    return { provider: run.provider, requestedModel: run.requestedModel, outputFile: run.outputFile, ...settled.value, summary: countLines(settled.value.text) };
  }
  const error = settled.reason && (settled.reason.stack || settled.reason.message || String(settled.reason));
  const errorFile = run.outputFile.replace(/\.txt$/, '.error.txt');
  await fsp.writeFile(path.join(runDir, errorFile), error, 'utf8');
  return { provider: run.provider, requestedModel: run.requestedModel, errorFile, error };
}

function isOpenAIComparisonModel(modelId) {
  return modelId.startsWith('gpt-');
}

async function listGeminiModels() {
  if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY is required to list Gemini models.');
  const models = [];
  let pageToken = null;
  do {
    const endpoint = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    endpoint.searchParams.set('key', process.env.GOOGLE_API_KEY);
    if (pageToken) endpoint.searchParams.set('pageToken', pageToken);
    const apiResponse = await fetch(endpoint, { signal: AbortSignal.timeout(30 * 1000) });
    const response = await responseJson(apiResponse, 'Gemini');
    if (!apiResponse.ok) throw new Error(`Gemini ${apiResponse.status}: ${JSON.stringify(response).slice(0, 1000)}`);
    for (const model of response.models || []) {
      const modelId = String(model.name || '').replace(/^models\//, '');
      if (modelId.startsWith('gemini-') && (model.supportedGenerationMethods || []).includes('generateContent')) {
        models.push(modelId);
      }
    }
    pageToken = response.nextPageToken || null;
  } while (pageToken);
  return [...new Set(models.filter(Boolean))].sort();
}

async function listOpenAIModels() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required to list OpenAI models.');
  const apiResponse = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(30 * 1000)
  });
  const response = await responseJson(apiResponse, 'OpenAI');
  if (!apiResponse.ok) throw new Error(`OpenAI ${apiResponse.status}: ${JSON.stringify(response).slice(0, 1000)}`);
  return [...new Set((response.data || [])
    .map(model => model.id)
    .filter(modelId => typeof modelId === 'string' && isOpenAIComparisonModel(modelId)))]
    .sort();
}

async function printAvailableModels() {
  const providers = [
    ['Gemini', listGeminiModels],
    ['OpenAI', listOpenAIModels]
  ];
  const results = await Promise.allSettled(providers.map(([, list]) => list()));
  let failed = false;
  for (let index = 0; index < providers.length; index += 1) {
    const [name] = providers[index];
    const result = results[index];
    if (result.status === 'fulfilled') {
      console.log(`${name}:`);
      console.log(result.value.length > 0 ? result.value.join('\n') : '(No compatible models returned.)');
    } else {
      failed = true;
      console.error(`${name}: ${result.reason.message || String(result.reason)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

function requireCredentials(runs) {
  if (runs.some(run => run.provider === 'gemini') && !process.env.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is required for selected Gemini models.');
  }
  if (runs.some(run => run.provider === 'openai') && !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for selected OpenAI models.');
  }
}

function assertModelsAvailable(runs, modelsByProvider) {
  const unavailable = runs.filter(run => !modelsByProvider[run.provider]?.has(run.model));
  if (unavailable.length > 0) {
    throw new Error(`Unavailable -m model(s): ${unavailable.map(run => run.model).join(', ')}. Run with -a to see the current account-available model IDs.`);
  }
}

async function validateSelectedModels(runs) {
  const providers = [...new Set(runs.map(run => run.provider))];
  const listingFunctions = { gemini: listGeminiModels, openai: listOpenAIModels };
  const listedModels = await Promise.all(providers.map(provider => listingFunctions[provider]()));
  const modelsByProvider = Object.fromEntries(providers.map((provider, index) => [provider, new Set(listedModels[index])]));
  assertModelsAvailable(runs, modelsByProvider);
}

async function generateModel(run, prompt, frames) {
  return run.provider === 'gemini'
    ? runGemini(run.model, prompt, frames)
    : runOpenAI(run.model, prompt, frames, run.reasoningEffort);
}

async function main(argv = process.argv.slice(2), workflow = {}) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(workflow.help || usage());
    return;
  }
  if (options.listAvailable) {
    await printAvailableModels();
    return;
  }

  const runs = modelRuns(options.models);
  if (workflow.validateRuns) workflow.validateRuns(runs);
  requireCredentials(runs);
  const promptFile = resolveRequestedPromptFile(options.promptFile);
  const bypassPolicyValidation = Boolean(options.promptFile);
  // Validate before creating a result directory or processing/downloading media.
  await validateSelectedModels(runs);
  const videoResultDir = path.join(RESULTS_ROOT, options.videoId);
  const assetDir = path.join(videoResultDir, 'asset');
  await fsp.mkdir(videoResultDir, { recursive: true });
  const input = await loadBackendInitialInputs(options.videoId, assetDir, promptFile, bypassPolicyValidation);
  const runDir = await fsp.mkdtemp(path.join(videoResultDir, workflow.runPrefix || 'run-'));
  console.log(`WORK_DIR=${runDir}`);
  await fsp.writeFile(path.join(runDir, 'prompt.txt'), input.policy.prompt, 'utf8');
  await fsp.writeFile(path.join(runDir, 'input_context.json'), JSON.stringify({
    videoId: options.videoId,
    videoUrl: input.videoUrl,
    title: input.title,
    duration: input.duration,
    audioLanguage: input.audioLanguage,
    subtitleSelection: input.subtitleSelection,
    dialogueTrack: input.dialogueTrack,
    frames: input.frames.map(({ data, ...frame }) => frame),
    policyVersion: input.policy.policyVersion,
    policyValidation: input.policy.policyValidation,
    promptFile: input.policy.promptFile,
    assetCache: input.assetCache,
    assetDir,
    ...(workflow.inputMetadata || {}),
    geminiTemperature: TEMPERATURE,
    models: runs.map(({ model, provider, outputFile, requestedModel, reasoningEffort }) => ({
      model,
      requestedModel,
      provider,
      outputFile,
      geminiMediaResolution: provider === 'gemini' ? 'MEDIA_RESOLUTION_LOW' : undefined,
      openaiImageDetail: provider === 'openai' ? 'low' : undefined,
      openaiReasoningEffort: provider === 'openai' ? reasoningEffort : undefined,
      openaiTemperature: provider === 'openai' ? openAIRequestSettings(model, reasoningEffort).temperature : undefined
    }))
  }, null, 2));

  const settledRuns = await Promise.allSettled(runs.map(run => workflow.generate
    ? workflow.generate({ run, input, runDir })
    : generateModel(run, input.policy.prompt, input.frames)));
  const results = await Promise.all(runs.map((run, index) => writeModelResult(runDir, run, settledRuns[index])));
  const result = {
    ...(workflow.mode ? { mode: workflow.mode } : {}),
    workDir: runDir,
    videoId: options.videoId,
    title: input.title,
    frameCount: input.frames.length,
    dialogueCount: input.dialogueTrack.length,
    audioLanguage: input.audioLanguage,
    models: results
  };
  await fsp.writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (settledRuns.some(run => run.status === 'rejected')) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  usage,
  generateModel,
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
};
