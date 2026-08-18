# Testing Patterns

**Analysis Date:** 2026-08-18

## Test Framework

**Runner:**
- Frontend: Jest (via `react-scripts test` version `5.0.1`)
- Backend: Custom execution of standalone Node scripts (no formal test runner framework)
- Config: `frontend/package.json` configurations (ESLint / Jest rules setup)

**Assertion Library:**
- Frontend: `@testing-library/jest-dom` (using `expect(...).toBeInTheDocument()`, etc.)
- Backend: Custom log checks and conditional output validations (no formal assertion library like Mocha/Chai/Jest is used in the backend)

**Run Commands:**
```bash
npm test                # Run all frontend tests (run inside frontend/ directory)
node test_tts.js        # Run backend Text-to-Speech API integration test
node test_full_workflow.js <youtube_url>  # Run backend video processing workflow test
node test_matrix_runner.js [youtube_url] # Run backend local/remote and prompt matrix test
```

## Test File Organization

**Location:**
- Frontend: Co-located inside the `frontend/src/` directory (e.g., `App.test.js`).
- Backend: Located in the root of the `backend/` directory (e.g., `backend/test_tts.js`, `backend/test_full_workflow.js`, `backend/test_matrix_runner.js`).

**Naming:**
- Frontend: `[ComponentName].test.js`
- Backend: `test_[feature].js` or `run_[feature]_test.js` or `poc_[feature].js`

**Structure:**
```
youtube-describer/
├── backend/
│   ├── test.js
│   ├── test_full_workflow.js
│   ├── test_gemini_3.js
│   ├── test_local_video.js
│   ├── test_matrix_runner.js
│   ├── test_search.js
│   ├── test_ssl.js
│   ├── test_tts.js
│   ├── test_whisper_concurrency.js
│   └── run_comparison_test.js
└── frontend/
    └── src/
        ├── App.test.js
        └── setupTests.js
```

## Test Structure

**Suite Organization:**
```typescript
// Frontend Jest Pattern
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders learn react link', () => {
  render(<App />);
  const linkElement = screen.getByText(/learn react/i);
  expect(linkElement).toBeInTheDocument();
});

// Backend Standalone Integration Script Pattern
require('dotenv').config();
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

async function testTTS() {
    console.log('--- TTS API Test Initializing ---');
    try {
        const ttsClient = new TextToSpeechClient({ fallback: 'rest' });
        const request = {
            input: { text: '안녕하세요. TTS API 테스트입니다.' },
            voice: { languageCode: 'ko-KR', ssmlGender: 'FEMALE', name: 'ko-KR-Chirp3-HD-Sulafat' },
            audioConfig: { audioEncoding: 'MP3' },
        };
        const [response] = await ttsClient.synthesizeSpeech(request);
        console.log('TTS API call was successful: received', response.audioContent.length, 'bytes.');
    } catch (error) {
        console.error('API CALL FAILED:', error);
    }
}
testTTS();
```

**Patterns:**
- Setup pattern: Backend tests define randomized IDs and local paths (e.g., `const runId = Math.random().toString(36).substring(2, 10); const tempVideoPath = path.join(baseTempDir, 'video_' + runId + '.mp4');`) and ensure temporary sandbox directories exist.
- Teardown pattern: `finally` blocks in backend test scripts clean up the generated assets: checking for file existence and deleting temporary `.mp4` video files, sliced `.wav` audio files, keyframe `.jpg` images, and directory wrappers.
- Assertion pattern: Logging the outputs of each execution block via `console.log` / `console.error` and checking for file sizes or status updates directly in the sqlite cache database.

## Mocking

**Framework:** Custom JavaScript mock implementation (no formal mocking library is loaded on the backend).

**Patterns:**
```typescript
// In test_matrix_runner.js:
// Injects mock subtitles/dialogue track data when external API queries fail or return empty sets
if (!subtitles || dialogueTrack.length === 0 || !dialogueTrack.some(t => t.start >= 160 && t.start <= 184)) {
    console.log('-> Injecting Mock Subtitles for target interval (160s-184s)');
    subtitles = `WEBVTT\n\n1\n00:02:40.000 --> 00:02:44.000\nYeah, he is Nolan.`;
    dialogueTrack = [
        { start: 160.0, end: 164.0, text: "Yeah, he is Nolan." }
    ];
}
```

**What to Mock:**
- Network-bound external API inputs where stable mock definitions can be injected to allow local execution of downstream parsing code.

**What NOT to Mock:**
- Local system command execution processes (like `ffmpeg`, `yt-dlp`, and `whisper-cli`) as their actual process exits and generated files are required for testing pipeline integrity.

## Fixtures and Factories

**Test Data:**
```typescript
// Declared inline inside test files to define configurations or input parameters
const promptConfigs = [
    { name: 'simple_ocr', path: path.join(__dirname, 'prompt_template_simple_ocr.txt') },
    { name: 'old', path: path.join(__dirname, 'prompt_template_old.txt') },
    { name: 'current', path: path.join(__dirname, 'prompt_template.txt') }
];

const resolutionConfigs = [
    { name: 'low', mediaResolution: 'MEDIA_RESOLUTION_LOW' },
    { name: 'high', mediaResolution: 'MEDIA_RESOLUTION_HIGH' }
];
```

**Location:**
- Stated inline inside individual test scripts (e.g., `test_matrix_runner.js`, `test_full_workflow.js`).

## Coverage

**Requirements:** None enforced

**View Coverage:**
```bash
# None configured
```

## Test Types

**Unit Tests:**
- Frontend: Single basic React component test (`App.test.js`) ensuring the component is correctly rendered and contains standard content.

**Integration Tests:**
- Backend: Large-scale workflow integration tests that download real YouTube video files, perform multi-step media parsing (FFmpeg keyframes, Whisper Speech-to-Text), communicate with external APIs (Google Cloud TTS, Gemini AI Vision), cache metadata inside SQLite database instances, and output performance logs or JSON analysis sheets.

**E2E Tests:**
- Not used

## Common Patterns

**Async Testing:**
```typescript
// Wrapping async process spawning in a Node Promise wrapper
function runProcess(cmd, args, ignoreSubErrors = false) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args);
        let stderr = '';
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('close', code => {
            if (code === 0 || ignoreSubErrors) {
                resolve();
            } else {
                reject(new Error(`${cmd} failed with code ${code}. Stderr: ${stderr}`));
            }
        });
    });
}
```

**Error Testing:**
```typescript
// try-catch block wrapping call executions and checking for specific errors
try {
    const result = await model.generateContent(prompt);
} catch (error) {
    console.error("Gemini API call failed:", error);
    if (error.message.includes("invalid API key")) {
        console.error("Please verify GOOGLE_API_KEY inside your .env file.");
    }
}
```

---

*Testing analysis: 2026-08-18*
