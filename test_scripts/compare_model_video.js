'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { main: compareMain, usage } = require('./compare_model');
const requireBackend = createRequire(path.join(__dirname, '../backend/package.json'));
const { GoogleAIFileManager } = requireBackend('@google/generative-ai/server');
const { GoogleGenerativeAI } = requireBackend('@google/generative-ai');

function validateRuns(runs) {
  if (runs.some(run => run.provider !== 'gemini')) throw new Error('Video upload comparison currently supports Gemini models only.');
}

async function waitForVideo(manager, file, { timeoutMs = 10 * 60 * 1000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (file.state === 'PROCESSING') {
    if (Date.now() >= deadline) throw new Error('Video processing timed out.');
    await sleep(5000);
    file = await manager.getFile(file.name);
  }
  if (file.state !== 'ACTIVE') throw new Error(`Video is not ACTIVE: ${file.state}`);
  return file;
}

function videoParts(file, prompt) {
  return [{ fileData: { fileUri: file.uri, mimeType: file.mimeType || 'video/mp4' }, videoMetadata: { fps: 1 } }, { text: prompt }];
}

function timedVideoPrompt(prompt, duration) {
  const examples = Array.from({ length: Math.floor(duration / 60) + 1 }, (_, minute) => `${String(minute).padStart(2, '0')}:00=[${minute * 60}]`).join(', ');
  return `${prompt}\n\n# 실제 입력 파일의 시간 한도\n영상 길이는 ${duration}초입니다. 출력 시각은 0보다 크고 ${duration} 이하인 누적 정수 초입니다. 분과 초를 이어 붙이지 마십시오. 07:04는 [424]이며 [704]가 아닙니다. 변환 기준: ${examples}. 모든 줄의 시각을 변환하고 범위 검사한 뒤 출력하십시오. 시각을 맞추기 위해 장면을 앞당기거나 없는 장면을 만들지 마십시오.`;
}

async function main(argv = process.argv.slice(2)) {
  // Native timeout signals do not keep Node alive after successful requests;
  // this SDK's numeric timeout option leaves referenced timers behind.
  const fileClient = () => new GoogleAIFileManager(process.env.GOOGLE_API_KEY, { signal: AbortSignal.timeout(120000) });
  const manager = {
    uploadFile: (...args) => fileClient().uploadFile(...args),
    getFile: (...args) => fileClient().getFile(...args),
    deleteFile: (...args) => fileClient().deleteFile(...args)
  };
  let uploaded;
  let prepared;
  try {
    await compareMain(argv, {
      mode: 'video_file', runPrefix: 'video-', validateRuns,
      inputMetadata: { modelInput: 'video_file_with_audio', sampledFramesSent: false, videoFps: 1, videoProcessing: 'static' },
      help: usage().replaceAll('compare_model.js', 'compare_model_video.js') + '\nGemini only. Sends the cached MP4 with audio, not extracted JPEGs. Static 1 FPS, low media resolution.\nUse a video-aware -p prompt. Uploaded temporary file is deleted after generation.\n-a lists the shared catalog; only Gemini selections work in this script.',
      generate: async ({ run, input, runDir }) => {
        // Multiple selected models share one upload and its processing result.
        if (!prepared) prepared = (async () => {
          const bytes = await fs.readFile(input.tempVideoPath);
          if (!bytes.length || bytes.length > 2 * 1024 ** 3) throw new Error('Video must be nonempty and at most 2 GiB.');
          const start = Date.now();
          console.log('VIDEO_UPLOAD_STARTED');
          uploaded = (await manager.uploadFile(input.tempVideoPath, { mimeType: 'video/mp4', displayName: `compare-${path.basename(input.tempVideoPath)}` })).file;
          await fs.writeFile(path.join(runDir, 'video_input.json'), JSON.stringify({ path: input.tempVideoPath, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), uploaded }, null, 2));
          const file = await waitForVideo(manager, uploaded);
          const metadata = { path: input.tempVideoPath, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), file, uploadAndProcessingMs: Date.now() - start, fps: 1, mediaResolution: 'MEDIA_RESOLUTION_LOW', audioIncluded: true };
          await fs.writeFile(path.join(runDir, 'video_input.json'), JSON.stringify(metadata, null, 2));
          console.log('VIDEO_READY');
          return file;
        })();
        const file = await prepared;
        const model = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY).getGenerativeModel({ model: run.model, generationConfig: { temperature: 0.7, mediaResolution: 'MEDIA_RESOLUTION_LOW' } }, { signal: AbortSignal.timeout(15 * 60 * 1000) });
        const start = Date.now();
        const effectivePrompt = timedVideoPrompt(input.policy.prompt, input.duration);
        await fs.writeFile(path.join(runDir, `${run.model}.video-prompt.txt`), effectivePrompt, 'utf8');
        const response = await model.generateContentStream(videoParts(file, effectivePrompt));
        let text = '';
        for await (const chunk of response.stream) if (chunk.text) text += chunk.text();
        const final = await response.response;
        if (!text.trim()) throw new Error(`Empty video model output (${final.candidates?.[0]?.finishReason || 'unknown reason'}).`);
        return { model: run.model, text, durationMs: Date.now() - start, usage: final.usageMetadata || null, inputMode: 'video_file', fps: 1 };
      }
    });
  } finally {
    if (uploaded?.name) {
      try { await manager.deleteFile(uploaded.name); console.log('TEMPORARY_REMOTE_VIDEO_DELETED (local asset preserved)'); }
      catch { console.warn('Remote video cleanup failed; Files API expiry still applies. Local asset preserved.'); }
    }
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
module.exports = { main, validateRuns, waitForVideo, videoParts, timedVideoPrompt };
