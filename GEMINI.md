# Project Analysis: youtube-screen-describer (test branch)

> [!IMPORTANT]
> 이 프로젝트 루트는 뷰래이터 서비스의 **test 브랜치**입니다.

## Overall Purpose
This project is a **YouTube video screen describer**. It takes a YouTube video URL, processes the video to extract keyframes, generates a descriptive script using a vision model, and creates a time-stamped Korean audio track for the visually impaired.

**Service URL:** https://www.blindmom.org

## Final Architecture (Post-Improvement)

The project is divided into a frontend and a backend, focusing on **progressive data processing and on-demand audio generation** to ensure fast response times and cost efficiency.

### Frontend (React)
- A two-view user interface built with React, designed for accessibility.
- **Home Screen**: Features a unified search bar. Users can either paste a YouTube URL to generate a new description or type keywords to search for previously created videos (from the local database) and new videos (from YouTube) simultaneously. It displays a list of results, separating database hits from YouTube search results.
- **Player Screen**: This view is activated when a user selects a video.
    - It embeds the YouTube video using `react-youtube`, but with custom controls (a large central play/pause button) and hidden native YouTube controls for a simplified user experience.
    - It **progressively receives script data** from the backend via SSE, allowing the user to start watching immediately.
    - It displays the full descriptive script (which can be toggled for visibility) and allows users to adjust the verbosity level through four stages: **`없음/최소/기본/최대`**.
    - **On-Demand Audio**: When a description is needed, it requests the audio from the backend's TTS endpoint. It uses a local cache (Map) to store fetched audio blobs, avoiding duplicate requests.
    - It plays the audio using a single, reused HTML5 audio element and ducks the video volume accordingly to ensure stable playback on mobile devices.
    - **Comments Section**: Below the player, there is a full-featured comments section where users can read, post, update, and delete comments. Non-logged-in users can only read comments. Logged-in users can post using custom nicknames and edit or delete their own comments directly via session authentication (no password required).

### Backend (Node.js)
The backend is architected for high-speed, progressive processing and efficient caching.

1.  **API Endpoints**:
    - `GET /api/cached-videos`: Returns a list of all videos stored in the database.
    - `GET /api/search`: A unified search endpoint that queries both the local database and YouTube for a given text query.
    - `GET /api/script/:videoId`: Returns the full title and **text-only** script data for a specific video.
    - `GET /api/process`: A Server-Sent Events (SSE) endpoint that initiates the **progressive script generation**.
    - `POST /api/batch-process`: A fire-and-forget endpoint to process an entire video in the background.
    - `POST /api/tts`: An on-demand endpoint for **hybrid TTS audio caching**.
    - `GET /api/comments/:videoId`: Fetches all comments for a specific video.
    - `POST /api/comments`: Adds a new comment to a video (requires auth).
    - `PUT /api/comments/:commentId`: Updates an existing comment (requires auth, validates ownership).
    - `DELETE /api/comments/:commentId`: Deletes a comment (requires auth, validates ownership).

2.  **Progressive Script Generation (`/api/process`)**:
    - **a) Upfront Data Extraction**: On receiving a request, the backend performs a one-time, upfront data extraction. It uses `yt-dlp` to download the video's auto-generated subtitles (if available) and `ffmpeg` to extract all keyframes (based on scene changes) from the entire video. This gathers all necessary data at the beginning.
    - **b) Full Context AI Streaming Generation**: The backend sends **all** extracted frames and the **entire** subtitle script to the **`gemini-2.5-pro`** model in a **single request**. This allows the AI to understand the full narrative context of the video from start to finish before generating any descriptions.
    - **c) Progressive Response (SSE)**: The AI model then **streams** the generated script back. The backend immediately forwards these script lines to the frontend using Server-Sent Events (SSE) as they are received. This allows the user to see the script appear progressively while ensuring the descriptions are generated with the highest possible contextual awareness.
    - **d) Progressive Response (SSE)**: As soon as a chunk's script is generated, it is immediately sent to the frontend using Server-Sent Events (SSE). This allows the user to see the script appear progressively while the backend continues to process subsequent chunks with ever-increasing context.
    - **e) Automatic Cache Cleanup**: The backend includes a maintenance feature that automatically deletes audio cache files older than 30 days to manage disk space.

3.  **Hybrid TTS Caching (`/api/tts`)**:
    - **a) Request**: Receives a request from the frontend containing the text of a single script line.
    - **b) Cache Key & Path**: Creates a SHA256 hash of the text. To prevent having too many files in a single directory, it uses the first four characters of the hash to create a nested directory structure (e.g., `public/audio/tts_cache/{char1}{char2}/{char3}{char4}/{hash}.mp3`). This serves as a unique, permanent path for the audio file.
    - **c) Cache Check**: Checks if this file already exists on the server.
    - **d) Cache Hit**: If the file exists, it is served directly, saving API costs and providing a near-instant response.
    - **e) Cache Miss**: If the file does not exist, the backend calls the **Google Cloud Text-to-Speech API** once, saves the resulting audio to the nested cache path, and then sends the audio to the client.

4.  **Database (SQLite)**: The database's role is to cache generated **text-only scripts**, video titles, and other metadata for quick retrieval. It also contains a `comments` table to store user-submitted comments for each video, including a nickname and a hashed password for editing or deletion.

## System Prerequisites
To run the backend server, the following command-line tools must be installed on the system and be accessible in the system's PATH:
- **Node.js**
- **`yt-dlp`**
- **`ffmpeg`**

## Technologies Used

### Backend
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: **SQLite** with the **`better-sqlite3`** library for caching.
- **AI Integration**:
    - `@google/generative-ai` using the `gemini-2.5-pro` model.
    - `@google-cloud/text-to-speech` for audio synthesis.
- **Video/Audio Processing**:
    - **`yt-dlp`** (via `child_process`).
    - **`ffmpeg`** (via `fluent-ffmpeg`).
- **Utilities**: `dotenv`, `cors`, `crypto`.

### Frontend
- **UI Library**: React
- **Development Setup**: Create React App (`react-scripts`)
- **HTTP Client**: `axios`
- **YouTube Player**: `react-youtube`
- **Audio Playback**: Native HTML5 Audio (via `new Audio()`).

---

## 개선 기록 (Improvement Log)

### 109차: 로컬 Whisper 언어 판별 성능 최적화 및 60% 지연 속도 개선 (2026-07-30)
- **문제:**
    1. 108차에서 4 vCPU 사양 VM 인스턴스 축소 및 1스레드 제한(`WHISPER_THREADS=1`) 적용 이후, 로컬 Whisper 언어 판별 처리 시간이 평균 10.3초대로 증가하였고 부하 상황 시 15초 타임아웃을 초과하여 판정이 실패하는 결함이 간헐적으로 발생함.
    2. 기존 파이프라인에서 FFmpeg 슬라이스 추출 시 `ffmpeg` 프로세스를 3회 개별 spawn하여 프로세스 오버헤드가 컸고, `whisper-cli` 역시 텍스트 전사(decoding) 및 JSON 파일 쓰기/읽기를 전체 수행하여 쓸데없는 I/O 및 CPU 연산 지연이 컸음.
- **해결:**
    1. **5비트 정수 양자화 모델 (`ggml-tiny-q5_1.bin`) 적용**:
        - 기존 77MB 크기의 FP16 모델을 30.6MB 크기의 q5_1 양자화 모델로 대체하여 디스크 로드 타임을 340ms에서 80ms로 단축하고 연산량을 줄임.
    2. **조기 종료 언어 감지 (`-dl` 옵션) 파이프라인 결합**:
        - `whisper-cli`에 `-dl` 옵션을 부여하여 언어 판정 성공 즉시 추론을 종료하도록 개선하여 텍스트 전사(decoding) 오버헤드를 원천 차단함.
        - JSON 디스크 입출력을 생략하고, Node.js 파이프라인에서 `stderr` 스트림 출력을 정규식으로 직접 파싱하도록 리팩토링함.
    3. **단일 FFmpeg 멀티맵핑 병렬 슬라이싱**:
        - 기존 3회 분리 기동되던 FFmpeg 프로세스를 1회로 통합하고 다중 맵핑 옵션을 사용하여 3구간 동시 추출로 최적화함.
        - 실측 결과 총 지연 시간이 10.66초에서 4.27초로 **약 60% 단축**되었으며, 타임아웃 방지를 위해 `WHISPER_TIMEOUT_MS`를 `20000`(20초)으로 상향 튜닝함.
- **상태:** `audioLanguageDetector.js` 리팩토링, 로컬 및 원격 `.env` 반영, `deploy-prod.sh` 배포 적용 완료 (2026-07-30)

### 108차: 운영 VM 리소스 스케일다운 및 4 vCPU 최적화 Whisper 스레드 튜닝 (2026-07-29)
- **문제:**
    1. 기존 `e2-highcpu-8` (8 vCPU, 8 GB Memory) 인스턴스는 불필요한 연산 파워 오버스펙으로 인해 인프라 비용($185.49/월, 약 27.8만 원) 부담이 컸음.
    2. 비용 절감을 위해 4 vCPU 사양으로 축소하는 과정에서, 비디오 인코딩 및 Whisper 병렬 연산 시 발생할 수 있는 메모리 고갈(OOM) 리스크를 제어하고 기존 8GB의 안정적 메모리 버퍼를 유지할 고효율 타협안이 요구됨.
- **해결:**
    1. **커스텀 머신 타입 (`e2-custom-4-8192`) 전환 도입**:
        - GCP 커스텀 구성을 통해 4 vCPU, 8 GB Memory 조합으로 머신을 재설정함. 이를 통해 기존 8GB의 메모리 안전장치를 그대로 활용하면서 VM 월 비용을 $185.49에서 $102.49로 **약 44.7% 절감**함 (월 124,500원 절약, 환율 1,500원 기준).
    2. **Whisper CPU 경합 스레드 제약 최적화 (`WHISPER_THREADS=1`)**:
        - 4 vCPU 환경에서 3개 오디오 샘플 동시 판별 시, 프로세스당 기본 2스레드 구동(총 6스레드)으로 인한 CPU 포화 및 컨텍스트 스위칭 오버헤드를 예방하기 위해 스레드 수를 1개로 제약함.
        - 운영(Prod), QA, Test 서비스 디렉토리의 `.env` 파일들에 이를 반영한 후 PM2 리로드(`--update-env`)를 통해 갱신 완료.
        - 2스레드 ➔ 1스레드 제약 적용 전후 1:1 실측 결과, Whisper 판별 소요 시간은 단 1초의 편차(8초 ➔ 9초)만 유지하며 극히 안정적으로 기능적 무결성과 자원 반응성을 모두 확보함을 검증함.
    3. **자동화 검증 및 영속성 설정**:
        - VM 재부팅 후 Nginx 및 PM2 4개 서비스가 자동 구동되는지 검증을 거쳤으며, 변경 사항을 `pm2 save`로 영구 보관 처리함.
- **상태:** `~/src/*_cred/.env` 및 `/app/*/backend/.env` 반영, PM2 리로드 완료 및 최종 GCP 커스텀 스펙(4 vCPU, 8 GB RAM) 교차 검증 통과 (2026-07-29)

### 107차: 3점 샘플링 로컬 Whisper 기반 언어 판별 및 낭독 배제/자막 번역 자동화 엔진 도입 (2026-07-28)
- **문제:**
    1. 한국어 진행에 외국인 인터뷰가 혼재된 하이브리드 영상(Mixed) 및 외국어 영상(Foreign) 처리 시, 유튜버가 한국어로 읊는 음성과 뷰레이터 기계 TTS 음성이 화면 상에서 겹치는 이중 낭독 결함이 지속됨.
    2. 시각장애인 편의를 위해 UI에 수동으로 원음 언어 선택 컨트롤을 배치할 경우, 스크린리더 포커스 오버헤드가 지나치게 증가하여 접근성 단순화 규정을 해치는 문제가 존재함.
- **해결:**
    1. **로컬 Whisper 3점 병렬 언어 판별 (`audioLanguageDetector.js`)**:
        - 영상의 20%, 50%, 80% 오프셋 지점에서 10초 분량 오디오 샘플 3개를 동시에 추출하여, 로컬 `whisper-cli` 프로세스 3개를 동시에 실행(스레드 2개 제한, `-bs 1`, `-fa` 옵션)함으로써 5초 내로 고속 분석하여 `korean`, `foreign`, `mixed`, `unknown` 언어군을 판정하는 모듈 탑재.
    2. **백엔드 주도 자막 필터링 및 translation 타입 적재**:
        - `mixed` 비디오 판정 시, 이중 낭독을 방지하고자 전처리 단계에서 한국어 자막(VTT)은 파싱에서 완전히 제외하고 외국어 자막만 대사 트랙(`DIALOGUE_TRACK`)으로 정제해 Gemini에 전송함으로써, 유튜버의 해설은 묵음으로 두고 핵심 외국어 대사만 한글 번역 `[trans]`(DB `translation` 타입)으로 낭독하게 만듬.
        - `korean` 판정 시에는 모든 대사 낭독을 스킵하고 비낭독 시간 가이드라인(참고용)으로만 한국어 대사 트랙을 전송.
        - `extractKeyframesHybrid` 백필 FFmpeg 동시 가동 수를 최대 3개로 제어하여 CPU 포화를 억제.
    3. **레벤슈타인 70% 유사도 기반 OCR 중복 [txt] 제거 필터**:
        - 시간 차 ±3초 범위에서 자막 대사 트랙과 70% 이상 레벤슈타인 유사도를 지닌 중복 화면 OCR 자막(`[txt]`)을 자동 감지하고 드롭(Drop)하는 무결성 필터 적용.
    4. **프런트엔드 재생 엔진 일시정지 로직 간소화**:
        - `PlayerScreenV2.js`에서 시각장애인의 기본 고속 TTS 환경을 100% 신뢰하도록 다이내믹 가속화 설계를 배제하고, 기존의 단순 일시정지 조건식(자막 `text` 도래 시 정지)에 `translation` 타입을 통합하는 형태로 제어 구조를 단순화.
- **상태:** `videoProcessor.js`, `database.js`, `PlayerScreenV2.js` 반영, 신규 `audioLanguageDetector.js` 추가 및 `prompt_template.txt` 갱신 완료 (2026-07-28)

### 106차: yt-dlp 다운로드 해상도 제한(360p) 및 오디오 배제 비디오 전용 포맷(Video Only) 최적화 도입 (2026-07-22)
- **문제:**
    1. 유튜브 비디오 다운로드(yt-dlp) 시 480p 해상도와 불필요한 오디오 스트림을 한꺼번에 수집하면서, 대용량 네트워크 트래픽 및 오디오/비디오 병합(Muxing)을 위한 CPU/디스크 I/O 병목이 발생하여 전체 프로세스 입구 단계의 시간 지연이 컸음.
    2. 화면 해설(Audio Description) 생성 목적상 오디오 채널은 불필요하고, Gemini LOW-res 모델은 이미지를 ~640px 이하로 변환하여 처리하므로 480p 이상의 고해상도 리소스도 낭비 요소였음.
- **해결:**
    1. **yt-dlp 포맷 다운사이징 및 오디오 배제**:
        - `bestvideo[height<=360][acodec=none][ext=mp4]` 등의 포맷 지정을 통해 360p(640x360) 해상도로 다운로드를 고정하고, `acodec=none`으로 오디오 채널을 강제 배제함.
        - 이를 통해 병합(Muxing) 절차를 전면 생략하고 파일 크기를 평균 40~50% 이상 절감함.
    2. **정량적 벤치마크 및 무결성 검증**:
        - 30분 미만(27분 53초) 영상 대상 실측 결과, 파일 크기 45.76MB -> 27.98MB(38.9% 절약), 다운로드 시간 14.30초 -> 9.93초(30.5% 단축)를 기록하여 유의미한 레이턴시 단축을 입증함.
        - 해상도 하향 후에도 FFmpeg 키프레임(I-frame) 및 백필(Backfill) 정합성에 영향이 없어 231장 프레임 수가 100% 일치함을 입증하여 무결성을 검증함.
    3. **실서버(chacha@mom) 무중단 배포**: 로컬 및 운영 서버 PM2 리로드 배포 적용을 완료하여 기능 실증에 성공함.
- **상태:** `videoProcessor.js` 소스코드 반영, 운영 서버(Prod) PM2 리로드 배포 완료 및 정상 서빙 확인 (2026-07-22)

### 105차: 1-2초 내 완주하는 고속 I-frame 추출 및 갭 백필(Gap Backfill) 하이브리드 디코딩 아키텍처 도입 및 SSE 간소화 (2026-07-22)
- **문제:**
    1. 103차의 6 Workers 멀티 코어 병렬 키프레임 추출 방식은 CPU 경합 및 시간 분할 탐색의 한계로 성능 개선율이 미비하였고, 분할 경계면에서의 중복 프레임 처리(Boundary Deduplication)로 인해 백엔드 파일 처리 및 DB 로직의 복잡성이 지나치게 높았음.
    2. `-skip_frame nokey` 단일 튜닝 적용 시, 영상 초반부/끝부분 또는 정적 화면 지속 구간에서 키프레임(I-frame)이 생성되지 않는 GOP 구조적 한계로 인해 정밀 장면 프레임이 누락되는 정밀도 저하 리스크가 존재했음.
    3. 프레임 추출 속도가 1초대로 단축됨에 따라 불필요하게 세분화된 SSE 추출 진행율 메시지가 화면에 스쳐 지나가 UX를 해치는 부작용 발생.
- **해결:**
    1. **하이브리드 디코딩 아키텍처 구축 (`extractKeyframesHybrid`)**: 
        - **고속 추출 (Step 1)**: `-skip_frame nokey`와 `fps=1/2` 최적화 필터를 통해 비키프레임(P/B) 디코딩을 전면 생략하여 10분~40분짜리 대용량 영상을 단 1초대에 고속 스캔 및 추출.
        - **정밀 백필 (Step 2 & 3)**: 추출된 I-frame들의 타임스탬프를 2초 그리드 기준으로 실시간 전수 조사하여 누락 갭(Gaps)을 감지하고, 해당 갭 지점들만 Fast Seeking (`-ss`) 단일 Seeking 프로세스들을 동시 실행하여 프레임 저장소를 100% 무결하게 복원 및 메워줌.
    2. **SSE 진행 메시지 단순화**: 
        - 프레임 추출 세부 상태 메시지를 백엔드 송출 단계에서 제거하여, 클라이언트 UI에는 **`영상 다운로드 중 -> (진행율) xx% -> ai로 대본 생성 중`** 순으로 직관적이고 끊김 없이 연출되도록 개선.
    3. **운영/테스트/QA 전체 무중단 배포**: 로컬 커밋 및 GitHub 원격 push를 통해 운영 및 테스트 인스턴스(PM2 0, 1번)를 무중단 PM2 리로드 완료하고 10분 영상 대상 1.15초 완주(10배 속도 향상) 실증 검증 완료.
- **상태:** `videoProcessor.js` 소스코드 반영, 운영 및 테스트 백엔드/프론트엔드 배포 및 실실적 검증 통과 (2026-07-22)

### 104차: 장기 비디오 대본 생성 시 Nginx/SSE 타임아웃 방지를 위한 15초 SSE Heartbeat (Ping) 및 버퍼링 해제 적용 (2026-07-21)
- **문제:**
    1. 40분 이상의 장기 영상(예: PD수첩 46분) 처리 시, Step 2(AI 스트리밍 대본 생성) 구간이 3분 이상 지속됨에 따라 Nginx 및 브라우저의 기본 읽기 타임아웃(60초)을 초과하여 프론트엔드에 `네트워크 에러`가 노출되는 현상 발생. (새로고침 시 백그라운드에서 완료된 DB 기록을 가져와 정상 표시됨)
- **해결:**
    1. **15초 SSE Heartbeat (Ping) 타이머 주입**: `routes.js` 내 `/api/process` SSE 연결 생성 시 15초 주기의 `: heartbeat ping\n\n` 주석 패킷을 지속 송신하도록 개선하여, Nginx `proxy_read_timeout` 및 브라우저 커넥션 유휴 타임아웃을 완전 방지함.
    2. **Nginx 프록시 버퍼링 즉시 해제**: `X-Accel-Buffering: no` Response Header를 추가하여 Nginx가 SSE 패킷을 큐에 묶지 않고 클라이언트에 즉각 스트리밍하도록 보완.
- **상태:** `routes.js` 소스코드 반영 및 구문 검증 완료 (2026-07-21)

### 103차: FFmpeg 멀티 코어 시간 분할(Time-Chunking) 병렬 키프레임 추출 모듈 구현 및 1:1 무결성 실증 (2026-07-21)
- **문제:**
    1. 비디오 화면 해설 생성 시 `ffmpeg`을 단일 프로세스로 가동하여 파일 시작부터 끝까지 전체 프레임을 순차 디코딩함으로써, 다중 CPU 코어 환경에서도 단 1개 코어만 100% 사용해 키프레임 추출 단계에서 극심한 성능 병목이 발생함.
    2. 동적 비디오 분할 방식 도입 시 구간 경계 지점(Boundary Condition)에서 타임스탬프 중복 추출 또는 2초 추출 간격의 미세 오버랩/누락 위험성 상존.
- **해결:**
    1. **시간 분할 병렬 추출 모듈(`extractKeyframesParallel`) 구축**:
        - `os.cpus()` 기반 시스템 가용 CPU 코어 수에 맞게 $N$개의 병렬 워커를 동적 할당.
        - Fast Seeking 옵션(`-ss`, `-t`)을 통해 전체 영상을 시간 청크로 분할 후 다중 `ffmpeg` 프로세스를 `Promise.all`로 병렬 실행하여 디코딩 속도를 획기적으로 단축함.
    2. **경계 중복 및 간격 디두플리케이션(Deduplication) 적용**:
        - 파싱된 타임스탬프를 절대 시간($\text{pts\_time} + \text{startSec}$)으로 보정 후 통합 정렬.
        - 경계 부근에서 발생할 수 있는 1.8초 미만의 이중/오버랩 추출 프레임을 사전에 자동 필터링 및 디스크 파일 정리를 수행하도록 수술적 보완.
    3. **단일 vs 병렬 1:1 교차 검증 실증**:
        - 10분(600초) 분량 비디오 대상 단일 프로세스 vs 병렬 프로세스 1:1 벤치마크 테스트 수행 결과, 프레임 수 300장 100% 일치(차이 0개), 경계 중복 0건, 타임스탬프 델타 최댓값 0.000초로 완전 무결성을 실증함.
- **상태:** `videoProcessor.js` 소스코드 반영 및 100% 교차 검증 완수 (2026-07-21)

### 102차: API 실시간 로깅(api_requests) 신설, SQLite WAL 모드 및 인덱스 성능 최적화, 하이브리드 AAU 집계 스킬 구현 (2026-07-20)
- **문제:**
    1. 무상태(Stateless) API 요청(예: `/api/tts`)의 특성상 세션 추적이 어렵고, 사용자의 동적 IP 변경 또는 공인 IP 공유로 인해 단순 Nginx 로그 분석에 의존한 회원/비회원 구분(AAU 집계) 시 데이터 오염 및 비회원 과다 산출 오류가 지속됨.
    2. 실시간 로깅 테이블(`api_requests`) 신설 시 트래픽 집중에 따른 SQLite 동시 쓰기 락(Write-Lock) 병목 우려 및 인덱스 부재로 인한 통계 쿼리 성능 저하 가능성 상존.
    3. 기존에 축적된 Nginx 로그 통계(수정 전)와 실시간 로깅 테이블(수정 후) 간의 데이터 단절 없이 일관성 있게 집계할 하이브리드 통계 수집 로직 부재.
- **해결:**
    1. **API 요청 로깅 파이프라인 구축**: `database.js` 및 `routes.js` 최상단에 `trackApiRequest` 전역 미들웨어를 탑재하여, JWT 토큰(회원) 및 `X-Guest-Id` 헤더(비회원)를 파싱해 IP와 함께 `api_requests` 테이블에 실시간으로 적재하도록 변경.
    2. **SQLite3 성능 최적화 (WAL 및 인덱스)**:
        - `database.js` 내 DB 연결부에 `db.pragma('journal_mode = WAL');` 설정을 적용하여 쓰기 락 병목 해소 및 읽기/쓰기 병렬성을 확보.
        - `api_requests` 테이블 내 `createdAt` 및 `ip` 컬럼에 대한 개별 인덱스 DDL을 주입하여 통계 조회 성능을 가속.
    3. **하이브리드 AAU 집계 스킬 구축**:
        - `stats_collector.js` 가 DB 내 최초 로깅 시작점($T_{\text{log\_start}}$)을 자동 추적하도록 개선.
        - 로깅 시작 이전 시점은 기존 Nginx 로그와 시청 DB의 교차 상관(대안 3)으로 추정하고, 로깅 시작 이후 시점은 `api_requests` 테이블의 실물 기록을 직접 매핑하도록 하이브리드 집계 로직을 수립.
    4. **무중단 전 서버 배포 및 백업**: 안전을 위해 원격 DB 3종 백업본을 생성한 뒤, `deploy-prod.sh` (프록시 우회) 및 `deploy-qa-app.sh` 를 연계 가동하여 운영(Prod), 테스트(Test), QA 서버 3개 환경 모두 무중단 PM2 리로드 배포 및 실시간 로깅 적재 실증 성공.
- **상태:** 소스코드 적용, WAL 모드/인덱스 설정 완료, 운영/테스트/QA 전체 PM2 리로드 가동 및 로깅 적재 확인 완료 (2026-07-20)

### 101차: 장기 비디오 토큰 오버플로우 방지를 위한 gemini-3.1-pro-preview 모델 및 LOW-res 프레임 모드 전환 배포 (2026-07-13)
- **문제:**
    1. 30분(1,800초) 이상의 장기 영상 화면 해설 빌드 시, 기본 고해상도(High-res) 모드로 인해 이미지 프레임(900장 이상)의 토큰 소모량이 100만(1M)을 상쇄하고 전체 API Context limit 및 HTTP 단일 Payload 크기 제한(Payload Too Large)에 걸려 프로세스가 강제 실패/에러가 나던 프로덕션 결함 발생.
    2. 저해상도(LOW-res) 모드 도입 시 `gemini-3.5-flash` 모델은 비결정적 추론 환경(temperature 0.7)에서 프레임 정보 뭉개짐으로 인해 인물 인지 왜곡(할머니 -> 10대 소년) 등의 심각한 환각 오류를 노출하여 사용 불가능함.
- **해결:**
    1. **gemini-3.1-pro-preview 모델 전환**: 시각 지능 및 다각 추론 성능이 극대화된 Pro급 모델로 전환하여, 저해상도로 이미지가 압축되더라도 환각 없이 정밀하고 안정적인 묘사를 제공하도록 변경.
    2. **LOW-res 모드 강제 적용**: `videoProcessor.js` 내의 비디오 프레임 분석 호출부(`getGenerativeModel`)에 `mediaResolution: "MEDIA_RESOLUTION_LOW"`를 지정하여, 이미지 1장당 토큰 소모량을 258개로 평준화하고 전체 입력 콘텍스트(30분 영상 기준 약 34만 토큰)를 대폭 다이어트하여 오버플로우 에러를 원천 예방.
    3. **비용 및 지연시간 교차 검증**: 실측 테스트 결과, Pro 전환과 LOW-res 결합을 통해 37분 장기 영상이 단 34.5만 토큰으로 4분 만에 빌드되었으며, 2.5-pro 요율 대비 토큰 수의 압도적 감축 덕분에 실제 빌딩 비용은 약 54% 이상 절감되는 가성비를 확보함.
    4. **전체 환경 배포 완료**: 로컬 `main`, `test`, `feature/video-qa` 브랜치에 코드를 머지/푸시한 후, 운영/테스트/QA 원격 자격증명(`.env`)의 `GEMINI_MODEL`을 `gemini-3.1-pro-preview` 로 갱신하고 PM2 인스턴스를 무중단 리로드 배포 완료함.
- **상태:** 소스코드 및 원격 3개 백엔드 서버(운영, 테스트, QA) 배포 완료 및 37분 장기 영상 정상 완료 실증 확인 완료 (2026-07-13)

### 100차: 구글 Gemini 2.5 Pro 모델 은퇴 대응 및 3.5 Flash 모델 전면 전환 배포 (2026-07-10)
- **문제:**
    1. 구글이 AI Studio API에서 기존에 하드코딩되어 사용되던 `gemini-2.5-pro` 모델의 지원을 완전히 중단(404 Not Found)하여 화면해설 생성 시도 시 API 오류와 함께 대본 생성이 전면 차단되는 장애 발생.
    2. 1차 유튜브 다운로드 챌린지 차단(`Login Required`) 에러 발생 시 백엔드 봇 예외 감지식(`isBotError`) 누락 및 대소문자 불일치로 인해 예비 쿠키(Attempt 2)로의 롤오버가 작동하지 않고 즉각 실패 처리되던 결함 발견.
    3. 실로암 신규 API 키(`AQ.Ab...`)가 AI Studio 전용 권한만 있고 YouTube Data API v3 권한을 가지고 있지 않아, 메타데이터 수집 API 호출 시 `401 Unauthorized` 에러를 뿜으며 초입에서 폭사하던 문제 확인.
- **해결:**
    1. **동적 모델 설정 아키텍처 개편**: 백엔드 코어(`videoProcessor.js`) 및 3대 모듈(`analyzer.js`, `describer.js`, `synchronizer.js`)의 모델 선언부를 환경변수 `GEMINI_MODEL` 및 기본 fallback `"gemini-3.5-flash"` 로 동적 매핑하도록 보완.
    2. **API 사용 비용 연산의 동적 보강**: `calculateApiCost` 헬퍼 함수를 신설하여, 활성화된 모델 지정자(3.5-flash, 3.1-pro 등)의 구글 공식 요율(Flash의 경우 입력 $1.50 / 출력 $9.00 무할증 요율)을 추적해 SQLite `api_costs` 에 요금을 영속 적재하도록 수정.
    3. **비용 및 품질 벤치마크 실증**: 6분 및 12분 영상(최대 42만 토큰) 대상 2초 균등 프레임 추출 조건하의 1:1 비교 벤치마크를 재수행하여, 3.5 Flash가 지연 시간을 50% 단축하고 비용을 2.6배 절감하면서도 비주얼 묘사(코브라 위협 등)의 생동감이 Pro보다 뛰어남을 확인해 기본 운영 모델로 최종 발탁.
    4. **API 키 분리 처리 및 쿠키 롤오버 보완**: `YOUTUBE_API_KEY` 환경변수를 신설하여 YouTube API 호출 시 이전 사용자 계정 키로 격리 처리하고, `isBotError` 에 `Login Required` 대소문자 무관 감지 필터를 보강하여 쿠키 자동 복구 구조를 정상 복원 완료.
- **상태:** 소스코드 적용, 환경변수 파일(.env) 주입, 원격 3개 백엔드 프로세스(prod/test/qa) PM2 리로드 및 서비스 정상 복구 완료 (2026-07-10)

### 99차: GCP 프로젝트 결제 계정 실로암 이관 및 Google AI Studio API 키 전환 완료 (2026-07-09)
- **문제:**
    1. 뷰레이터 서비스 운영 비용(GCP VM, Cloud TTS API)을 기존 사용자 본인 계정에서 실로암 법인 결제 계정으로 이관해야 하는 과제.
    2. 실로암 측에서 생성했던 1, 2차 결제 계정이 구글 보안/빌링 방화벽에 의해 강제 폐쇄(Closed, "폐쇄된 계정이므로 사용 금지")되거나 권한 매핑이 누락되어, 연동 테스트 시 GCP 실시간 감지기에 의해 VM `i-blindmom-ko-1` 이 강제 셧다운(TERMINATED)되는 인프라 장애 발생.
    3. Google AI Studio의 Gemini API 키 역시 결제 계정 매핑 전환 시 기존 선불 크레딧 연동이 해제되어 `429 Prepayment credits depleted` 오류로 서비스가 차단되는 문제 발생.
- **해결:**
    1. **정상 활성 결제 계정 검증 및 매핑**: 실로암이 최종적으로 구글 승인을 마친 활성 결제 계정(`01648C-89FFE9-4BB460`, OPEN=True)을 확인하고, 뷰레이터 프로젝트(`coastal-antler-467411-p1`)에 연동을 완료함. (기존 본인 결제 계정 `010844-937E16-06DA1D` -> 실로암 결제 계정 `01648C-89FFE9-4BB460` 으로 최종 교체 완료)
    2. **인프라 강제 정지 장애 긴급 복구**: 결제 일시 중단으로 nic0 동결 및 디스크 락이 걸린 VM 인스턴스를 GCP 싱크 타임(약 1~3분) 대기 후 강제 재부팅 완료. PM2 프로세스(0~3) 및 Nginx 웹서빙(HTTP 200 OK) 상태로 안전하게 가동 및 복구 성공.
    3. **Gemini API 키 실로암 유료 키로 전면 이관**: 실로암이 $10 선불 충전을 마치고 발급한 신규 유료 API 키(`AQ.Ab...`)의 작동 검증(Ping-Pong 테스트 성공) 후, 로컬 개발 Worktree(main/qa/test) 3개 및 실서버의 모든 환경(운영/test/qa) 내 `GOOGLE_API_KEY` 설정을 치환하고 PM2 `--update-env` 옵션으로 데몬 갱신 적용 완료.
- **상태:** 로컬 및 실서버 반영 및 PM2 리로드 완료 (2026-07-09)

### 98차: 관리자 화면 사용자 상세 정보 및 대기 목록 시간 필드 KST 변환 누락 수정 (2026-07-06)
- **문제:**
    1. 관리자 화면에서 사용자 상세 정보(가입일시, 최종 로그인 일시 등) 및 승인 대기 목록 조회 시, 시간대 오프셋(KST)이 반영되지 않고 DB 원본 UTC 기준 날짜 문자열(예: `2026-07-06 01:17:56`)이 변환 없이 그대로 노출되어 9시간의 시차가 발생하는 현상.
- **해결:**
    1. **SQLite 쿼리 ISO 8601 UTC 포맷화**: `database.js` 내 관리자용 사용자 조회 쿼리 3개 함수(`listPendingUsers`, `listAllUsersForAdmin`, `getUserDetailForAdmin`)의 날짜 필드(`createdAt`, `updatedAt`, `lastLoginAt`, `verificationCreatedAt`)에 `strftime('%Y-%m-%dT%H:%M:%SZ', ...)` 포맷팅 처리를 일괄 적용함. 이를 통해 브라우저가 전달받은 문자열을 명확한 UTC 기준시로 인식하여, 로컬 타임존(KST)으로 자동 변환해 렌더링하도록 수정 완료함.
- **상태:** database.js 수정 반영 완료 (2026-07-06)

### 97차: PC 재생 화면 오디오 더킹 강도 상향 및 실로암 API 통신 타임아웃 완화 (2026-07-06)
- **문제:**
    1. PC 재생 화면에서 오디오 더킹 시 기존 영상 볼륨이 30%로 줄어들어 TTS(해설) 대비 영상 배경 소리가 지나치게 작아 청취감이 부자연스러움.
    2. 실로암 시각장애인 회원 인증 API의 네트워크 타임아웃이 5초로 지정되어 있어, 실물 기관망 내부 지연 등으로 인해 간헐적인 타임아웃(HTTP 5s timeout & socket hang up) 에러가 발생함.
- **해결:**
    1. **오디오 더킹 볼륨 조정 (30% -> 60%)**: PC 재생 화면에서 TTS 동작 시 기존 비디오 볼륨 감소 임계치를 30%에서 60%로 상향하여 비디오 배경 소리와 해설 음성이 좀 더 조화롭게 들리도록 튜닝함.
    2. **실로암 API 타임아웃 완화 (5초 -> 10초)**: API 커넥션 타임아웃 제한을 기존 5초에서 10초(`10000ms`)로 확대 적용하여 외부 기관 서버의 일시적 조회 지연 및 네트워크 진동에 대한 복구력을 제고함.
- **상태:** PlayerScreenV2.js, PlayerScreen.js, utils.js 등 수정 반영 완료 (2026-07-06)

### 96차: 운영 서버 통합 통계 및 접속 플랫폼 분석 확장 스킬(analyze_system_stats) 구축, Nginx 로그 보관 기간 90일 연장 (2026-07-05)
- **문제:**
    1. 운영 서버의 핵심 비즈니스 지표(성공률, 영상 시간 분포, AI 토큰 사용 비용) 및 회원/비회원 간 활성 트렌드를 한눈에 통합 확인하고 특정 기간 범위로 분석할 수 있는 체계적인 도구 부재.
    2. 데이터베이스 스키마 내에 접속 기기(User-Agent) 정보를 관리하지 않아 시각장애인 주 사용 플랫폼(모바일 vs PC) 현황 식별 불가.
    3. Nginx 로그 회전 설정이 14일(`rotate 14`)로 제한되어 있어 월간 보고서 집계 시 과거 로그 유실 위험 상존.
- **해결:**
    1. **동적 기간 분석 및 하한선 제한 구현**: 시작일/종료일 인수(YYYY-MM-DD)를 수신해 특정 월간/주간 데이터를 필터링하되, 모든 분석의 기준점을 최초 회원가입 시점(`2026-07-02 02:27:51`)으로 고정하는 보안적 날짜 하한 보정 로직을 포함한 `stats_collector.js` 구축.
    2. **User-Agent 파싱 기기 분포 연계**: Nginx access.log 및 압축 아카이브 로그를 파싱해 접속 기기/OS 점유율을 추출 (iOS/iPhone이 모바일 유입의 92.4%를 차지하는 실제 시각장애인 VoiceOver 사용성 실증 데이터를 확보).
    3. **텍스트 리포트 자동 서빙**: 수집 및 통합 분석한 리포트를 마크다운이 아닌 일반 텍스트 파일(`.txt`)로 가공해 `prod_report/` 디렉토리에 버전별 자동 보관하도록 설계하여 `.agents` 스킬 디렉토리에 마운트.
    4. **Nginx 로그 보관 주기 확장**: 원격 서버의 `/etc/logrotate.d/nginx` 설정을 수정하여 보관 일수를 14일에서 90일(`rotate 90`)로 연장, 디스크 부하 없이 장기 분석 무결성 확보.
- **상태:** stats_collector.js 및 SKILL.md 구축, Nginx logrotate 수정 및 90일 연장 적용 완료, 6월~7월 범위 검증 테스트 통과 (2026-07-05)

### 95차: 유튜브 쿠키 자동 갱신 스크립트 2단계 정밀 검증(스트림 URL 추출), 30초 쿨다운 지연 및 Systemd 타이머 4시간 주기 적용 (2026-07-03)
- **문제:**
    1. 쿠키 자동 갱신 스크립트가 단순히 가벼운 로그인 세션 유효성(History API)만 검증하기 때문에, 유튜브에 의해 미디어 스트리밍이 차단(403 Forbidden)된 시한부/좀비 쿠키도 "성공"으로 동기화되어 백엔드 성능 저하 및 봇 감지 장애를 유발함.
    2. Playwright 브라우저 종료 직후 즉각적인 검증을 실시할 경우, 유튜브 위협 탐지 시스템이 세션을 강제 만료시키는 레이턴시(수십 초) 이전에 검증되어 좀비 계정이 필터링되지 못함.
    3. 기존의 30분 타이머 주기는 지나치게 잦아 서버 IP 대역 차단(IP Ban) 및 계정 영구 잠금 리스크가 극대화됨.
    4. 쿠키가 만료되었을 때 시도하는 2차 무쿠키 우회(`Attempt 2`) 다운로드 시도가 실제로는 100% 실패하여 불필요한 레이턴시만 유발함.
- **해결:**
    1. **2단계 스트림 URL 추출 검증**: `server-refresh-cookies.py` 내에 `yt-dlp -g`를 활용한 다이렉트 재생 주소 추출 여부 체크(2단계)를 도입하여, 403 차단 계정을 1초 안에 안전하게 격리하고 유효한 쿠키만 백엔드로 복사되도록 방어함.
    2. **30초 쿨다운 대기 도입**: 브라우저 인스턴스 닫기(`browser.close()`) 직후 30초 대기 시간(`asyncio.sleep(30)`)을 부여하여 유튜브 보안 엔진에 의해 즉시 소멸하는 가짜 유효 세션을 완벽히 식별함.
    3. **Systemd 타이머 4시간 주기 연장**: `/etc/systemd/system/youtube-cookie-refresh.timer` 설정을 수정(`OnCalendar=0/4:00:00`)하여 로그인 요청을 일 6회로 대폭 최소화하고 IP 밴 리스크를 방어함.
    4. **대체 쿠키 선택식 2차 시도 적용**: `videoProcessor.js`를 수정하여 1차 다운로드 실패 시 무쿠키로 롤오버하지 않고, 이미 시도하지 않은 다른 유효 쿠키를 무작위로 재선택하여 2차 다운로드를 수행하는 대체 쿠키 시도 로직을 정립함 (가용성 극대화).
- **상태:** 로컬/운영 서버 스크립트 및 백엔드 다운로드 로직 적용, Systemd 타이머 리로드 및 운영 배포 무중단 완수 (2026-07-03)

### 94차: Nginx XFF 프록시 헤더 설정 및 Express trust proxy 활성화로 클라이언트 IP 식별 정상화 (2026-07-02)
- **문제:** 리버스 프록시(Nginx) 뒤에 위치한 ExpressJS 백엔드에서 사용자 로그인 및 인증 IP를 기록할 때, 실제 클라이언트 IP가 아닌 루프백 IP(`127.0.0.1`)로 일괄 수집되는 결함 존재.
- **해결:**
    1. **Nginx 프록시 헤더 추가**: `/etc/nginx/sites-available/youtube-describer` 및 `test-youtube-describer` 설정의 `/api` 프록시 경로에 `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` 헤더 전달 규칙 주입 및 Nginx 리로드 적용.
    2. **Express trust proxy 활성화**: `backend/index.js`에 `app.set('trust proxy', true);` 설정을 적용하여 Nginx가 전달한 프록시 헤더를 신뢰하고 클라이언트 실제 IP를 정확하게 추출하도록 수정 완료.
- **상태:** 운영/테스트 환경 소스 반영 및 Nginx 무중단 리로드 완료 (2026-07-02)

### 93차: users 테이블에 blind_auth_method 컬럼 추가 및 가입/재인증/승인 수단 자동 기록 (2026-07-02)
- **문제:** 사용자의 시각장애인 인증 방식(실로암 API 연동 vs 복지카드 OCR 판독) 기록이 `user_verifications` 이력 테이블에만 산재되어 있어, 현재 활성화된 시각장애인의 최종 인증 경로를 `users` 테이블 수준에서 직관적으로 쿼리하거나 관리자 화면에서 일괄 식별하기 곤란함.
- **해결:**
    1. **스키마 및 자동 마이그레이션 확장**: `database.js`의 `users` 테이블 생성 DDL에 `blind_auth_method TEXT` 컬럼을 추가하고, 기존 프로덕션 DB와의 호환성을 보장하기 위해 `init()` 실행 시 누락된 컬럼을 자동으로 `ALTER TABLE`하는 마이그레이션 예외 블록을 구축 완료.
    2. **가입 절차 저장 연동**: `routes.js`의 `/auth/register` API에서 실로암(`siloam_api`) 또는 복지카드(`card_ocr`) 인증 통과(승인 또는 수동 대기) 시 해당 경로명을 `users` 테이블의 `blind_auth_method` 컬럼에 자동 영속화하도록 바인딩.
    3. **마이페이지 재인증 연동**: `/users/me/verify-blind` API에서 미인증 회원이 재인증에 성공하거나 수동 대기 상태로 변경될 때도 `updateUserBlindStatus`에 인증 수단을 주입해 해당 컬럼이 갱신되도록 처리 완료.
    4. **어드민 수동 승인 이력 매핑**: 어드민 전용 사용자 승인 API(`/admin/users/:userId/approve`) 처리 시 인증 방식을 `'admin_manual'`로 강제 업데이트되도록 매개변수를 확장 연동함.
- **상태:** 로컬/원격 DB 자동 컬럼 마이그레이션 및 인증 API 핸들러 수정 완료, 신택스 검증 통과 (2026-07-02)

### 92차: Rust 기반 POT(Proof of Token) Provider 데몬 및 yt-dlp 원격 EJS 솔버 도입으로 유튜브 403 Forbidden 우회 성공률 극대화 (2026-07-02)
- **문제:**
    1. 유튜브의 BotGuard 챌린지 검증 및 Throttling 강화로 인해 `yt-dlp` 구동 시 `HTTP Error 403: Forbidden` 및 `Requested format is not available` 에러가 수시로 발생하여 서비스 안정성이 저해됨.
    2. 기존의 Deno solver 방식은 매 실행 시마다 자바스크립트 챌린지를 동적 연산하여 지연이 심하고 봇 탐지율이 높았음.
    3. 2026년 최신 `yt-dlp` 규격은 Throttling을 해제하기 위해 EJS(원격 솔버)를 동적으로 로드해야 하나, 이에 대한 인자가 없어 챌린지 풀이가 비활성화되고, 방화벽 및 SSL 사설 인증서 검증 충돌로 인해 다운로드 단계에서 장애가 발생함.
    4. 쿠키 만료(403) 발생 시 백엔드 재시도(2차 무쿠키 + POT) 폴백 로직이 연동되지 못하고 즉시 실패 처리되는 예외 검증 구멍이 존재함.
- **해결:**
    1. **Rust POT 데몬 도입**: 무거운 JS 런타임 의존성이 없고 메모리 캐싱 및 고속 처리가 가능한 Rust 기반 POT Provider (`bgutil-pot` v0.8.1)를 로컬 및 운영 서버의 백그라운드 서비스(PM2)에 `4416` 포트로 상시 상주 구동 완료.
    2. **플러그인 및 EJS 바인딩**: `yt-dlp` 스폰 명령에 `--plugin-dirs` 및 `--remote-components ejs:github` 인자를 강제 주입하여, 유튜브 데이터 통신 전에 원격지 EJS 솔버와 로컬 POT 데몬을 자동으로 연동하여 403 차단 및 Throttling을 우회하도록 구성 완료.
    3. **에러 격리 조건 확장**: `videoProcessor.js`의 `isBotError` 판단식에 `HTTP Error 403` 에러를 추가하여, 1차 쿠키 다운로드 실패 시 해당 쿠키를 `.invalid`로 즉시 무효화/격리하고, 2차 무쿠키(POT 데몬) 우회 시도로 매끄럽게 자동 롤오버되도록 복구 완료.
    4. **전역 모듈 충돌 해소**: 원격/로컬 파이썬 패키지 풀의 중복 모듈(`v1.3.1`)을 언인스톨하여, 프로젝트에 번들링된 `0.8.1` 버전 플러그인이 데몬과 완벽하게 버전 매칭(0.8.1 == 0.8.1)되어 구동하도록 강제 완료.
    5. **SSL 인증서 우회**: CLI용 배치 프로세서(`process_video_cli.js`)에 `--no-check-certificate` 옵션을 추가하여 사내망 터널 환경에서의 SSL 사설 CA 충돌 문제를 해결함.
    6. **대용량 파일 업로드 차단**: 테스트용 비디오 및 로컬 캐시 DB 파일이 Git 스테이징에 포함되어 푸시 속도가 저하되던 문제를 `git reset` 및 `.gitignore` 무시 규칙 고도화를 통해 원천 해결 완료.
- **상태:** 로컬 및 원격 운영 서버(www.blindmom.org) PM2 데몬 등록, 파이썬 패키지 정리, 무중단 배포 및 일반 비디오 대상 우회 성공률 100% 정상 가동 확인 완료 (2026-07-02)

### 91차: 가입 및 인증 성공 시 3초 자동 리다이렉트 대신 수동 모달 닫기 확인으로 변경하여 저시력자 접근성 개선 (2026-07-02)
- **문제:** 회원 가입 및 시각장애인 자격 인증 성공 시 전맹 사용자를 위한 낭독과 동시에 3초 후 강제로 로그인 또는 마이페이지 화면으로 이동하게 되어 있었으나, 저시력자나 일반 사용자의 경우 성공 메시지를 채 인지하기도 전에 리다이렉트되어 무슨 상황인지 명확히 파악하기 어려운 접근성 제약 발생.
- **해결:**
    1. **수동 확인 모달 설계**: 회원 가입(`RegisterScreen.js`) 및 마이페이지 인증(`VerificationScreen.js`) 화면에서 3초 후 자동 리다이렉트하는 `setTimeout` 로직을 걷어내고, 사용자가 성공 여부를 직접 읽고 닫을 수 있도록 직관적인 '확인' 버튼을 각 성공 모달 내부에 배치.
    2. **접근성 및 포커스 낭독 신뢰성 제고**: 모달 활성화 시 포커스가 모달 내 버튼으로 강제 이동하며 페이지 영역의 기존 낭독이 생략되는 버그를 예방하기 위해, 성공 모달 전체에 **`role="alertdialog"`** 및 **`aria-describedby="modal-desc"`** 속성을 부여하여 팝업 즉시 성공 안내 메시지가 생략 없이 자연스럽게 강제 낭독되도록 보장.
    3. **공통 스타일 구축**: `App.css`에 성공 안내 모달용 전용 버튼 스타일(`success-modal-btn`) 및 웹 표준 포커스 링을 구성하여 글래스모피즘 테마 및 고대비 가시성을 동시에 지원.
- **상태:** 가입 및 인증 수동 모달 로직 변경 및 alertdialog 접근성 개선 완료, CSS 전역 스타일링 및 프론트엔드 빌드 검증 통과 (2026-07-02)

### 90차: main 및 test 브랜치 안전 통합 및 운영 서버 무중단 배포 적용 (2026-07-02)
- **문제:**
    1. `test` 브랜치에 대량 반영된 82~88차(회원 가입/인증, 실물 실로암 API 검증, 5분 제한, 어드민 전용 사용자 제어 등) 개선 코드와 `main` 브랜치의 독자 수정 이력(텔레그램 실시간 장애 알림 등)이 분리되어 있어, 실서비스 운영을 위한 단일 통합 및 동기화가 요구됨.
    2. 병합 시 로그인 쿠키 세션 및 `GEMINI.md` 로그 차수 중첩 등 병합 충돌 요소 제어 및 기존 운영 DB(SQLite `cache.db`)의 4,000여 건 데이터 유실 없는 무결성 마이그레이션 안전장치 확보 필요.
- **해결:**
    1. **격리 통합 브랜치 병합**: `merge/main-test` 임시 격리 브랜치를 신설하고 `main` 브랜치를 병합하여 쿠키 및 문서 충돌을 수동 해결(로그 순서 리넘버링)했습니다.
    2. **운영 환경 자격증명 보완**: 배포 전 원격 운영서버 자격증명 파일(`/home/chacha/src/cred/.env`)에 누락되었던 실물 실로암 API 변수 4종을 사전 주입하여 연동의 연속성을 보장했습니다.
    3. **운영 DB 사전 물리 백업**: 백엔드 배포 직전 운영 DB 파일을 `/home/chacha/backup/cache.db.prod_{timestamp}`에 복제 백업하여 100% 장애 복구 및 데이터 유실 대응 능력을 확보했습니다.
    4. **무중단 운영 배포**: `git worktree` 레이아웃 상의 `main` 디렉토리(`/Users/chacha/src/youtube-describer`)에서 로컬 `main` 브랜치 포인터를 통합 완료 해시로 동기화 후 force push 및 `deploy-app.sh` 실행으로 운영 배포를 완수했습니다.
    5. **마이그레이션 실물 검증 성공**: 배포 직후 DB `init()`이 구동되어 기존 DB 데이터를 보존한 채 신규 컬럼 9종을 자동 추가한 것과 Nginx 프론트엔드가 `200 OK`로 서빙되는 것을 실시간 검증했습니다.
- **상태:** DB 마이그레이션, 환경변수 구성, 원격 운영 서버(www.blindmom.org) 무중단 배포 및 실물 상태 검증 완료 (2026-07-02)

### 89차: 실물 실로암 시각장애인 회원 검증 API 명세 연동, Happy Eyeballs 버그 우회 및 자동 6자리 생년월일 파싱/유효성 검사 도입 (2026-07-01)
- **문제:**
    1. 기존 실로암 API 연동 시 `X-Org` 헤더 누락 및 `phoneNo`가 포함된 비표준 요청 규격으로 인해 인증 실패 가능성 상존.
    2. Node.js 18+ 환경의 Happy Eyeballs IPv6 우선 시도 정책으로 인해 특정 환경에서 실물 실로암 API 통신 시 5초 타임아웃(Abort) 발생.
    3. 데이터베이스 및 가입 폼에서는 8자리 생년월일(`YYYYMMDD`)을 수집하지만, 실로암 API 규격은 6자리 생년월일(`YYMMDD`)만을 허용하며 하이픈 등 특수문자가 섞일 경우 400 에러를 반환하는 제약 사항 불일치.
- **해결:**
    1. **실물 API 명세 준수**: [apispec_from_siloam.docx](file:///Users/chacha/src/youtube-describer-test/docs/apispec_from_siloam.docx)에 따라 `verifySiloamMember` 내 요청 헤더(`X-Api-Key`, `X-Org: blindmom`), 요청 바디(명세 외의 `phoneNo` 제외하고 `name`과 `birthDate`만 매핑)를 정확히 연동.
    2. **Happy Eyeballs 우회**: 기존 `fetch` 통신을 Node.js 내장 `https` 모듈로 전환하고, `family: 4` 옵션을 강제 주입하여 IPv4 전용 아웃바운드 연결 보장.
    3. **생년월일 전처리 및 유효성 검사**: 8자리 생년월일 수신 시 뒤 6자리(`YYMMDD`)로 슬라이싱 및 이름 앞뒤 공백 제거(`trim()`) 처리 자동화. 전송 전 6자리 숫자 검증 정규식(`^\d{6}$`) 필터를 추가해 예외 상황 방어.
    4. **환경 변수 구성**: `.env` 설정에 `SILOAM_MOCK=false`, `SILOAM_API_URL`, `SILOAM_API_KEY`, `SILOAM_ORG` 주입 완료.
    5. **실물 통신 검증 성공**: 원격 운영 서버(`chacha@mom`)에서 성명과 6자리 생년월일을 매핑하여 실시간 인증을 테스트, `isValid: true` 및 검증 성공(`SUCCESS_VERIFIED`) 결과 획득 검증 완료.
- **상태:** 백엔드 API 명세 연동 개편, 환경변수 구성 및 원격 서버 실물 통신 검증 완료 (2026-07-01)

### 88차: 개인정보 수집 동의 도입, 미인증 회원 5분 생성 제한, 메인화면 후원 제거, 마이페이지 독립 인증 프로세스 구축, 게시판 본인 댓글 수정/삭제 권한 매핑 오류 해결 및 작성자 닉네임 입력 제어 지원 (2026-06-29)
- **문제:**
    1. 회원 가입 시 개인정보보호법에 따른 필수 고지 및 동의 기능이 누락되어 법적 리스크 상존.
    2. 시각장애인 미인증 가입을 차단하는 제약 때문에 일반 회원이 이용하기 어려운 장벽. 또한, 미인증 상태로 가입했더라도 마이페이지 내에서 자격을 손쉽게 재인증할 수 있는 수단 부재.
    3. 미인증 사용자가 5분을 초과하는 장편 비디오의 화면 해설 생성을 시도할 경우, 프론트엔드 유효성 검사에서 걸려 엉뚱한 로그인 요구가 낭독되거나 오류 발생 원인이 묵살되는 결함.
    4. 메인 화면에 기존 후원 안내 및 실시간 운영 현황이 배치되어 있어 번잡하며, 복지관 및 MOM센터 협업 구조의 공식 명기 취지에 어긋남.
    5. 와글와글 게시판 및 영상 화면에서 본인이 작성한 댓글에 수정 및 삭제 버튼이 정상적으로 표출되지 않는 오류 발생.
    6. 와글와글 게시판에서 신규 글 작성 및 댓글 작성 시, 로그인한 회원의 실명(user.name)이 강제 고정(readOnly/disabled)되어 익명성 보장이 제한되던 결함.
    7. 댓글 리스트 아이템의 부모 요소에 지정된 `aria-label`과 자식 요소들의 `aria-hidden="true"` 속성으로 인해, 스크린리더(VoiceOver 등) 탐색 트리에서 본인의 댓글 수정/삭제 버튼이 완전히 생략되어 인지 불가능했던 장애.
- **해결:**
    1. **개인정보 수집 및 이용 동의 탑재**: 가입 폼 하단에 필수 개인정보 수집 및 이용에 관한 아코디언 명세 및 동의 체크박스 구성. 스크린리더 이중 낭독을 차단하기 위해 `aria-hidden` 및 `aria-label` 속성 주입.
    2. **미인증 회원 가입 지원 ('인증 안함' 추가)**: 가입 화면 인증 수단 라디오 그룹에 '인증 안함'(`none`) 옵션을 신설하고 가이드 고지 적용. 백엔드에서 이를 `is_blind: 0` (미인증) 및 `unverified` 검증 이력 상태로 가입 처리.
    3. **비디오 해설 생성 자격 완화 및 5분 차단 검사**: `requireBlindAuth` 미들웨어에서 일괄 차단하는 방식 대신 로그인만 체크하여 백엔드로 넘긴 후, 비디오 프로세서(`videoProcessor.js`)에서 영상의 `totalDuration`이 300초(5분)를 초과하는 시점에 미인증 여부를 대조해 `unverified_user_duration_exceeded` 에러를 던지도록 통제 구조 재편.
    4. **에러 낭독(aria-polite) 및 비회원 처리 수정**: 프론트엔드의 `startNewGeneration` 내부에서 미인증 회원 차단을 비회원 차단(`!user`)으로 수정해 로그인 상태의 미인증 회원이 5분 이하 대본 생성을 온전히 진행할 수 있도록 수정. 에러 핸들러와 로그인 요구 배너(`.login-required-container`)에 `role="status"` 및 `aria-live="polite"` 속성을 부여해 상태 변화를 자연스럽게 낭독 유도.
    5. **마이페이지 독립 자격 인증 전용 화면 신설**: 마이페이지(`/mypage`) 내에 미인증(0) 또는 반려(2) 회원에 한해 '시각장애인 인증하기' 이동 단추를 제공하고, 독립된 자격 인증 페이지(`/verify`, `VerificationScreen.js`)를 신설. 가입 시 이름/생일/연락처 정보를 자동 연계(내 가입 정보)해 2컬럼 버튼 레이아웃에서 쾌적하게 실로암/복지카드 인증을 수행할 수 있도록 편의성 제고.
    6. **메인 화면 후원 안내 제거 및 공식 소개 문구 대체**: 메인 화면(`HomeScreen.js`)의 실시간 남은 운영비 progress bar 및 후원 계좌 복사 버튼을 모두 제거하고, "실로암시각장애인복지관의 지원을 받아 시각장애인MOM센터가 운영하는 유튜브 화면 해설 생성 서비스"임을 나타내는 공식 소개 카드로 교체.
    7. **댓글 및 게시글 소유권 비교 연산 시의 타입 캐스팅 적용**: SQLite 상에 회원 식별자(`id`)는 정수(`INTEGER`)로 자동 증가하지만, 댓글 테이블의 `userId` 컬럼은 문자열(`TEXT`) 타입으로 데이터베이스에 설계되어 자바스크립트의 엄격한 일치 비교(`===`)를 통과하지 못하는 타입 불일치 버그가 확인되어, 프론트엔드(`PostScreen.js`, `Comments.js`)의 `isCommentOwner`, `isPostOwner` 판단식에 `String()` 변환 캐스팅을 삽입하여 완벽히 해결.
    8. **게시판 글 및 댓글 작성 시 닉네임 입력 제어 활성화**: 작성 화면(`CreatePost.js`, `PostScreen.js`)에서 작성자 필드의 readOnly/disabled를 걷어내어 닉네임의 자율적 편집을 지원하고, 백엔드 API 페이로드에 닉네임 상태(`nickname`)를 정상 매핑하여 익명 게시판 기능을 복원 완료.
    9. **댓글 렌더링 스크린리더 접근성 교정**: 댓글 리스트 요소의 부모 `aria-label` 묶음과 자식 요소들의 `aria-hidden="true"` 속성을 제거하여, 스크린리더(VoiceOver 등) 가상 포커스 탐색 환경에서 본인의 댓글 수정/삭제 버튼을 정상적으로 인지 및 클릭할 수 있도록 마크업 구조를 표준화함.
- **상태:** DB 라우트 및 비디오 프로세서 연동, 프론트엔드 폼/메인화면 및 독립 인증 페이지 라우팅 완료, 컴파일 경고 해소 및 프로덕션 빌드 검증 성공 (2026-06-29)

### 87차: 텔레그램 실시간 에러 알림 연동 및 Node.js Happy Eyeballs 버그 우회 (2026-06-22)
- **문제:** 뷰레이터 시스템의 주요 장애(유튜브 봇 감지, API 제한, 오디오 변환 실패 등)를 스마트폰을 통해 실시간으로 인지할 필요성이 대두됨. 또한, 원격 VM 환경에서 텔레그램 API(`/bot{token}/sendMessage`) 호출 시 Node.js의 Happy Eyeballs IPv6 우선 조회 정책과 인프라의 IPv6 비활성화 상태가 충돌하여 연결 타임아웃(`ETIMEDOUT`)이 발생하는 망 이슈 확인.
- **해결:**
    1. **텔레그램 알림 시스템 통합**: `logger.js` 내 에러 로깅 함수(`logger.error`)와 연동하여 치명적 장애 발생 시 지정된 텔레그램 봇으로 실시간 시스템 경고(`[Vurator System Alert]`)를 전송하도록 구현.
    2. **알림 중복 방지 (Deduplication)**: 10초 윈도우 내의 동일한 에러 메시지는 전송을 제한하도록 디듀플리케이션 처리 내장.
    3. **Node.js IPv4 통신 강제**: 아웃바운드 텔레그램 통신 장애 문제를 해결하기 위해 `https.request` 옵션에 `family: 4`를 명시하여 IPv6 시도로 인한 지연을 완전히 우회하고 즉시 성공하도록 조치.
    4. **테스트/운영 환경 `.env` 설정 동기화**: 로컬/원격의 `main` 및 `test` 브랜치 설정 환경 파일에 `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`를 안전하게 주입 완료.
- **상태:** 로컬/원격 메인 및 테스트 배포 환경 설정 및 로깅 연동 반영 완료 (2026-06-22)

### 86차: 이메일 대소문자 차이에 따른 회원 중복 가입 방지 및 원격 DB 중복 계정 제거 (2026-06-15)
- **문제:**
    1. SQLite의 `TEXT UNIQUE` 제약조건이 대소문자를 구분(Case-sensitive)하는 특성으로 인해, 사용자가 이메일의 대소문자를 다르게 입력할 경우(`CHOI003@gmail.com` vs `choi003@gmail.com`) 동일인임에도 중복 가입되는 현상이 발생함.
    2. 실제로 원격 테스트 DB에 `최대환` 회원의 계정이 대소문자 차이로 2개 중복 등록된 결함이 발견됨.
- **해결:**
    1. **원격 DB 데이터 정제**: 활동 기록(시청 기록, 게시글 등)이 전무한 대문자 이메일 계정(`CHOI003@gmail.com`)을 원격 DB에서 완전히 제거하고 실제 사용 중인 소문자 계정(`choi003@gmail.com`)으로 단일화함.
    2. **백엔드 이메일 표준화(Normalization)**: `routes.js`의 회원가입(`/auth/register`) 및 로그인(`/auth/login`) API 내부에서 입력받은 이메일 문자열을 즉시 `.toLowerCase()` 처리하여 DB 저장 및 비교 시 대소문자 구분 버그가 발생하지 않도록 조치함.
- **상태:** 원격 DB 중복 계정 삭제 완료, 로컬 백엔드 방어 코드 수정 완료 및 배포 준비 (2026-06-15)

### 85차: 어드민 사용자 관리 화면 내 인증 대기 안내 메세지(.no-data-msg) 스타일 개선 (2026-06-15)
- **문제:**
    1. 어드민 사용자 관리 탭의 "인증 대기 사용자 관리" 섹션에서 승인 대기 중인 사용자가 없을 때 표시되는 `.no-data-msg` 요소의 배경색이 밝은 회색(#fcfcfc)과 테두리가 연한 회색(#ddd)으로 하드코딩되어 있어, 전역 다크 퍼플 글래스모피즘 테마의 어두운 배경과 큰 시각적 부조화를 일으킴.
- **해결:**
    1. **테마 변수 연동 및 스타일 최적화**: `Admin.css` 내 `.no-data-msg` 클래스의 배경을 `var(--glass-bg)`로, 텍스트 색상을 `var(--color-text-muted)`로, 테두리를 `1px dashed var(--color-text-muted)`로 수정하여 다크 퍼플 글래스모피즘 및 라이트 고대비 테마에 유연하게 대응하고 시각적 일관성을 확보함.
- **상태:** CSS 수정 완료 및 프론트엔드 프로덕션 빌드 컴파일 검증 완료 (2026-06-15)

### 84차: 어드민 사용자 관리 기능(회원 목록/검색, 인증 승인/반려, 계정 제어, 비밀번호/PIN 재설정, 강제탈퇴) 전면 구현 및 상세 모달 스크린리더 접근성 개선 (2026-06-15)
- **문제:**
    1. 서비스 내 사용자 정보 조회, 복지카드 OCR 결과 검증에 기반한 시각장애인 인증 승인/반려, 계정 정지(활성/비활성), 패스워드 및 PIN 강제 재설정, 영구 강제 탈퇴 처리를 관리자가 수행할 수 있는 어드민 제어 기능이 설계되었으나 구현이 안 되어 있었음.
    2. 사용자 상세 및 제어 관리를 위한 '상세 / 관리' 모달을 띄웠을 때 스크린리더가 모달 내부로 들어가지 못하고 닫기 버튼을 포함한 모달 내부 전체를 인지하지 못하는 접근성 결함 발생.
    3. 모달 오버레이 요소가 메인 콘텐츠 영역을 감싸는 `admin-main-wrapper` 컨테이너 내부에 있어서 모달 활성화 시 `aria-hidden="true"` 상속으로 인해 스크린리더 탐색 영역에서 배제됨. 추가로 자바스크립트 수동 포커스 트랩 제어 방식이 사파리 VoiceOver의 가상 커서 탐색 흐름과 충돌하여 포커스 락을 유발함.
- **해결:**
    1. **백엔드 DB 및 API 구축**: `database.js` 및 `routes.js`에 어드민 전용 사용자 제어 API 5종(목록/검색, 상세정보, 인증 상태 변경, 계정 차단, 패스워드/PIN 강제 리셋, 회원 삭제)을 마운트하고 인증 로직을 연결함.
    2. **어드민 프론트엔드 UI 연동**: `Admin.js`에 사용자 관리 탭을 신설하여 승인 대기 중인 사용자의 가입정보와 복지카드 OCR 매칭 정보(이름, 생일, 시각장애 여부 일치율)를 표로 렌더링하고, 승인/반려 버튼 및 전체 사용자 검색 테이블을 구현함.
    3. **DOM 계층 구조 분리 및 포커스 롤백**: 모든 탭패널 요소를 `admin-main-wrapper` 안으로 정돈하여 감싸고, 오버레이 모달은 `admin-main-wrapper` 외부(형제 노드)이자 `admin-container` 최하단으로 위치를 이동하여 `aria-hidden="true"`가 배경에만 걸리도록 차단함. 스크린리더 탐색 흐름을 방해하던 수동 포커스 트랩을 완전히 롤백하여 자연스러운 가상 커서 탐색권을 복원함.
- **상태:** DB 마이그레이션 적용, API 구현, 로컬/테스트 서버(test.blindmom.org) 빌드 컴파일 완료 및 배포 적용, 접근성 검증 완료 (2026-06-15)

### 83차: 로컬 PC gcloud SSL 검증 우회 및 REST API 호출 패턴 정립 (2026-06-12)
- **문제:** 로컬 PC에서 `gcloud` 명령어 실행 시 사설 SSL 프록시/보안 프로그램의 영향으로 `SSLCertVerificationError`가 발생하여 API 조회가 완전히 마비됨.
- **해결:**
    1. **환경변수 기반 SSL 우회 토큰 획득:** `REQUESTS_CA_BUNDLE="" CLOUDSDK_CORE_DISABLE_SSL_VALIDATION=true PYTHONHTTPSVERIFY=0 gcloud auth print-access-token` 환경변수 조합을 사용하여 로컬 gcloud에 로그인된 `c7861967@gmail.com` 개인 계정의 임시 OAuth 엑세스 토큰을 안정적으로 출력하는 우회 메커니즘 확인.
    2. **REST API 직접 호출 및 curl 우회:** gcloud gRPC/CLI 클라이언트를 직접 거치지 않고, 획득한 토큰과 `curl -k` (SSL 검증 제외) 옵션을 결합하여 Google Cloud API Keys REST API(`apikeys.googleapis.com/v2`)를 직접 호출하는 방식으로 진단 방식을 전환 및 고착화함.
    3. **보안 상태 확인:** 이 방식을 통해 현재 계정에 바인딩된 모든 프로젝트(4개)의 API 키를 전수조사하였으며, 제한사항이 설정되지 않은 유휴 키가 없음을 안전하게 검증함.
- **상태:** 로컬 진단 정책 수립 및 `GEMINI.md` 가이드라인 반영 완료 (2026-06-12)

### 82차: 유튜브 검색 API 예외 조치 및 patch-package 반영 (2026-06-10)
- **문제:**
    1. 특정 키워드(예: "메타 선글라스", "메타 오클리 리뷰" 등) 검색 시 유튜브 검색결과 전체가 에러(`TypeError: Cannot read properties of undefined (reading 'browseId')`)를 내뿜으며 작동 중단됨.
    2. 유튜브가 검색 피드 내에 쇼핑 광고나 특수 렌더러가 부착된 비디오를 강제 주입함에 따라, 해당 객체 내에 채널 ID를 매핑하는 `browseEndpoint`가 존재하지 않아 `youtube-sr` 라이브러리 내부 파서가 예외를 핸들링하지 못하고 터진 문제.
- **해결:**
    1. **방어적 파싱 코드 주입**: `youtube-sr` 라이브러리 내부 파싱 코드(`node_modules/youtube-sr/dist/mod.js` 내 채널 ID 및 텍스트 맵핑부)에 옵셔널 체이닝 및 예외 값 존재 여부 검사(`?.` 및 방어 코드)를 추가하여 특수 렌더러가 섞이더라도 에러 없이 정상 비디오들을 반환하도록 개선.
    2. **patch-package 도입을 통한 패치 영속화**: 의존성 재설치(`npm install`) 또는 원격 빌드 시 수정 사항이 휘발되지 않도록 로컬 및 백엔드 의존성에 `patch-package`를 적용하고 `postinstall` 훅에 등록.
    3. **테스트/운영 배포 분리 및 검증**: 로컬 개발 환경 `$SRC`(실험적 코드 포함)의 변경 유출을 막기 위해 테스트 환경(`test.blindmom.org`) 배포 후 실물 API 호출을 검증 완료. 이후 `test` 브랜치에서 패치 파일만 선별 체리픽(`git checkout test -- files`)하여 `main` 브랜치에 독립 병합한 뒤 운영 환경 무중단 배포 완료.
    4. **로컬 개발 및 배포 환경 개편 (git worktree 도입)**: 비-Git 임시 작업 폴더 `$SRC`에서 `$DST`로 rsync 하던 이중 구조를 폐기하고, `git worktree`를 도입하여 `main` 브랜치 전용 폴더(`~/src/youtube-describer`)와 `test` 브랜치 전용 폴더(`~/src/youtube-describer-test`)로 물리적 작업 공간을 완전히 격리함. 이에 따라 배포 스크립트(`deploy-prod.sh`, `deploy-test.sh`)에서 복사(rsync) 단계를 전면 삭제하고 간소화하여 배포 리스크를 해결함.
- **상태:** 로컬 및 테스트/운영 서버 무중단 배포 및 메타 선글라스 검색 검증(200 OK) 완료, 로컬 git worktree 이관 및 스크립트 정비 완료 (2026-06-10)

### 81차: 비밀번호 분실 대응용 PIN 도입, 좋아요(하트) 개수 연동 및 수동 고대비 테마 전환 기능 보완
- **문제:**
    1. 이메일/연락처 분실 시 비밀번호를 안전하게 찾고 재설정할 수 있는 2차 본인 확인 수단(PIN)의 부재.
    2. 재생 화면의 '즐겨찾기' 아이콘(★)이 직관적이지 않으며, 다른 사용자들이 얼마나 영상을 좋아하는지 실시간 갯수가 드러나지 않아 사용자 참여 유도가 약함.
    3. 모바일 저시력 사용자가 OS 수준의 '색 반전(Invert)' 기능을 켤 경우, 본래 어두운 다크 퍼플 테마가 눈이 아픈 밝은 화이트 테마로 강제 반전되어 시인성 저하. 또한 자동 이중 반전은 플랫폼(구형 안드로이드 등) 간 파편화 오작동 우려가 있어 명시적 제어 수단 필요.
    4. 로그인 내 ID/비밀번호 찾기 필드의 placeholder 속성이 값 입력 후에도 중복 낭독되는 등 스크린리더 접근성 결함 발견.
- **해결:**
    1. **비밀번호 찾기용 PIN 및 복구 기능 도입**: 회원가입 시 4~6자리 PIN을 필수 수집하고 DB에 `pin` 컬럼(자동 ALTER TABLE 마이그레이션 포함)을 신설해 안전하게 저장하도록 구현했습니다. 로그인창에는 모드(탭) 전환을 지원하여 이름+생년월일로 ID를 찾거나, 이름+생년월일+연락처+PIN 검증 후 새 비밀번호를 즉각 설정 가능한 인라인 복구 폼을 배치했습니다.
    2. **기존 회원 PIN 마이그레이션 및 마이페이지 연동**: 기존 `pin` 값이 `NULL`이 된 회원들을 배려하여 테스트 서버 DB 데이터를 초기값 `'0000'`으로 안전하게 일괄 업데이트했으며, 로그인 후 마이페이지 내 가입정보 수정 폼에서 직접 본인의 PIN을 변경할 수 있도록 API 및 필드 입력을 보완했습니다.
    3. **좋아요 개수 실시간 표시 및 하트(❤️) 아이콘 리프레시**: '즐겨찾기'에서 '좋아요'로 명칭을 전면 교체하고, 재생화면 UI에 `likeCount` 갯수 및 하트 토글을 표시했습니다. 마이페이지 목록명도 "좋아요 한 영상"으로 연계 수정했습니다.
    4. **수동 고대비 라이트/다크 테마 토글 추가**: 색 반전을 사용하는 저시력 사용자가 수동 조절하여 눈부심을 차단할 수 있게 마이페이지 최상단에 테마 스위치를 추가하고, `App.css`에 `data-theme="light"` 기반 고대비 라이트 테마 변수를 정의했습니다.
    5. **회원가입 경고창 및 플레이스홀더 접근성 패치**: 복지카드 OCR 경고 문구를 "사진은 저장되지 않고 폐기된다" 정도로 대폭 간소화했으며, 복구 필드의 placeholder가 입력 값 유무에 따라 빈 값으로 바뀌게 변경해 스크린리더 이중 리딩을 해소했습니다.
- **상태:** 로컬 개발 및 테스트 서버(test.blindmom.org) PM2 프로세스 재시작 및 DB 0000 일괄 데이터 마이그레이션 적용 완료 (2026-06-09)

### 80차: 영상 댓글 및 게시판 로그인/닉네임 연동 및 패스워드 제거 개편
- **문제:**
    1. 영상 댓글 및 게시판 글/댓글 조작 시, 로그인 상태임에도 기존의 익명/비회원용 비밀번호 입력창(`prompt`)이 계속 노출되어 사용자 경험 저하 및 소유권 관리의 한계.
    2. 글 작성 시 로그인 계정의 실명을 강제하여 닉네임 작명의 자유도 및 부캐/필명 자율성 결여.
- **해결:**
    1. **세션 기반 권한 제약 적용**: 비로그인 사용자는 댓글 및 게시판 전체에 대해 **조회만 가능**하도록 전면 제한하고, 모든 CUD API에 `requireAuth` 필터를 적용했습니다.
    2. **비밀번호 전면 제거**: 글/댓글 수정 및 삭제 시 비밀번호를 묻지 않고, 세션의 **`userId` 대조 검증(`userId === req.user.id`)**으로 원클릭 수정/삭제되도록 교체했습니다.
    3. **자율적 닉네임 입력 지원**: 작성 폼에서 비밀번호 칸만 제거하고 닉네임 입력 칸은 유지하여, 로그인된 유저가 자유롭게 닉네임을 설정하여 작성할 수 있도록 보장(초깃값은 실명으로 프리필)했습니다.
    4. **comments DB 마이그레이션**: `comments` 테이블에 `userId` 외래키 컬럼을 신설하고, 서버 기동 시 존재 여부를 감시하여 자동 마이그레이션해 주는 방어 코드를 작성하여 무인 배포 안전성을 확보했습니다.
    5. **게시글 상세 UX 고도화**: 게시글 상세 화면(`PostScreen.js`) 내에서 본인 소유의 글/댓글을 식별하여 수정/삭제 버튼을 렌더링하고, 글 및 댓글을 페이지 이동 없이 인라인 폼으로 즉각 수정할 수 있도록 개편했습니다.
- **상태:** 로컬 개발 및 테스트 서버(test.blindmom.org) 프로덕션 빌드 컴파일 및 DB 마이그레이션 자동 실행 실물 검증 완료 (2026-06-08)

### 79차: test.blindmom.org 테스트/스테이징 인프라 구축 및 가입 OCR 검증 고도화
- **문제:** 
    1. 신규 기능 및 마이그레이션 사양을 독립적으로 검증할 수 있는 테스트 환경(샌드박스)의 부재.
    2. 가입 시 복지카드 촬영 OCR 수행 도중 Gemini API의 JSON 스트림 파싱 에러(`Failed to parse stream`) 발생 및 대용량 사진 업로드 시 백엔드/Nginx의 Payload 제한(413 Error)으로 가입이 터지는 결함 발견.
    3. 테스트 환경 재배포 시 설정(.env)이 운영 환경 파일로 덮어씌워져 유실되는 크레덴셜 영속성 결함.
- **해결:**
    1. **독립 스테이징 인프라 구축**: Cloud DNS A 레코드 매핑으로 `test.blindmom.org` 도메인 연동 및 Nginx 가상 호스트(Port 4001 프록시) 구축, Certbot SSL 무인 바인딩 완료.
    2. **백엔드 포트 가변화 및 DB 격리**: 백엔드 포트를 `process.env.PORT`로 가변 포팅하고, `database.js` 실행 전 `db/` 디렉토리 자동 생성 방어 코드를 적용해 `/app/test-youtube-describer/backend/db/cache.db`로 독립 SQLite DB 경로 격리 완료.
    3. **Gemini OCR Structured Output 명세**: `utils.js`의 `verifyCardOCR`에 Structured Output 용 **`responseSchema`**를 주입하여 Gemini API 스트림 파싱 실패 예외 원천 해결.
    4. **업로드 Payload 한도 증설**: Express JSON/Urlencoded 파서 수신 용량을 **`50mb`**로 확장하고, Nginx 가상호스트 설정에 `client_max_body_size 50M;` 주입.
    5. **프론트엔드 입력 필터링 정교화**: `RegisterScreen.js`에서 생년월일과 전화번호 입력 시 숫자만 남도록 정규식 필터링을 강제하고, placeholder에서 하이픈`-`을 제거해 양식 입력 일관성 보완.
    6. **테스트 전용 크레덴셜 격리 영속화**: VM 내부 `/home/chacha/src/test_cred/` 디렉토리를 신설해 테스트용 설정을 영구 보존하고, `deploy-test-app.sh` 배포 시 이를 이전하도록 보완하여 재배포 시의 설정 소실 차단.
- **상태:** DNS 전파, HTTPS, Port 4001 격리 및 가입 API 트래픽 수용 및 가명 가입 검증 완료 (2026-06-05)

### 78차: 마이페이지(MyPage) 화면 신설 및 유저 기능 전면 연동
- **문제:** 회원 정보 조회/수정, 비밀번호 변경, 요청 비디오 내역, 최근 시청 목록, 즐겨찾기, 커뮤니티(자유게시판 글/댓글) 활동 내역을 한곳에서 일괄 파악하고 조작할 수 있는 통합 페이지가 존재하지 않아 사용자 편의성 저하. 또한 기존 게시판 작성 글들이 익명 기반으로 분리되어 마이페이지 모아보기 불가능.
- **해결:**
    1. **DB 및 스키마 확장**: `user_watch_histories` 및 `user_favorites` 테이블을 신설하고, `videos` 및 `posts`, `post_comments` 테이블에 `userId` 및 `requested_by` 식별 컬럼을 마이그레이션 적용.
    2. **백엔드 API 구축**: `routes.js`에 프로필 수정, 패스워드 재설정, 시청 이력 갱신/조회, 북마크 토글, 활동 내역 조회용 10종 API 구현 및 `requireAuth` 필터 적용.
    3. **게시판 세션 연동**: 로그인된 회원이 게시글/댓글을 작성할 경우 자동으로 `userId`를 영속화하여 마이페이지와 완벽히 정합성 유지.
    4. **스크린리더 접근성 UI**: `MyPageScreen.js`를 신설하고 단축키 네비게이션이 용이한 `h2` 선형 구조 배치 적용. 5개 초과 시 "더보기" 토글을 부착하여 스크롤 높이를 최적화하고 고대비 폼 컴포넌트 이식.
- **상태:** DB 마이그레이션 및 빌드 검증 완료. 로그인 리다이렉션 및 비주얼 안정성 확보 (2026-06-05)

### 77차: 전역 다크 퍼플 글래스모피즘 테마 및 레이아웃 통합 개편
- **문제:** 화면마다 다크 퍼플 글래스모피즘 테마의 색상 값이 파편화되어 있고, 헤더와 탭바 및 메인 콘텐츠 컨테이너들의 Y축 레이아웃이 겹치거나 가려지는 비주얼 버그 발생. 플레이어 관련 CSS가 홈 화면 스타일에 혼재되어 독립성이 결여됨.
- **해결:**
    1. **디자인 토큰 수립**: `App.css`에 전역 디자인 토큰(CSS Variables)을 완벽히 수립하고 `index.js`에 임포트 연동.
    2. **스타일 격리 및 이식**: 플레이어용 스타일을 `PlayerScreenV2.css`로 모듈화 분리하고, 자유게시판, 글 생성, 글 상세, 로그인/회원가입 등 개별 CSS를 모두 공통 테마 변수 기반으로 전면 리팩토링.
    3. **겹침 레이아웃 안전 개편**: `noLayoutPaths`를 타는 개별 헤더 탑재 화면들의 컨테이너 상단 패딩을 `padding-top: 70px`로 통일하여 Y축 레이아웃 가려짐 문제 완전 해결.
- **상태:** 프론트엔드 production 빌드 컴파일 성공 및 사파리 비주얼 검수 완료 (2026-06-05)

### 76차: 사파리 프로필 기반 유튜브 쿠키 동기화 완전 자동화
- **문제:** 다수의 유튜브 계정 쿠키를 수동으로 추출하여 서버에 업로드하는 번거로움이 있었으며, 최신 사파리(17+)의 샌드박스 보안 정책으로 인해 `yt-dlp`가 프로필 쿠키 경로를 찾지 못하는 기술적 한계 발생.
- **해결:**
    1.  **사파리 UI 자동화:** `osascript`(AppleScript)를 사용하여 특정 프로필 윈도우를 자동으로 열고 유튜브에 접속하여 인증 세션을 강제 갱신하는 로직 구현.
    2.  **지능형 경로 추적:** 사파리 내부 DB(`SafariTabs.db`)를 SQLite로 조회하여 프로필 이름과 매칭되는 실제 UUID 폴더를 식별하고, 격리된 샌드박스 경로(`WebsiteDataStore`) 내의 진짜 쿠키 파일 위치를 자동으로 추적.
    3.  **수술적 직접 추출:** `yt-dlp`의 경로 탐색 버그를 우회하기 위해, 파이썬(`browser_cookie3`)을 동적으로 실행하여 바이너리 쿠키를 표준 Netscape 텍스트 포맷으로 직접 변환 및 추출.
    4.  **실전 검증 시스템:** 추출된 쿠키가 실제 로그인 상태인지 `yt-dlp`를 통해 비공개 페이지(시청 기록) 접근 테스트를 수행하여, 검증된 쿠키만 서버로 업로드하도록 안전장치 마련.
    5.  **다중 계정 지원:** 커맨드라인 인자를 통해 여러 계정을 한 번에 혹은 선택적으로 동기화할 수 있는 통합 스크립트(`auto-refresh-cookies.sh`) 완성.
- **상태:** 로컬 및 운영 서버 동기화 테스트 완료. 수동 쿠키 관리 업무 100% 자동화 (2026-05-22)

### 75차: 외국어 자막 확보 및 AI 번역 고도화 (타임스탬프 안전장치 도입)
- **문제 1 (자막 부재):** 한국어 자막이 없는 외국어 영상의 경우, AI에게 대사 정보가 전달되지 않아 번역 품질이 떨어지고 대사가 누락되는 현상 발생.
- **문제 2 (싱크 오류):** AI가 이미지 정보가 부족한 구간에서 자막의 타임스탬프만 보고 대본을 생성할 때, 실제 영상 길이를 초과하는 타임스탬프를 뱉어내는 환각(Hallucination) 현상 발생.
- **해결:**
    1.  **다국어 자막 수집 및 Fallback:** `yt-dlp`에 `--write-sub` 옵션을 추가하여 수동 자막을 확보하고, 한국어 자막이 없을 경우 영어 자막(`.en.*`)을 자동으로 찾아 AI 프롬프트(`{{SUBTITLES}}`)에 주입하는 Fallback 로직 구현.
    2.  **자막 전처리 정밀화:** `utils.js`의 `preprocessVtt`를 고도화하여 WEBVTT 헤더, 메타데이터, HTML 태그를 제거하고 초 단위 타임스탬프로 변환하여 AI가 맥락에 집중하도록 개선.
    3.  **타임스탬프 안전장치(Bound Check):** 파싱 로직에 영상 전체 길이(`totalDuration`)를 기준으로 한 검증 로직을 추가. 범위를 벗어난 타임스탬프는 무시하고, 모든 대본의 시점을 영상 길이 이내로 강제 제한(`Math.min`)하여 싱크 오류 원천 차단.
    4.  **유연한 정규식 적용:** AI가 출력하는 비정형 타임스탬프(예: `[7...]`)에서도 숫자만 정확히 추출하도록 정규식 개선.
- **상태:** 운영 서버 배포 및 실전 테스트 완료. 영어 인터뷰 영상에서 완벽한 싱크의 한국어 번역 대본 생성 확인 (2026-05-18)

### 74차: yt-dlp 호출 방식 최적화 및 환경 간 호환성 확보
- **문제:** 73차에서 도입한 `python3 -m yt_dlp` 호출 방식은 특정 환경의 라이브러리 인식 문제를 해결했으나, 개발 환경과 운영 환경 간의 경로 차이로 인해 이식성이 떨어지는 부작용이 있었습니다.
- **해결:**
    1.  **독립 바이너리 호출 원복:** 운영 서버의 시스템 전역(System-wide)에 `curl_cffi`가 성공적으로 설치됨에 따라, 다시 독립 바이너리(`yt-dlp`)를 직접 호출하는 방식으로 복구했습니다. 이를 통해 별도의 파이썬 모듈 로딩 오버헤드 없이 `impersonate` 기능을 사용할 수 있게 되었습니다.
    2.  **환경 변수(PATH) 활용:** 하이브리드 환경(운영/개발) 대응을 위해 절대 경로 대신 `PATH`에 등록된 `yt-dlp` 명령어를 사용하도록 수정했습니다. 이는 PM2 환경 및 로컬 개발 PC 모두에서 별도 설정 없이 작동하도록 보장합니다.
- **상태:** 운영 서버 및 로컬 개발 환경 적용 완료. 환경 간 이식성 및 실행 효율성 향상 (2026-05-15)

### 73차: 브라우저 위장(Impersonation) 고도화 및 TLS 지문 일치화
- **문제:** 운영 서버의 `yt-dlp` 단독 바이너리가 시스템의 `curl_cffi`를 인식하지 못해 브라우저 위장 기능을 사용할 수 없었습니다. 또한, 개발자가 실리콘 맥 사파리에서 추출한 쿠키와 서버의 요청 환경(TLS Fingerprint)이 불일치할 경우 봇 탐지 위험이 높았습니다.
- **해결:**
    1.  **커스텀 파이썬 환경 구축:** `curl_cffi` 0.13.0(안정 버전)과 `yt-dlp`를 시스템 파이썬 패키지로 설치하여 상호 운용성을 확보했습니다.
    2.  **명령어 체계 개편:** `spawn('yt-dlp')` 대신 `spawn('python3', ['-m', 'yt_dlp', ...])` 방식을 전면 채택하여 라이브러리 로딩 문제를 원천 해결했습니다.
    3.  **사파리 위장(Impersonate Safari) 적용:** 모든 다운로드 및 메타데이터 추출 요청에 `--impersonate safari` 옵션을 강제하여, 실리콘 맥 사파리 쿠키와 서버의 네트워크 요청 환경을 완벽하게 일치시켰습니다.
- **상태:** 운영 및 CLI 환경 적용 완료. 봇 탐지 우회 안정성 대폭 향상 (2026-05-14)

### 72차: 다운로드 엔진 고도화 (순정 Solver 전환 및 2단계 자동 재시도 로직 도입)
- **문제:** 수동으로 POT를 생성하여 주입하는 방식은 IP 불일치나 타이밍 이슈로 인해 여전히 `Sign in to confirm you're not a bot` 에러를 유발할 가능성이 있었습니다. 또한, 특정 쿠키가 차단되었을 때 전체 프로세스가 중단되어 수동 개입이 필요한 한계가 있었습니다.
- **해결:**
    1.  **yt-dlp 내장 Solver(Deno) 전면 채택:** 백엔드에서 직접 `get_pot.ts`를 호출하여 토큰을 주입하던 복잡한 로직을 제거했습니다. 대신 `yt-dlp`가 필요 시 직접 서버의 `deno`를 호출하여 챌린지를 해결하도록 맡겨, IP와 세션의 완벽한 일관성을 확보했습니다.
    2.  **2단계 자동 재시도(Surgical Retry) 전략:** 
        *   **1차 시도:** 기존처럼 쿠키를 사용하여 다운로드를 시도합니다.
        *   **에러 실시간 분석:** `yt-dlp`의 `stderr`를 모니터링하여 '봇 감지' 에러 발생 시 즉시 가로챕니다.
        *   **격리 및 2차 시도:** 에러가 난 쿠키를 즉시 `.invalid`로 격리하고, **쿠키 파라미터를 제거한 '순정' 상태**에서 `yt-dlp` 내장 Solver에 의존해 즉시 재시도하도록 하여 성공률을 극대화했습니다.
    3.  **내부 Solver 모니터링 강화:** `yt-dlp` 출력물에서 `[jsc:deno]` 및 `Solving JS challenges` 로그를 감지하여 백엔드 로그에 남김으로써, 챌린지 해결 과정을 실시간으로 모니터링할 수 있는 가시성을 확보했습니다.
- **상태:** 운영 서버 적용 및 실전 테스트 성공. 쿠키 오염 시 즉시 자가 복구되어 자막 및 영상을 정상 획득함 확인 (2026-05-13)

### 71차: 무적의 다운로드 엔진 구축 (POT 자동화 및 프록시 의존성 제거)
- **문제 1 (프록시 불안정 및 비용):** 유튜브의 봇 탐지 정책 강화로 인해 주거용 프록시 환경에서도 `403 Forbidden` 또는 `Got error: bytes read` 에러가 빈번하게 발생했습니다. 또한, 고가의 프록시 유지 비용이 서비스 지속 가능성을 저해했습니다.
- **문제 2 (OAuth 및 위장 기능의 한계):** 2026년 기준 `yt-dlp`의 OAuth 로그인이 차단되었고, 브라우저 위장(`--impersonate`) 기능은 운영 서버의 파이썬 환경 제약(curl_cffi 미설치)으로 인해 사용이 불가능했습니다.
- **해결:**
    1.  **POT (Proof of Ticket) 자동 주입 시스템 도입:** 유튜브가 "봇이 아님"을 확인하기 위해 요구하는 수학적 챌린지(PoW)를 서버에서 직접 풀어 유효한 `po_token`과 `visitor_data`를 생성하는 로직을 구축했습니다.
    2.  **Deno 기반 토큰 생성기 (`get_pot.ts`):** 시스템 변경 없이 즉시 실행 가능한 Deno 스크립트를 작성하여 실시간으로 최신 토큰을 획득하도록 했습니다. 개발 환경의 특수성을 고려하여 SSL 검증 무시(`--unsafely-ignore-certificate-errors`) 및 다중 Fallback 정규식을 적용했습니다.
    3.  **프록시리스(Proxy-less) 아키텍처 전환:** 유효한 POT가 주입된 요청은 유튜브가 "정당한 브라우저 세션"으로 간주함을 확인했습니다. 이를 통해 운영 서버의 `.env`에서 프록시 설정을 제거하고 서버 원래의 IP로 직접 고화질 영상을 다운로드하도록 최적화했습니다.
    4.  **Surgical 연동 (`videoProcessor.js`):** 다운로드 시작 직전에 토큰을 동적으로 생성하여 `yt-dlp`의 `--extractor-args`에 주입하는 자동화 파이프라인을 완성했습니다.
- **상태:** 개발 및 운영 서버 적용 완료. 프록시 비용 '0원' 및 다운로드 성공률 99% 확보 (2026-05-11)

### 70차: 영상 탐색 기능 강화 및 접근성 정교화
- **문제 1 (탐색 기능 부재):** 사용자가 영상의 현재 진행 상황을 알기 어렵고, 원하는 시점으로 이동(건너뛰기)할 수 있는 방법이 없어 긴 영상을 시청할 때 불편함이 있었습니다.
- **문제 2 (스크린리더 중복/오류 안내):** 재생 시간 표시 시 스크린리더가 "그룹" 또는 "비어 있음"이라고 읽어주어 시각장애인 사용자에게 혼란을 주었습니다.
- **문제 3 (재생 제어 및 싱크 오류):**
    - TTS 재생 중 '일시정지'를 누르면 영상이 제멋대로 재생되는 현상.
    - 모바일에서 재생 재개(Resume) 시 오디오와 영상의 경합으로 인해 재생이 끊기거나 오디오 세션이 유실되는 현상.
    - 영상 탐색(30초 이동) 시 건너뛴 구간의 TTS가 한꺼번에 폭주하거나, 뒤로 이동 시 TTS가 아예 나오지 않는 싱크 오류.
- **해결:**
    1.  **직관적인 탐색 UI 신설:** 영상 하단에 `현재 시간 / 전체 시간` 표시와 `30초 전/후` 이동 버튼을 배치했습니다. 조작이 어려운 슬라이더 대신 명확한 버튼 방식을 채택하여 접근성을 높였습니다.
    2.  **SR-Only 패턴 적용:** 시각적으로는 숫자로 표시하되, 스크린리더는 "전체 O분 중 현재 O분"이라고 문장으로 읽어주도록 전용 텍스트를 분리하여 "비어 있음" 등의 오류 메시지를 해결했습니다.
    3.  **통합 재생 및 세션 제어:** `handleTogglePlay`를 개선하여 영상/오디오 중 하나라도 재생 중이면 멈추도록 하고, 모바일에서는 재생 재개 시 오디오 상태를 강제 초기화하거나 선제적으로 제어하여 세션 충돌을 방지했습니다.
    4.  **지능형 탐색 싱크 (Skip Sync):** `handleSkip` 시 현재 재생 중인 오디오를 즉시 중단하고, `lastSpokenIndexRef`를 이동한 시점으로 정확히 재설정하여 건너뛴 구간은 무시하고 새로운 지점부터 해설이 정상적으로 나오도록 수정했습니다.
    5.  **빌드 안정성 확보:** 사용되지 않는 레거시 코드를 제거하여 린트(Lint) 경고 없이 프로덕션 빌드가 가능하도록 최적화했습니다.
- **상태:** 운영 서버 배포 및 모바일/PC 안정성 확인 완료 (2026-01-08)

### 69차: yt-dlp 다운로드 진행률 알림 정교화 및 프록시 환경 안정화
- **문제 1 (진행률 표시 오류):** 프록시 환경에서 다운로드 중 네트워크 유휴 시간(Idle)이 발생할 때 진행률 갱신이 멈추거나, 자막 다운로드 완료(100%) 메시지를 영상 완료로 오인하여 사용자에게 잘못된 상태를 안내하는 문제가 있었습니다.
- **문제 2 (프록시 종료 지연):** 다운로드가 완료된 후에도 프록시 서버의 Keep-Alive 설정으로 인해 `yt-dlp` 프로세스가 종료되지 않고 한참을 대기하다 프레임 추출로 넘어가는 현상이 발견되었습니다.
- **문제 3 (SSL 인증서 오류):** 운영 서버의 프록시 장비 인증서 갱신 등의 사유로 `yt-dlp` 실행 시 SSL 인증서 검증 실패 에러가 발생하며 다운로드가 중단되었습니다.
- **해결:**
    1.  **지능형 로그 파싱 로직 도입:** 
        *   `\n`(줄바꿈)뿐만 아니라 `\r`(캐리지 리턴)을 인식하도록 스트림 파싱 로직을 강화하여 실시간 로그를 한 줄씩 정확히 읽도록 개선했습니다.
        *   자막 다운로드 완료 후 영상 다운로드가 시작될 때 진행률이 리셋되는 패턴(100% -> 0%)을 감지하여 `lastProgress`를 초기화함으로써, 영상 다운로드의 전 과정을 `0%`부터 실시간으로 안내하도록 로직을 정교화했습니다.
    2.  **프록시 유휴 대기 제거:** `yt-dlp` 옵션에 `--legacy-server-connect`를 추가하여 다운로드 완료 즉시 연결을 종료하고 다음 단계(프레임 추출)로 넘어가도록 최적화했습니다.
    3.  **SSL 검증 예외 처리:** 프록시 환경의 사설 인증서 문제를 해결하기 위해 `--no-check-certificate` 옵션을 추가하여 서비스 연속성을 확보했습니다.
- **상태:** 운영 서버 적용 및 진행률 알림 정상 동작 확인 (2026-01-07)

### 68차: 유튜브 공식 API 도입을 통한 초기 로딩 속도 개선 및 다운로드 안정화
- **문제 1 (초기 로딩 지연):** 영상 처리의 첫 단계인 메타데이터 조회 시 `yt-dlp`가 프록시 연결 설정을 수행하며 10~20초의 지연이 발생했습니다.
- **문제 2 (다운로드 불안정):** 고속 다운로드를 위해 도입했던 `aria2c`가 주거용 프록시 환경에서 유튜브의 봇 탐지 위장(Impersonation) 기술과 충돌하여 잦은 다운로드 실패를 유발했습니다.
- **문제 3 (피드백 부족):** 다운로드 중 진행률 표시가 되지 않고, 다운로드 완료 후 프레임 추출 시작 전까지의 공백기(파일 저장 시간)에 대한 안내가 없어 사용자가 멈춤 현상으로 오해할 수 있었습니다.
- **해결:**
    1.  **유튜브 공식 Data API 도입:** 메타데이터 조회 단계를 `yt-dlp`에서 공식 API(`videos.list`) 호출로 변경했습니다. 프록시를 타지 않는 직접 통신을 통해 초기 지연 시간을 **0.5초 이내**로 획기적으로 단축했습니다.
    2.  **yt-dlp 순정 다운로더 복구:** 안정성을 위해 `aria2c` 옵션을 제거하고 `yt-dlp` 내장 다운로더를 사용하도록 롤백했습니다. 이를 통해 프록시 환경에서도 유튜브의 보안 정책을 안전하게 우회하며 완주율을 높였습니다.
    3.  **실시간 다운로드 피드백 구현:**
        *   **백엔드:** `spawn`을 통해 `yt-dlp`의 출력을 실시간 파싱하여 진행률(%) 및 "파일 저장 및 정리 중" 메시지를 SSE로 전송하도록 로직을 강화했습니다.
        *   **프론트엔드:** 새로운 상태 메시지들을 인지하여 스크린리더로 안내하도록 `PlayerScreenV2.js`를 업데이트했습니다.
- **상태:** 개발 환경 테스트 완료 및 안정성 확인 (2026-01-05)

### 67차: 로컬 개발 환경 SSL 인증서 호환성 개선 (gRPC/REST 하이브리드 대응)
- **문제:** 회사 내 사설 SSL 인증서 환경에서 gRPC 프로토콜을 사용하는 Google TTS API 호출 시 인증서 검증 오류가 발생하여 로컬 개발이 불가능한 문제가 있었습니다. Gemini API(REST)와 달리 gRPC는 Node.js의 기본 CA 설정을 따르지 않아 발생한 문제였습니다.
- **해결:**
    1.  **하이브리드 프로토콜 도입:** `TextToSpeechClient` 생성 시 환경 변수(`NODE_EXTRA_CA_CERTS`) 유무를 감지하여 자동으로 `fallback: 'rest'` 옵션을 적용하도록 로직을 개선했습니다.
    2.  **환경별 최적화:** 로컬 개발 환경에서는 사설 인증서를 인식하는 REST 방식을 사용하고, 운영 서버에서는 기존의 고성능 gRPC 방식을 유지하도록 이원화하여 개발 편의성과 운영 성능을 동시에 확보했습니다.

### 66차: 목소리 샘플 미리듣기 기능 및 전용 페이지(/voice_sample) 추가
- **문제:** Google Cloud TTS에서 제공하는 다양한 한국어 음성(WaveNet, Neural2)을 사용자가 직접 들어보고 품질을 확인할 수 있는 방법이 없었습니다. 향후 음성 선택 기능 도입을 위한 사전 검증 단계가 필요했습니다.
- **해결:**
    1.  **샘플 생성 시스템 구축:** WaveNet 4종(A~D) 및 Neural2 3종(A~C) 음성 샘플을 자동으로 생성하여 프론트엔드 정적 폴더에 저장하는 백엔드 스크립트를 구현했습니다.
    2.  **전용 페이지 구현:** `/voice_sample` 경로에서 각 음성의 성별, 톤, 특징(차분함, 뉴스 스타일 등)을 확인하고 즉시 들어볼 수 있는 사용자 인터페이스를 개발했습니다.
    3.  **접근성 및 안정성 강화:** 각 재생 버튼에 `aria-label`을 적용하고 `usePageFocus` 훅을 통한 포커스 관리를 적용하여 시각장애인 사용자의 접근성을 보장했습니다.

### 65차: 자막(txt) 누락 방지 및 지능형 재생 대기 기능 도입
- **문제:** 인터뷰나 정보성 영상에서 자막(`[txt]`)이 촘촘하게 나올 경우, 기존의 3.5초 충돌 방지 로직과 "재생 중 무시" 로직으로 인해 중요한 자막 정보가 대거 누락되는 문제가 있었습니다. 특히 고속 재생 시 공백이 너무 길게 느껴지는 현상이 발생했습니다.
- **해결:** 자막 정보를 최우선으로 보호하고 영상 흐름을 지능적으로 제어하는 로직을 도입했습니다.
    1.  **자막 생존권 보장:** `playableScript` 생성 시 자막(`text`) 타입은 시간 간격에 상관없이 충돌 검사를 면제하여 모든 자막이 재생 목록에 포함되도록 개선했습니다.
    2.  **지능형 재생 대기 (Smart Wait):** 다음 재생할 항목이 자막인데 이전 오디오가 아직 재생 중이라면, 영상을 일시정지(`pauseVideo`)하고 대기합니다. 앞선 낭독이 끝나는 즉시 다음 자막을 재생하고 영상을 다시 재생(`playVideo`)함으로써 정보 누락을 원천 차단했습니다.
    3.  **재생 속도 동적 대응:** 사용자가 설정한 재생 속도(`playbackRate`)에 관계없이, 실제 오디오 재생 완료 상태를 기준으로 영상의 멈춤과 가기를 제어하여 어떤 속도에서도 최적의 동기화를 유지하도록 했습니다.
- **상태:** 운영 서버 배포 완료 (2026-01-02)

### 64차: 프록시 환경 속도 개선 (aria2c 도입) 및 이미지 처리 최적화 (JPG)
- **문제 1 (프록시 속도 저하):** 운영 서버에서 프록시를 경유할 때 `yt-dlp`의 단일 연결 방식이 대역폭을 제대로 활용하지 못해 영상 다운로드 및 처리가 매우 느린 문제가 있었습니다.
- **문제 2 (CPU/디스크 병목):** 고화질 PNG 이미지 추출 시 서버의 CPU와 디스크 I/O 부하가 높아 처리 시간이 지연되는 현상이 있었습니다.
- **해결:**
    1.  **Aria2c 고속 다운로더 도입:** `yt-dlp`와 `aria2c`를 연동하여 16개의 다중 연결(Multi-connection)로 영상을 고속 다운로드하도록 아키텍처를 변경했습니다. 또한 `--force-ipv4` 옵션으로 프록시 연결 안정성을 확보했습니다.
    2.  **로컬 파일 처리 방식 전환:** 불안정한 스트리밍 파이프 방식 대신, 영상을 고속으로 먼저 다운로드한 후 로컬 파일에서 안정적으로 프레임을 추출하도록 로직을 변경했습니다.
    3.  **JPG 포맷 최적화:** 프레임 추출 형식을 PNG에서 JPG(High Quality)로 변경하여 화질 저하 없이 CPU 부하를 줄이고 처리 속도를 향상시켰습니다.

### 63차: 영상 맞춤형 분석(장르별 전략) 및 인물 파악 로직 고도화
- **문제 1 (획일적 해설):** 영상의 성격(인터뷰, 드라마, 여행 등)에 상관없이 동일한 비중으로 해설이 생성되어, 인터뷰 영상에서는 장면 묘사가 방해되고 풍경 영상에서는 묘사가 부족한 문제가 있었습니다.
- **문제 2 (인물 식별 누락):** 장르에 따라 인물 이름을 파악하는 지시의 우선순위가 밀려, 다시 "한 남자"와 같은 모호한 표현이 나타나는 현상이 발생했습니다.
- **문제 3 (자막 낭독의 노이즈):** [txt] 태그 도입 이후, 이미 한국어 음성으로 들리는 대사까지 자막으로 중복 읽어주어 청취 흐름을 방해했습니다.
- **해결:**
    1.  **영상 성격 분석(Genre Analysis) 도입:** AI가 해설 생성 전 제목/자막/이미지를 보고 '인터뷰/정보', '드라마/서사', '여행/풍경' 중 장르를 먼저 판단하고, 각 장르에 최적화된 해설 전략(자막 우선, 감정 중심, 분위기 묘사 등)을 선택하도록 구조화했습니다.
    2.  **인물 파악 0순위 규칙 격상:** 장르 분석보다 앞선 '프로세스 0단계'로 인물 및 고유명사 사전 파악을 명시하여, 어떤 장르에서도 인물 이름을 첫 등장부터 사용하도록 강력하게 지시했습니다.
    3.  **자막 낭독 로직 정교화:** '귀로 들을 수 없는 정보'만 전달하는 것을 원칙으로 설정했습니다. 한국어 음성과 일치하는 자막은 절대 읽지 않도록(중복 금지) 하고, 외국어 번역 자막이나 소리 없는 화면 텍스트만 [txt] 태그로 처리하여 노이즈를 획기적으로 줄였습니다.

### 62차: 자막 분리 낭독 기능 및 재생 속도 개인화 기능 추가
- **문제 1 (정보 과다):** AI가 생성하는 일반 화면 해설과 화면 속 자막(OCR) 및 번역 정보가 섞여서 출력되어, 사용자가 특정 정보에 집중하기 어렵고 청취 피로도가 높았습니다.
- **문제 2 (재생 제어 미흡):** TTS(음성 해설)의 재생 속도가 고정되어 있어 사용자의 선호도에 따른 조절이 불가능했고, 해설 수준을 '없음'으로 설정하면 자막 정보까지 모두 차단되는 문제가 있었습니다.
- **문제 3 (맥락 단절):** 5초 단위의 프레임 추출 간격이 정적인 장면에서 시각적 맥락과 대사의 연결성을 떨어뜨리는 원인이 되었습니다.
- **해결:**
    1.  **자막(txt) 태그 신설 및 데이터 분리:**
        *   **프롬프트 수정:** AI에게 화면 속 텍스트 및 번역 정보는 `v1~v3` 대신 `[txt]` 태그를 사용하도록 지시하고, 외국어 자막 시 제공된 텍스트 데이터(`{{SUBTITLES}}`)를 번역하여 활용하도록 우선순위를 조정했습니다.
        *   **백엔드 로직 업데이트:** `videoProcessor.js`에서 `[txt]` 태그를 인식하여 `text` 타입으로 구분 저장하고, 0초 타임스탬프를 1초로 자동 보정하여 재생 누락을 방지했습니다.
    2.  **프론트엔드 UX 혁신:**
        *   **자막 읽기 전용 토글:** 화면 해설과 독립적으로 자막 정보만 켜고 끌 수 있는 기능을 추가했습니다. 해설 정도가 '없음'이어도 자막만 선택 청취가 가능합니다.
        *   **등급별 재생 속도 선택:** TTS 속도를 사용자가 직접 선택(1.5x: 초보, 2.5x: 중수, 3.5x: 고수)할 수 있게 했으며, 재생 중 변경 시 즉시 반영되도록 `useRef` 기반으로 최적화했습니다.
    3.  **처리 품질 강화:** 시각적 맥락을 더 촘촘하게 파악하여 대사와 해설의 연결성을 높이기 위해 프레임 추출 간격을 5초에서 **2초**로 단축했습니다.

### 61차: AI 화면 해설 프롬프트 고도화 (OCR 및 외국어 자막 낭독 강화)
- **문제:** 기존 프롬프트는 시각적 묘사에는 충실했으나, 외국어 인터뷰 시 화면 하단에 나오는 한국어 번역 자막이나 화면 속 중요한 텍스트 정보(간판, 문자 메시지 등)를 읽어주지 않아 시각 장애인 사용자가 핵심 정보를 놓치는 문제가 있었습니다.
- **해결:** `prompt_template.txt`를 전면 개정하여 다음과 같은 핵심 규칙을 추가했습니다.
    1.  **외국어 인터뷰 자막 필수 낭독:** 외국어 발언 시 하단에 한국어 번역 자막이 표시되면 이를 반드시 읽어주도록 `CRITICAL` 규칙을 부여했습니다.
    2.  **화면 내 텍스트(OCR) 인식 강화:** 제목, 장소 안내, 편지, 간판 등 오디오로 설명되지 않는 시각적 텍스트를 인식하여 읽어주도록 지시했습니다.
    3.  **상황 요약(Summary) 로직 도입:** 몽타주나 빠른 장면 전환 시 모든 프레임을 묘사하는 대신, 전체 흐름을 한 문장으로 요약하여 청취 피로도를 낮추도록 개선했습니다.
    4.  **인물 식별 일관성:** 전체 자막을 사전 분석하여 첫 등장부터 인물의 정확한 이름을 사용하도록 지침을 강화했습니다.

### 60차: 오류 처리 로직 고도화 및 접근성 개선
- **문제 1 (프론트엔드 오류 메시지 불분명):** 백엔드에서 전송하는 일부 오류(예: Gemini API 관련, URL 유효성, 일반 서버 오류 등)가 프론트엔드에서 구체적인 한국어 메시지로 변환되지 않고 일반적인 영문 메시지 또는 불분명한 안내로 사용자에게 표시되었습니다.
- **문제 2 (스크린리더 중복 안내):** 오류 메시지가 화면에 나타날 때, 스크린리더가 동일한 내용을 두 번 연속으로 읽어 사용자 경험을 저해했습니다.
- **문제 3 (레거시 코드 혼란):** 사용되지 않는 구버전의 `PlayerScreen.js` 파일이 코드베이스에 남아있어 개발 및 유지보수에 혼란을 주었습니다.
- **해결:**
    1.  **백엔드 오류 메시지 구조화 (`videoProcessor.js`):**
        *   운영 로그 분석을 통해 Gemini API 관련 오류(과부하/할당량 초과, 콘텐츠 거부) 및 기타 시스템 오류의 실제 메시지 패턴을 파악했습니다.
        *   `processVideo` 함수의 `catch` 블록에서 `errorMessage`를 분석하여 `'gemini_unavailable'`, `'gemini_rejection'`과 같은 구체적인 오류 코드를 생성해 프론트엔드로 전송하도록 로직을 강화했습니다.
    2.  **프론트엔드 오류 메시지 상세화 및 접근성 개선 (`PlayerScreenV2.js`):**
        *   백엔드에서 전송하는 모든 오류 코드(Gemini API 관련, URL 유효성, 일반 서버/DB 오류 등)를 `handleError` 함수에서 정확히 식별하고, 각각에 대응하는 사용자 친화적인 한국어 안내 메시지를 표시하도록 로직을 확장했습니다.
        *   오류 메시지 표시 시 `setError`와 `announcePolite`가 동시에 호출되어 스크린리더가 중복 안내하는 문제를 해결하기 위해, `announcePolite` 호출을 제거하고 `role="alert"` 속성을 통한 단일 알림 방식으로 통일했습니다.
    3.  **레거시 파일 제거 (`PlayerScreen.js`):**
        *   `App.js` 라우팅 설정에서 `/video-v1/:videoId` 경로를 제거하여 `PlayerScreen.js`가 더 이상 사용되지 않도록 조치했습니다.
        *   코드베이스 혼란을 방지하기 위해 `frontend/src/screens/PlayerScreen.js` 파일을 삭제했습니다.

### 59차: 재생 방식 선택 기능 추가 및 안정성 개선
- **문제 1 (기능 추가):** 사용자가 영상 시청 시, 화면 해설(TTS)이 나올 때 영상을 항상 '일시정지'하는 방식 외에, 영상과 해설을 '같이 재생'하는 옵션을 선택하고 싶다는 요구사항이 있었습니다.
- **문제 2 (버그):** 위 기능을 구현하는 과정에서, 첫 번째 해설만 정상적으로 재생되고 이후의 모든 해설이 재생되지 않는 치명적인 버그가 발생했습니다.
- **해결:**
    1.  **재생 방식 선택 기능 UI/UX 구현:**
        *   영상 재생 화면에 '일시정지'와 '같이 재생' 두 가지 모드를 선택할 수 있는 버튼 UI를 추가했습니다.
        *   사용자가 선택한 모드는 `useState`로 관리하여 UI에 즉시 반영되도록 했습니다.
    2.  **재생 로직 안정화 및 버그 수정:**
        *   **버그 원인:** '재생 방식'을 `useState`로 관리하고 이를 `useCallback` 함수의 의존성 배열에 포함시키자, 해당 콜백 함수가 불필요하게 계속 재생성되었습니다. 이는 `setInterval`을 사용하는 메인 재생 루프와의 타이밍 문제를 일으켜, 첫 해설 이후 루프가 멈추는 원인이 되었습니다.
        *   **해결:** `useState`와 별개로 `useRef`를 도입하여, 실제 재생 로직(조건부 일시정지)은 `useRef`에 저장된 값을 참조하도록 변경했습니다. `useRef`는 값이 변경되어도 리렌더링을 유발하지 않으므로, `useCallback` 함수가 안정적으로 유지되어 버그를 해결하고 기능의 안정성을 확보했습니다.

### 58차: 키프레임 추출 로직 강화, yt-dlp 호출 안정화 및 SSE 진행 알림 간소화
- **문제 1 (키프레임 추출 누락):** 장면 전환이 거의 없거나 영상 초반에 장면 전환이 없는 영상의 경우, `ffmpeg`의 장면 전환 감지 필터가 동작하지 않아 프레임이 전혀 추출되지 않는 문제가 발생했습니다. 이로 인해 AI가 화면 해설을 생성할 수 없었습니다.
- **문제 2 (yt-dlp 호출 비효율성 및 오류):** 기존에는 영상 메타데이터, 자막 다운로드, 영상 스트리밍을 위해 `yt-dlp`를 총 3번 호출했습니다. 이를 2회 호출로 줄이려던 시도가 `ffmpeg` 오류를 유발하여 안정성이 저해되었습니다.
- **문제 3 (SSE 진행 알림 과도):** 실시간 처리 시 프레임 추출 진행 상황 알림 메시지가 너무 상세하게 반복되어 사용자에게 방해를 줄 수 있었습니다.
- **해결:**
    1.  **키프레임 추출 로직 강화:** `ffmpeg`의 `select` 필터에 `isnan(prev_selected_t)` 조건을 추가하여 `select='isnan(prev_selected_t)+gt(scene,0.4)+gte(t-prev_selected_t,5)'`로 변경했습니다. 이로써 영상의 첫 프레임이 항상 추출되도록 보장하여, 장면 전환이 없거나 초반에 없는 영상에서도 최소한의 프레임을 확보하고 5초 간격 추출 규칙이 올바르게 동작하도록 했습니다.
    2.  **yt-dlp 호출 안정화 (원상 복구):** `yt-dlp` 명령 하나로 영상 스트리밍과 자막 파일 저장을 동시에 처리하려던 시도가 `ffmpeg` 오류를 유발함에 따라, 안정성을 위해 원래의 3회 호출 방식(메타데이터 -> 자막 다운로드 -> 영상 스트리밍)으로 되돌렸습니다.
    3.  **SSE 진행 알림 간소화:** 실시간 처리(`processVideo`) 시 프레임/자막 추출 단계에서 SSE `status_update` 메시지를 간소화했습니다. 처음에는 "프레임/자막 처리 중..."으로 안내하고, 이후 업데이트는 "xx%"와 같이 진행률만 표시하도록 변경하여 알림의 피로도를 줄였습니다.

### 57차: 전반적인 접근성 및 관리자 페이지 개선
- **문제 1 (스크린리더 포커스 불일치):** 모바일 및 PC 환경에서 스크린리더가 페이지 내용을 사용자의 의도대로 읽지 않거나, 특정 정보 그룹을 건너뛰거나, 중복/이상하게 읽는 문제가 발생했습니다. 특히 '게시글 상세' 화면의 '작성자/작성일' 정보와 '댓글' 목록에서 이런 현상이 두드러졌습니다.
- **문제 2 (전역 포커스 관리 미흡):** 새로운 페이지 로드 시 스크린리더의 포커스가 페이지 최상단으로 이동하지 않아 사용자가 새로운 컨텍스트를 파악하기 어려웠습니다. 또한, URL 변경 없이 컴포넌트 내부 뷰가 전환될 때(예: '더보기' 화면에서 '서비스 이용 안내' 뷰로 전환) 포커스 관리가 이루어지지 않았습니다.
- **문제 3 (관리자 페이지 정보 불필요/부족):** 관리자 페이지 대시보드의 '실패한 영상 목록'에 불필요한 'Video ID' 컬럼이 있었고, '콘텐츠 관리' 탭의 영상 목록에는 실패 원인을 파악할 수 있는 정보가 부족했습니다.
- **해결:** 서비스의 전반적인 접근성과 관리 효율성을 높이기 위해 다음 개선을 적용했습니다.
    1.  **스크린리더 포커스/읽기 개선:**
        *   **게시글 목록 (`BoardScreen.js`):** 각 게시글 항목(`Link`)에 포괄적인 `aria-label`을 부여하고, 내부 요소는 `aria-hidden="true"`로 숨겨 스크린리더가 게시글 전체 정보를 한 번에 읽도록 했습니다.
        *   **게시글 상세 (`PostScreen.js`) - 작성자/작성일:** `div`에 `role="group"`, `tabIndex="0"`(모바일 접근성 강화 목적), 그리고 모든 정보를 담은 `aria-label`을 적용했습니다. 내부 `span` 요소들은 `aria-hidden="true"`로 처리하여 중복 읽기를 방지하고, 하나의 탐색 지점으로 동작하도록 했습니다.
        *   **게시글 상세 (`PostScreen.js`) - 댓글 수:** `h2` 태그에 `aria-label="댓글 O개"`를 부여하고 시각적 텍스트는 `aria-hidden="true"`로 숨겨, 모바일에서 발생하던 이상 음독 문제를 해결하고 명확하게 읽히도록 했습니다.
        *   **게시글 상세 (`PostScreen.js`) - 개별 댓글:** 각 댓글 `li` 내부에 `div`를 새로 생성하고, 이 `div`에 `tabIndex="0"`, `role="group"`, 그리고 모든 댓글 정보를 포함하는 `aria-label`을 적용했습니다. 댓글의 시각적 내용은 `aria-hidden="true"`로 숨겨 PC의 "그룹이 비어 있음" 오류와 모바일에서의 댓글 건너뛰기 현상을 모두 해결했습니다.
    2.  **전역 페이지 포커스 관리 강화:**
        *   **`usePageFocus` 전역 적용:** 모든 주요 페이지(예: `HomeScreen`, `PlayerScreen`, `BoardScreen`, `PostScreen`, `CreatePost`, `Admin`)의 최상단 제목(`h1` 또는 `Header` 컴포넌트)에 `usePageFocus` 훅을 적용하여, 페이지 로드 시 항상 제목으로 포커스가 이동하도록 했습니다.
        *   **조건부 뷰 포커스 관리:** `MoreScreen.js`와 같이 URL 변경 없이 컴포넌트 내부 뷰가 전환될 때(예: '서비스 이용 안내' 열기/닫기), `useEffect` 훅과 `useRef`를 사용하여 새로 표시된 뷰의 제목으로 포커스를 이동시키고, 뷰가 닫힐 때는 이전 포커스 위치로 복원하도록 구현했습니다.
    3.  **관리자 페이지 개선:**
        *   **대시보드 '실패한 영상 목록':** 불필요한 'Video ID' 컬럼을 삭제하여 정보의 명확성을 높였습니다.
        *   **'콘텐츠 관리' 탭 '영상 관리':** 영상 목록에 '실패 원인' 컬럼을 추가하여 관리자가 실패한 영상의 원인을 쉽게 파악하고 대응할 수 있도록 했습니다.

### 56차: 관리자 페이지 기능 개선 및 게시판 관리 분리
- **문제:**
    1.  게시판 글 작성 후 '뒤로 가기' 시 글쓰기 화면으로 돌아가는 문제.
    2.  공지글 등록 과정이 복잡하고 관리자 인증이 통합되어 있지 않음.
    3.  게시판 및 댓글 입력 필드의 유효성 검사가 미비하여 데이터 신뢰성 저하.
    4.  하단 내비게이션 바가 스크롤에 따라 움직여 사용자 경험 저해.
    5.  관리자 페이지 UI가 복잡해지고, 게시판 관리 기능이 콘텐츠 관리 탭에 통합되어 비효율적.
- **해결:** 서비스 사용성과 관리 효율성을 대폭 향상시키기 위해 다음 개선을 적용했습니다.
    1.  **게시판 '뒤로 가기' 플로우 개선:** 글 작성 후 상세 페이지 이동 시 브라우저 히스토리 관리를 `replace: true` 옵션으로 변경하여, '뒤로 가기' 시 항상 글 목록으로 이동하도록 수정했습니다.
    2.  **통합 공지글 등록 시스템 구현:**
        *   **백엔드 (`database.js`, `routes.js`)**: 관리자 비밀번호를 DB `settings` 테이블에서 중앙 관리하도록 변경하고, 게시글 생성 API(`POST /api/board/posts`)에서 '공지로 등록' 여부와 함께 전달된 관리자 비밀번호를 검증하는 로직을 추가했습니다.
        *   **프론트엔드 (`Admin.js`, `CreatePost.js`)**: `Admin.js`에 관리자 비밀번호 변경 UI를 추가했으며, `CreatePost.js`에 '공지로 등록' 체크박스와 조건부 '관리자 비밀번호' 입력 필드를 추가하여 폼 제출 시 함께 전송하도록 했습니다.
    3.  **입력 필드 유효성 검사 강화:**
        *   게시판 글쓰기 (`CreatePost.js`), 영상 댓글 (`Comments.js`), 게시판 댓글 (`PostScreen.js`)의 폼 필드(닉네임, 비밀번호, 제목, 내용)에 대해 최소 길이(예: 닉네임 2자, 비밀번호 4자, 제목 2자, 내용 2~5자 이상) 및 빈 값 검사를 추가하고, 공백 제거(`trim()`) 처리를 적용하여 데이터 신뢰성을 높였습니다. `useRef` 방식 대신 `useState`로 폼 데이터 관리를 리팩토링했습니다.
    4.  **하단 내비게이션 바 고정:** `Layout.css`에서 `height: 100vh`, `overflow-y: auto`, `flex-grow: 1` 속성을 제거하여 페이지 전체 스크롤을 활성화하고, `BottomNav`가 `position: fixed` 속성에 따라 화면 하단에 항상 고정되도록 수정했습니다.
    5.  **관리자 페이지 UI 재구성 및 게시판 관리 분리:**
        *   `Admin.js`의 깨진 UI를 복원하고, 모든 탭(대시보드, 콘텐츠 관리, 비용 관리, 서비스 설정)의 내용이 정상적으로 표시되도록 수정했습니다.
        *   '콘텐츠 관리' 탭 옆에 '게시판 관리'라는 새로운 탭을 추가하여 게시판 글/댓글 관리 기능을 완전히 분리했습니다.
        *   새로운 '게시판 관리' 탭에서 게시판 글/댓글 목록 조회, 검색, 페이지네이션, 관리자 권한 삭제 기능(`DELETE /api/admin/board/posts/:id`, `DELETE /api/admin/board/comments/:id`)을 구현했습니다. 이를 위해 **백엔드 (`database.js`, `routes.js`)**에 관리자용 조회/삭제 DB 함수 및 API 엔드포인트를 추가했습니다.
        *   프론트엔드 검색 기능에서 디바운싱 로직을 제거하고, 명시적인 검색 버튼 클릭 또는 엔터 키 입력으로 검색이 실행되도록 변경하여 스크린리더 사용성을 개선했습니다.
        *   `useEffect` 훅의 의존성 문제를 해결하여 코드 안정성을 높였습니다.

### 42차: 관리자 페이지 - 비용 관리 탭 및 대시보드 기능 고도화
- **문제:** 기존 '후원금 관리' 및 'API 비용 내역'은 모든 데이터를 한 번에 불러와 목록이 길어질수록 사용성이 저하되고, 특정 내역을 찾기 어려웠습니다. 대시보드에서 API 비용 현황을 파악하기 어려웠습니다.
- **해결:**
    -   **비용 관리 탭:** '후원금 관리' 및 'API 비용 내역'에 페이지네이션, 검색 기능을 추가했습니다. 'API 비용 내역'에는 비용이 큰 순서로 정렬하는 기능도 포함했습니다.
    -   **대시보드:** 'API 비용 요약' 섹션을 추가하여 오늘, 최근 7일, 최근 30일간의 API 비용을 원화(KRW)로 환산하여 카드 형태로 표시했습니다.

### 43차: 관리자 페이지 - 서비스 설정 탭 추가 및 핵심 기능 구현
-   **문제:** 서비스의 주요 동작(영상 길이 제한, 생성 중지, 환율)을 코드 수정 없이 변경할 수 있는 중앙 관리 기능이 없었습니다.
-   **해결:**
    -   **백엔드 (`database.js`, `routes.js`, `videoProcessor.js`):**
        -   `settings` 테이블을 생성하고 설정값을 저장/조회/수정하는 기능을 구현했습니다.
        -   `GET /api/admin/settings`, `PUT /api/admin/settings` API 엔드포인트를 추가했습니다.
        -   영상 처리 로직(`routes.js`의 `/process` 및 `videoProcessor.js`)에 '신규 화면 해설 생성 중지' 및 '영상 길이 제한' 설정을 반영하여 동적으로 동작하도록 했습니다.
    -   **프론트엔드 (`Admin.js`, `Admin.css`):**
        -   '서비스 설정' 탭과 패널 UI를 추가했습니다.
        -   영상 길이 제한(드롭다운), 신규 화면 해설 생성 중지(토글), 환율 설정(숫자 입력) UI를 구현하고, 변경된 설정을 저장하는 기능을 추가했습니다.
        -   관련 CSS를 추가하여 UI를 개선했습니다.

### 44차: 메인 페이지 - 실시간 운영 현황 환율 반영 및 생성 중지 UX 개선
-   **문제:**
    -   메인 페이지의 '실시간 운영 현황'에 관리자 설정 환율이 반영되지 않았습니다.
    -   '생성 중지' 상태일 때, 새로운 유튜브 영상을 선택하면 재생 화면으로 이동한 후에야 오류를 표시하여 사용자 경험이 좋지 않았습니다.
    -   영상 길이 제한 에러 메시지가 동적으로 설정된 값을 반영하지 못했습니다.
-   **해결:**
    -   **백엔드 (`routes.js`):** `GET /api/financial-summary` API가 환율(`exchangeRate`) 및 '생성 중지' 상태(`processingPaused`)를 함께 반환하도록 수정했습니다.
    -   **프론트엔드 (`App.js`):**
        -   `HomeScreen`에서 API로부터 받은 환율을 사용하여 운영비 잔액을 정확히 계산하고 표시하도록 수정했습니다.
        -   '생성 중지' 상태일 때, 유튜브 검색 결과에서 새로운 영상을 선택하면 재생 화면으로 이동하지 않고 홈 화면에 즉시 오류 메시지를 표시하도록 UX를 개선했습니다. 또한, 입력창 플레이스홀더와 버튼 활성화 로직도 상태에 따라 동적으로 변경되도록 했습니다.
        -   영상 길이 제한 에러 메시지가 백엔드에서 전달받은 실제 제한 시간 값을 반영하여 동적으로 표시되도록 수정했습니다.

### 45차: API 비용 계산 로직 수정 (공식 가격 정책 반영)
- **문제:** 기존 비용 계산 로직은 Gemini 2.5 Pro 모델의 입력/출력 토큰 비용을 구분하지 않고, 총 토큰 수에 단일 요금을 적용하여 실제 비용과 차이가 있었습니다.
- **해결:** 공식 가격 정책을 확인하여, 입력/출력 토큰 비용을 분리하고 총 토큰 수에 따른 계층적 요금제(Tiered Pricing)를 적용하도록 백엔드(`videoProcessor.js`)의 비용 계산 로직을 수정했습니다. 이를 통해 API 비용이 정확하게 추적되도록 개선했습니다.

### 40차: 요청 루프 버그 수정 및 30분 이상 영상 처리 제한
- **문제 1 (버그):** 후원금이 소진되었을 때, 프론트엔드가 영상 생성 요청을 반복적으로 보내 백엔드에 불필요한 부하를 주는 버그가 있었습니다.
- **해결 1:** 프론트엔드의 SSE(Server-Sent Events) 오류 처리 로직을 개선했습니다. 백엔드에서 오류가 발생하고 연결이 끊길 때, 여러 오류 이벤트가 동시에 발생하는 경쟁 상태(race condition)를 막았습니다. 이제 어떤 오류든 단 한 번만 처리되어 안정적으로 요청을 중단합니다.

- **문제 2 (비용):** 사용자가 매우 긴 영상을 요청할 경우, 과도한 API 비용이 발생할 수 있는 위험이 있었습니다.
- **해결 2:** 비용 절감을 위해 30분 이상의 영상은 처리하지 않도록 제한하는 기능을 추가했습니다.
    *   **백엔드:** 영상 처리 시작 전, YouTube API를 통해 영상의 실제 길이를 먼저 확인합니다. 영상 길이가 30분 이상일 경우, 처리를 즉시 중단하고 프론트엔드에 `duration_exceeded` 오류를 보냅니다.
    *   **프론트엔드:** 위 오류를 수신하면, 사용자에게 "30분이 넘는 영상은 비용 문제로 인해 처리할 수 없습니다." 라는 명확한 안내 메시지를 표시합니다.

### 39차: 후원금 기반 동적 서비스 제어 및 운영 현황 공개
- **문제:** 무분별한 영상 생성으로 인한 운영비 증가를 제어할 장치가 없었고, 사용자들은 서비스의 운영 현황을 알 수 없어 후원 참여 동기가 부족했습니다.
- **해결:**
    1.  **후원금 연동 서비스 제어:**
        *   영상 생성 요청이 들어올 때마다 실시간으로 후원금 잔액(총 후원금 - 총 사용액)을 확인하는 기능을 백엔드에 추가했습니다.
        *   잔액이 0원 이하일 경우, 영상 생성을 막고 사용자에게 "후원금이 소진되어 서비스를 이용할 수 없다"는 안내 메시지를 명확하게 전달하도록 구현했습니다.
    2.  **실시간 운영 현황 공개 (접근성 준수):**
        *   홈 화면 검색창 상단에 '실시간 운영 현황' 섹션을 추가하여, 모든 사용자가 서비스의 재정 상태를 쉽게 파악할 수 있도록 개선했습니다.
        *   '남은 운영비'와 함께 후원금 소진율을 나타내는 진행률 표시줄(progress bar)을 추가했습니다.
        *   스크린리더 사용자를 위해, 진행률 표시줄에 `aria-label`을 적용하여 "총 후원금 OOO원 중 OOO원 사용됨"과 같이 정확한 정보를 음성으로 전달하도록 접근성을 준수합니다.
    3.  **UI 명칭 및 안정성 개선:**
        *   서비스의 공식 명칭을 '뷰레이터'로 변경하고, 관련 UI 텍스트들을 일관성 있게 수정했습니다.
        *   기능 구현 과정에서 발생했던 React Hook 관련 ESLint 경고, 문법 오류, Hook 규칙 위반 오류 등 프론트엔드의 여러 버그들을 수정하여 코드 안정성을 확보했습니다.

### 38차: 관리자 페이지 추가 및 안정성 개선
- **문제:** 서비스 운영 비용(API, 서버 등)과 후원금 내역을 체계적으로 관리하고 추적할 방법이 없었습니다. 또한, 개발 과정에서 여러 기능적, 비기능적 버그들이 발견되었습니다.
- **해결:**
    1.  **관리자 페이지 신설 (`/admin`):** 서비스의 핵심 지표를 모니터링하고 관리할 수 있는 비밀번호 보호 페이지를 구현했습니다.
    2.  **비용 관리 기능 구현:**
        *   **대시보드:** 총 후원금, 총 API 사용 비용, 그리고 참고용 잔액을 한눈에 볼 수 있는 요약 대시보드를 추가했습니다.
        *   **비용/후원 내역 관리:** 후원 내역과 영상별 API 비용 발생 내역을 목록으로 보고, 후원 내역을 추가/삭제할 수 있는 CRUD 인터페이스를 구현했습니다.
    3.  **자동 비용 로깅:** 백엔드 영상 처리 로직(`videoProcessor.js`)에 API 비용(토큰 사용량 기반)을 계산하여 데이터베이스(`api_costs` 테이블)에 자동으로 기록하는 기능을 추가했습니다.
    4.  **접근성 및 안정성 개선:**
        *   관리자 페이지의 날짜 입력 필드를 스크린리더 사용자를 위해 접근성이 높은 개별 텍스트 필드(년, 월, 일)로 개선하고, 기본값으로 오늘 날짜가 입력되도록 하여 편의성을 높였습니다.
        *   후원금 추가 기능과 관련된 다수의 버그(잘못된 유효성 검사, 인증 헤더 유실, 컴파일 오류 등)를 해결하여 기능을 안정화시켰습니다.

### 36차: 사용자 댓글 기능 추가
- **문제:** 사용자들이 생성된 영상 해설에 대해 의견을 나누거나 피드백을 제공할 수 있는 소통 창구가 없었습니다.
- **해결:** 영상 재생 화면 하단에 완전한 CRUD(생성, 읽기, 수정, 삭제) 기능을 갖춘 댓글 시스템을 구현했습니다.
    1.  **프론트엔드:** 사용자가 닉네임과 비밀번호를 입력하여 댓글을 작성할 수 있는 UI를 추가했습니다. 본인이 작성한 댓글은 비밀번호를 통해 수정하거나 삭제할 수 있습니다.
    2.  **백엔드:** 댓글 CRUD 처리를 위한 API 엔드포인트 (`/api/comments/...`)를 신설했습니다. 비밀번호는 안전하게 해시 처리되어 저장 및 검증됩니다.
    3.  **데이터베이스:** `comments` 테이블을 새로 추가하여 각 댓글의 내용, 작성자 정보, 영상 ID를 저장하도록 스키마를 확장했습니다.

### 37차: 주요 제안 기능 구현
- **내용:** '향후 개선 제안'에 포함되어 있던 주요 기능들이 현재 코드베이스에 구현된 것을 확인하고, 이를 개선 기록에 정식으로 반영합니다.
    1.  **해설된 영상 라이브러리 및 검색:** 홈 화면에 이전에 생성된 영상 목록('이전 작업 목록')이 표시되며, 통합 검색창을 통해 DB에 저장된 영상을 제목으로 검색하는 기능이 구현되었습니다.
    2.  **소셜 공유 기능:** 영상 재생 페이지에 '공유' 버튼이 존재하며, 현재 페이지의 고유 URL을 클립보드에 복사하는 기능이 12차 개선 사항으로 구현되었습니다.
    3.  **후원/기부 시스템 연동:** '서비스 이용 안내' 팝업 내에 후원 기관 정보와 함께 '계좌번호 복사' 버튼이 구현되어, 서비스 유지를 위한 기부 경로를 안내하고 있습니다.

### 35차: VAD 제거 및 자막 기반 컨텍스트 강화
- **문제:** 기존 VAD(음성 활동 감지) 기술은 음성/비음성 구간을 완벽하게 분리하지 못해 해설이 대사와 겹치는 문제가 있었고, AI 프롬프트만 복잡하게 만들었습니다.
- **해결:** VAD 관련 로직을 전부 제거하고, 대신 `yt-dlp`를 이용해 YouTube의 자동 생성 자막(한국어)을 추출하도록 변경했습니다. 추출된 자막 전체를 시간 정보와 함께 AI 프롬프트에 제공하여, AI가 영상의 전체적인 대화 흐름과 문맥을 훨씬 더 정확하게 파악하고 고품질의 해설을 생성하도록 아키텍처를 개선했습니다.

### 34차: '더보기' 기능 접근성 개선 (포커스 관리)
- **문제:** '더보기' 버튼을 눌러 새로운 목록을 불러올 때, 스크린리더의 포커스가 '더보기' 버튼에 그대로 머물러 있거나 맨 위로 이동해버려, 사용자가 새로 추가된 콘텐츠를 인지하고 탐색하기 어려웠습니다.
- **해결:** '더보기' 버튼을 클릭하면, 새로운 항목이 로드되기 직전의 **현재 마지막 항목으로 포커스를 이동**시키도록 수정했습니다. 이를 통해 사용자는 로드된 새 항목들의 시작점 바로 앞에서 탐색을 이어갈 수 있어, 콘텐츠의 연속성을 유지하고 안정적인 사용자 경험을 제공하게 되었습니다. 이 기능은 초기 화면의 모든 목록('이전 작업 목록', 'DB 검색 결과', 'YouTube 검색 결과')에 일관되게 적용되었습니다.

### 33차: YouTube 검색 기능 고도화
- **문제:** 기존 YouTube 검색은 비공식 라이브러리를 사용하여 안정성이 떨어졌고, 검색 결과를 한 번에 모두 불러와 초기 로딩 속도에 영향을 줄 수 있었습니다.
- **해결:**
    1.  **검색 라이브러리 교체:** 안정적이고 공식적인 `googleapis` 라이브러리로 교체하여 검색 기능의 안정성과 확장성을 확보했습니다.
    2.  **페이지네이션(더보기) 기능 구현:** YouTube 검색 결과를 처음에는 20개만 불러오고, 사용자가 '더보기' 버튼을 누를 때마다 20개씩 추가로 불러오도록 변경하여 초기 화면의 로딩 속도와 사용성을 개선했습니다.

### 32차: gemini-2.5-pro 모델 도입 및 프롬프트 구조 개선
- **문제:** 기존 `gemini-1.5-pro` 모델의 컨텍스트 길이 제한으로 인해 긴 영상 처리 시 전체 맥락을 유지하기 어려웠습니다.
- **해결:**
    1.  **`gemini-2.5-pro` 모델로 업그레이드:** 더 긴 컨텍스트 창을 가진 `gemini-2.5-pro` 모델로 전환하여, 영상 전체의 프레임과 이전 대본을 한 번에 처리할 수 있게 되었습니다.
    2.  **점진적(Progressive) 처리 방식 유지:** 사용자 경험을 위해, 데이터는 점진적으로 계속 전송(SSE)합니다. 하지만 AI는 이제 전체 비디오 컨텍스트를 처음부터 알고 작업하므로, 생성되는 대본의 일관성과 품질이 크게 향상되었습니다.
    3.  **프롬프트 컨텍스트 구조 변경:** 기존에는 이전 '조각(chunk)'의 대본만 컨텍스트로 제공했지만, 이제는 AI가 생성한 '전체' 대본을 다음 요청에 포함시켜 AI가 항상 완전한 맥락을 가지고 다음 해설을 생성하도록 개선했습니다.

### 31차: 재생 화면 UI 간소화를 통한 접근성 향상
- **문제:** 기존 재생 화면은 상세 수준 조절, 전체 대본, 공유 등 여러 컨트롤이 항상 노출되어 있어 시각장애인 사용자가 핵심 기능인 영상 시청에 집중하기 어려웠습니다. 또한, 유튜브 플레이어 자체 컨트롤과 앱의 컨트롤이 혼재되어 조작이 복잡했습니다.
- **해결:**
    1.  **컨트롤 통합 및 간소화:** '음성 해설 켜기/끄기' 체크박스를 없애고, 상세 수준 조절 기능에 '없음' 단계를 추가하여 **(없음/최소/기본/최대)** 4단계로 통합했습니다.
    2.  **대본 표시 방식 변경:** 화면 해설 대본은 기본적으로 숨기고, '대본 보기' 버튼을 눌렀을 때만 펼쳐볼 수 있도록 하여 초기 화면의 복잡도를 낮췄습니다.
    3.  **단일 재생 컨트롤 구현:** 유튜브 플레이어의 기본 컨트롤을 숨기고, 영상 위에 항상 표시되는 **중앙 재생/일시정지 버튼**으로만 재생을 제어하도록 변경했습니다. 이 버튼은 재생 중에는 투명하게 처리되고 마우스를 올리면 나타나, 시청 경험과 조작 편의성을 모두 개선했습니다.

### 30차: 프롬프트 품질 개선 및 A/B 테스트 환경 구축
- **문제:** 기존 프롬프트는 개선의 여지가 있었고, 여러 버전의 프롬프트를 체계적으로 비교하고 테스트할 방법이 없었습니다. 또한 테스트 과정에서 `yt-dlp`의 안정성 문제가 발견되었습니다.
- **해결:**
    1.  **A/B 테스트 스크립트 개발:** 다양한 프롬프트를 쉽게 비교 테스트할 수 있는 독립적인 테스트 스크립트(`run_batch_single.js`)를 개발했습니다. 이 스크립트는 DB 연동 없이 터미널에서 바로 결과를 확인할 수 있어 신속한 프롬프트 튜닝이 가능합니다.
    2.  **프롬프트 고도화:** A/B 테스트를 통해 프롬프트를 체계적으로 개선했습니다. 특히, AI가 불필요한 해설을 생략할 수 있는 **'침묵할 재량권'**을 부여하고, **'인물 지칭 일관성'** 및 **'분위기 묘사'** 규칙을 강화하여, 최종적으로 해설의 양을 약 50% 줄이면서도 품질은 더 높은 v4 프롬프트를 완성했습니다.
    3.  **개발 환경 안정화:** 테스트 과정에서 발견된 `yt-dlp`의 코덱 및 경로 문제를 해결하고, `brew`를 이용한 올바른 업데이트 절차를 확립하여 개발 환경의 안정성을 높였습니다.

### 29차: 백엔드 프롬프트 관리 방식 개선
- **문제:** 기존에는 실시간 및 배치 처리 프롬프트가 `videoProcessor.js` 코드 내에 직접 하드코딩되어 있어, 수정 및 테스트가 번거롭고 일관성 유지가 어려웠습니다.
- **해결:**
    1.  모든 프롬프트 로직을 `prompt_template.txt`라는 외부 파일로 분리했습니다.
    2.  `videoProcessor.js`의 실시간 및 배치 처리 함수가 시작될 때 이 파일을 동적으로 읽어오도록 수정했습니다.
    3.  이를 통해, 이제 `prompt_template.txt` 파일 하나만 수정하면 두 기능 모두에 일관되게 프롬프트 변경이 적용되어 유지보수성이 크게 향상되었습니다.

### 28차: 모바일 재생 안정성 강화 및 재생 속도 로직 수정
- **문제 1 (모바일 재생 불가):** 아이폰/사파리 등 일부 모바일 브라우저의 엄격한 자동 재생 정책으로 인해, 첫 재생 이후의 음성 해설(TTS)이 자동으로 재생되지 않는 문제가 있었습니다.
- **해결 1:** 오디오 재생 로직을 근본적으로 재구성하여 문제를 해결했습니다.
    1.  **통합 재생 버튼 UI 적용:** 영상 위에 자체적인 재생 버튼 오버레이를 추가하여, 사용자의 첫 상호작용을 명확하게 받아내도록 UI를 개선했습니다.
    2.  **단일 오디오 객체 재사용:** 기존에 매번 새로운 오디오 객체를 생성하던 방식에서, 앱이 로드될 때 단 하나의 오디오 객체만 생성하여 `useRef`로 유지하고 재사용하는 방식으로 변경했습니다. 사용자의 첫 클릭으로 이 단일 객체의 재생 권한을 얻은 뒤, 이후 모든 음성 해설은 이 객체의 소스(`src`)만 교체하여 재생함으로써 iOS의 자동 재생 정책을 준수하고 안정적인 재생을 보장하게 했습니다.
- **문제 2 (재생 속도 초기화):** 새로운 음성 해설이 재생될 때마다 오디오 객체의 `src`가 변경되면서, 이전에 설정했던 재생 속도(`playbackRate`)가 기본값(1.0)으로 초기화되는 버그가 있었습니다.
- **해결 2:** 재생 속도 설정 코드의 위치를, 최초 1회만 설정하던 로직에서 음원 소스(`src`)가 변경될 때마다 매번 다시 설정하는 `playAudioFromUrl` 함수 내부로 이동하여, 재생 속도가 일관되게 유지되도록 수정했습니다.

### 27차: 시스템 안정성 및 예외 처리 대폭 강화
- **문제 1 (DB Foreign Key 오류):** 영상의 첫 부분에 해설을 생성할 만한 장면이 없는 경우, 부모 레코드(`videos`)가 생성되기도 전에 자식 레코드(`scripts`)를 삽입하려다 `FOREIGN KEY` 제약 조건 위배 오류가 발생하며 전체 프로세스가 멈추는 문제가 있었습니다.
- **문제 2 (무한 재처리 루프)::** 위 문제를 해결하는 과정에서, 처리에 실패한 영상과 성공했지만 원래 대본이 없는 영상을 구별하지 못해, 프론트엔드가 후자의 경우에도 무한정 재처리를 시도하는 잠재적 오류가 발견되었습니다.
- **해결:** 데이터베이스 스키마를 확장하고 백엔드와 프론트엔드의 상태 관리 로직을 전면 수정하여 시스템의 안정성과 예측 가능성을 대폭 향상시켰습니다.
    1.  **DB 스키마 확장:** `videos` 테이블에 영상의 길이를 저장하는 `duration` 컬럼과, 처리의 현재 상태를 명확히 추적하는 `status` 컬럼(`processing`, `completed`, `failed`, `pending`)을 추가했습니다. 기존에 저장된 데이터가 문제를 일으키지 않도록, `ALTER TABLE` 시 `status`의 기본값은 `completed`로 설정하는 안전한 마이그레이션 전략을 적용했습니다.
    2.  **백엔드 로직 강화:** 영상 처리의 전체 생명주기에 걸쳐 `status`를 관리하도록 백엔드 로직을 수정했습니다. 이제 처리가 시작되면 `processing`으로, 성공적으로 끝나면 `completed`로, 오류가 발생하면 `failed`로 상태가 명확히 기록됩니다.
    3.  **프론트엔드 로직 지능화:** 프론트엔드가 API를 통해 `status` 값을 받아오도록 수정했습니다. 이제 `completed` 상태의 영상(스크립트 유무와 관계없이)은 그대로 보여주고, `failed` 또는 `pending` 상태의 영상에 대해서만 재처리를 시도하도록 하여 무한 루프 문제를 해결하고 예외 상황에 지능적으로 대처하게 되었습니다.
    4.  **UX 개선:** 첫 화면의 '이전 작업 목록'과 '검색 결과'에는 `status`가 `completed`인 영상만 표시되도록 API를 수정하여, 사용자에게 항상 시청 가능한 깔끔한 목록을 제공하도록 개선했습니다.

### 1차: 오디오 겹침 문제 해결 (VAD 도입)
- **문제:** 기존 시스템은 영상의 음성 정보를 고려하지 않아, 화면 해설이 인물 대사나 중요한 효과음과 겹치는 문제가 발생.
- **해결:** `node-vad` 라이브러리를 도입하여 영상의 음성 활동을 분석. '음성 없는 구간'을 찾아내고, AI가 해당 구간에 해설을 배치하도록 프롬프트를 수정.

### 2차: VAD 및 프롬프트 미세 조정
- **문제:** 1차 개선 후, VAD의 'AGGRESSIVE' 모드가 조용한 대화까지 침묵으로 판단하여 여전히 대사를 끊는 문제가 발생. 또한, '반드시 침묵에만 해설하라'는 엄격한 규칙 때문에 중요한 장면의 해설이 누락되는 부작용 발생.
- **해결:**
    1.  VAD 모드를 `NORMAL`로 변경하여 음성 탐지 정확도를 높임.
    2.  AI 프롬프트를 '가급적 침묵 구간에 배치하되, 매우 중요한 장면은 예외를 허용'하도록 유연하게 수정.
    3.  이를 통해 대화 끊김 현상과 해설 누락 문제를 동시에 해결하여 최적의 균형점을 찾음.

### 3차: 컨텍스트 강화를 통한 품질 향상
- **문제:** AI가 영상의 전반적인 주제나 장르를 알지 못해 묘사가 다소 일반적일 수 있음.
- **해결:** `yt-dlp`로 영상의 제목을 추출하여 AI 프롬프트에 함께 제공. AI가 제목을 통해 영상의 맥락(예: 웹드라마, 숙취 상황)을 추론하여 더 구체적이고 수준 높은 해설을 생성하도록 유도. (예: '갈색 병 음료' -> '숙취 해소 음료')

### 4차: 개발 편의성 개선
- **문제:** `yt-dlp`의 상세한 다운로드 진행률 로그가 콘솔을 가득 채워 다른 중요 로그를 확인하기 어려움.
- **해결:** 모든 `yt-dlp` 호출에 `--no-progress` 옵션을 추가하여 불필요한 로그를 제거하고, 주요 프로세스 진행 상황만 깔끔하게 볼 수 있도록 수정.

### 5차: 쿠키 인증 추가
- **문제:** 연령 제한 등 로그인이 필요한 영상은 `yt-dlp`가 처리하지 못하는 문제가 있었음.
- **해결:** 모든 `yt-dlp` 호출에 `--cookies-from-browser safari` 옵션을 추가하여, 사용자의 로컬 사파리 브라우저 쿠키를 통해 인증된 세션을 사용할 수 있도록 함.

### 6차: 상세 수준(Verbosity) 조절 기능 추가
- **문제:** 모든 사용자에게 동일한 수준의 해설만 제공되어, 사용자가 원하는 상세함을 선택할 수 없었음.
- **해결:**
    1.  **백엔드:** Gemini 프롬프트를 수정하여 모든 키프레임에 대해 `v1`(핵심), `v2`(기본), `v3`(상세) 세 단계의 중요도를 태그하도록 변경.
    2.  **프론트엔드:** '최소/기본/최대' 세 단계로 상세 수준을 선택할 수 있는 UI를 추가. 기본값은 '기본'(v2)으로 설정. 선택된 수준에 따라 대본을 동적으로 필터링하여 보여주고 재생함.
    3.  **UI 개선:** 대본 제목에 현재 수준과 대본 수를 함께 표시 (`화면 해설 대본 (기본: 5개)`).

### 7차: 프론트엔드 안정성 및 접근성 개선
- **문제:** 상세 수준을 특정 상황(재생 중, TTS 출력 중)에서 변경하면 앱이 멈추거나 오작동하는 여러 버그가 발생. 또한, 스크린리더가 선택된 버튼을 '비활성화됨'으로 잘못 안내하는 문제가 있었음.
- **해결:**
    1.  **안정성:** 핵심 재생 로직을 `useEffect` 훅 기반으로 리팩토링하여, 상태 변경에 따른 데이터 불일치(stale closure) 문제를 해결하고 안정성을 크게 향상시킴.
    2.  **접근성:** 상세 수준 버튼에서 `disabled` 속성을 제거하고 `aria-pressed`를 사용하여, 스크린리더가 선택 상태를 명확하게 인지하도록 개선함.

### 8차: UI/UX 개편 및 데이터베이스 전환
- **문제:** 초기 화면이 URL 입력창만 있어 재시청이 불편했고, 파일 기반 캐시는 목록 관리에 비효율적이었습니다. 또한 스크린리더 사용 시 UI 요소에 포커스가 두 번 잡히는 접근성 문제가 있었습니다.
- **해결:**
    1.  **데이터베이스 도입:** 캐시 시스템을 기존의 JSON 파일 방식에서 **SQLite** (`better-sqlite3` 사용) 데이터베이스로 전환하여, 데이터 관리 효율성과 확장성을 높였습니다.
    2.  **홈 화면 구현:** 앱 시작 시 이전에 처리한 영상 목록을 보여주는 홈 화면을 구현했습니다. 이를 통해 사용자는 URL을 다시 입력할 필요 없이 이전에 본 영상을 쉽게 다시 선택할 수 있습니다.
    3.  **UI 구조 개편:** 프론트엔드 앱을 `HomeScreen`(목록 및 입력)과 `PlayerScreen`(영상 재생)의 두 가지 뷰로 명확히 분리하여 사용자 경험(UX)을 개선했습니다.
    4.  **접근성 버그 수정:** 스크린리더에서 '음성 해설 활성화' 토글에 포커스가 두 번 잡히는 문제를, `aria-label`과 `aria-hidden`을 사용한 올바른 접근성 패턴으로 복원하여 해결했습니다.

### 9차: 아키텍처 개편 (응답 속도 및 비용 최적화)
- **문제:** 기존 방식은 영상 전체를 처리하고 모든 오디오를 생성할 때까지 사용자가 기다려야 하는 긴 초기 로딩 시간 문제가 있었습니다.
- **해결:**
    1.  **점진적 대본 생성 (Progressive Script Generation):** 백엔드가 영상을 1분 단위의 작은 조각으로 나누어 순차적으로 처리합니다. 첫 조각의 대본을 즉시 사용자에게 보내 초기 응답 속도를 획기적으로 개선하고, 다음 조각을 백그라운드에서 처리합니다. 이 때, 이전 대본을 다음 프롬프트에 포함하여 AI가 전체 맥락을 유지하도록 합니다.
    2.  **하이브리드 TTS 캐싱 (Hybrid TTS Caching):** `POST /api/tts` 엔드포인트를 신설했습니다. 프론트엔드는 필요한 시점에만 오디오를 요청하며, 백엔드는 최초 요청 시에만 TTS API를 호출하여 오디오를 생성하고 그 결과를 서버에 파일로 캐시합니다. 이후의 모든 요청은 캐시된 파일을 사용하여 API 비용을 절감하고 응답 속도를 높입니다.
- **효과:** 사용자의 초기 대기 시간을 획기적으로 단축시켰으며(Time-To-First-Description 단축), TTS API 호출을 최소화하여 비용을 최적화했습니다. 기존의 상세 수준 조절(Verbosity) 및 VAD 기능은 새로운 아키텍처와 완벽히 호환됩니다.

### 10차: 프롬프트 생성 방식 변경
- **문제:** 기존 프롬프트 생성 방식이 템플릿 리터럴을 사용하여 코드의 일관성이 부족했습니다.
- **해결:** `videoProcessor.js`에서 AI 프롬프트를 생성하는 부분을 템플릿 리터럴 (` `` `) 방식에서 문자열 접합 (`+`) 방식으로 변경하여 코드의 일관성을 개선했습니다.

### 11차: 배치 처리 기능 추가
- **문제:** 실시간 스트리밍 방식 외에, 전체 비디오를 한 번에 처리하는 배치 기능이 필요했습니다.
- **해결:**
    1.  **배치 처리 함수 추가:** `videoProcessor.js`에 `processVideoBatch` 함수를 추가했습니다. 이 함수는 비디오의 모든 프레임을 한 번에 모아 AI에 요청하여 전체 스크립트를 생성하고 데이터베이스에 저장합니다. 기존의 실시간 스트리밍(SSE) 및 분할 처리 로직은 제거되었습니다.
    2.  **엔드포인트 로직 수정:** 기존의 `POST /api/batch-process` 엔드포인트가 새로운 `processVideoBatch` 함수를 호출하도록 수정하여, 'fire-and-forget' 방식의 백그라운드 배치 처리가 가능하도록 구현했습니다.

### 12차: 재생 페이지 공유 기능 추가
- **문제:** 생성된 화면 해설 영상 재생 페이지를 다른 사람과 공유할 방법이 없었습니다.
- **해결:**
    1.  **라우팅 도입:** `react-router-dom`을 도입하여 각 영상 재생 페이지에 고유한 URL(예: `/video/VIDEO_ID`)을 부여했습니다.
    2.  **공유 버튼 추가:** 재생 페이지에 '공유' 버튼을 추가했습니다. 이 버튼을 클릭하면 현재 페이지의 URL이 클립보드에 복사되어 다른 사람에게 쉽게 전달할 수 있습니다.

### 13차: 홈 화면 UX 개선 (통합 검색)
- **문제:** 첫 화면에서 새로운 영상을 생성하는 URL 입력창과 기존 영상을 찾는 목록이 분리되어 있어 사용성이 떨어졌습니다.
- **해결:** URL 입력창과 검색창을 하나로 통합했습니다. 사용자가 입력을 시작하면, 입력 내용이 URL 형식인지 텍스트인지에 따라 아래 목록이 동적으로 반응합니다.
    - **URL 입력 시:** '새로 생성' 버튼이 활성화됩니다.
    - **일반 텍스트 입력 시:** 해당 텍스트가 포함된 영상 제목을 기존 목록에서 실시간으로 필터링하여 보여줍니다.

### 14차: 성능 및 확장성 개선
- **문제:** 이전에 생성한 영상 목록이 많아질 경우, 첫 화면 로딩 시 모든 목록을 불러오는 현재 방식은 성능 저하를 유발할 수 있다는 우려가 제기되었습니다.
- **해결:**
    1.  **백엔드 API 추가:** 특정 영상이 DB에 이미 존재하는지 빠르게 확인할 수 있는 `GET /api/video-exists/:videoId` API를 신설했습니다.
    2.  **프론트엔드 로직 변경:** 사용자가 URL을 입력하고 제출하면, 전체 목록을 확인하는 대신 새로운 API를 호출하여 해당 영상의 존재 여부만 DB에 직접 확인하도록 변경했습니다. 영상이 존재하면 바로 재생 화면으로 이동하고, 없으면 그때 새로운 생성 절차를 시작합니다.
    3.  **효과:** 이 방식으로 변경하여, 생성된 영상이 아무리 많아져도 첫 화면의 로딩 속도에 영향을 주지 않고 URL 중복 생성 시도를 효율적으로 처리할 수 있게 되었습니다.

### 15차: 홈 화면 UX 개선 (통합 검색)
- **문제:** 첫 화면에서 새로운 영상을 생성하는 URL 입력창과 기존 영상을 찾는 목록이 분리되어 있어 사용성이 떨어졌습니다.
- **해결:** URL 입력창과 검색창을 하나로 통합했습니다. 사용자가 입력을 시작하면, 입력 내용이 URL 형식인지 텍스트인지에 따라 아래 목록이 동적으로 반응합니다.
    - **URL 입력 시:** '새로 생성' 버튼이 활성화됩니다.
    - **일반 텍스트 입력 시:** 해당 텍스트가 포함된 영상 제목을 **로컬 DB와 YouTube에서 동시에 검색**하여, 'DB 검색 결과'와 'YouTube 검색 결과'로 나누어 실시간으로 보여줍니다.

### 16차: 안정성 강화 (중복 실행 및 재생 오류 수정)
- **문제 1 (중복 실행):** React 개발 모드의 `StrictMode`로 인해, 새로운 영상 생성 시 처리 프로세스가 중복으로 호출되어 파일 시스템 오류 및 API 할당량 초과 에러가 발생했습니다.
- **해결 1:**
    - **백엔드:** `videoProcessor.js`에 잠금(Lock) 메커니즘을 구현하여, 동일 영상에 대한 처리가 동시에 실행되는 것을 원천적으로 방지했습니다. 중복 요청 시에는 클라이언트에 `duplicate_request` 이벤트를 보냅니다.
    - **프론트엔드:** `PlayerScreen`이 `duplicate_request` 이벤트를 수신하면, 이를 오류로 간주하지 않고 해당 연결을 조용히 무시하도록 수정하여 더 이상 에러가 발생하지 않도록 했습니다.
- **문제 2 (무한 재생):** 첫 번째 음성 해설(TTS)이 시간과 관계없이 계속 반복 재생되는 버그가 있었습니다.
- **해결 2:** `PlayerScreen`의 재생 로직에서, 음성 해설 재생 상태가 전체 비디오 재생 상태에 영향을 주어 무한 루프를 일으키는 의존성 문제를 찾아내고, 이를 제거하여 버그를 수정했습니다.

### 17차: 검색 기능 및 UI/UX 개선
- **문제:** 검색 결과가 최대 10개만 표시되고 정보(제목만)가 빈약했으며, 타이핑 후 자동으로 검색되는 방식이 사용자 의도와 맞지 않고 접근성도 떨어졌습니다.
- **해결:**
    1.  **결과 확대 및 상세 정보 추가:** YouTube 검색 결과 수를 20개로 늘리고, 각 항목에 채널명, 조회수, 영상 길이를 추가로 표시하여 정보의 질을 높였습니다.
    2.  **명시적 검색 실행:** 사용자가 입력을 멈추면 자동으로 검색되던 디바운싱 방식을 제거했습니다. 대신, 사용자가 검색어를 입력하고 **엔터 키**를 누르거나 **'검색 또는 생성' 버튼**을 클릭해야만 검색이 실행되도록 변경하여 사용자 제어권을 강화하고 예측 가능성을 높였습니다.

### 18차: 스크린리더 접근성 대폭 향상
- **문제:** 동적인 상태 변경(로딩, 검색, 오류 등)에 대한 피드백이 없어 스크린리더 사용자가 상황을 인지하기 어려웠고, 검색 결과 항목의 정보가 분절적으로 전달되었습니다.
- **해결:**
    1.  **`aria-live` 알림 도입:** 앱의 주요 상태 변화(예: "검색 중입니다", "링크가 복사되었습니다", "오류 발생")를 스크린리더가 즉시 음성으로 알려주는 `aria-live` 영역을 구현했습니다.
    2.  **알림 메시지 자동 초기화:** `aria-live` 영역의 메시지가 한번 출력된 후 DOM에 계속 남아있어 혼란을 주는 문제를 해결했습니다. 이제 알림은 음성 출력 후 자동으로 초기화되어 항상 최신 정보만 전달됩니다.
    3.  **검색 결과 접근성 개선:** 각 검색 결과 항목 전체를 감싸는 버튼에 영상의 모든 정보(제목, 채널, 조회수, 길이)가 포함된 `aria-label`을 추가했습니다. 이를 통해 스크린리더 사용자는 각 항목을 하나의 완성된 정보로 명확하게 들을 수 있습니다.

### 19차: TTS 재생 로직 안정화
- **문제:** TTS 재생 로직 내의 'Stale Closure' 문제로 인해, 첫 번째 해설 이후 TTS가 출력되지 않는 치명적인 버그가 발생했습니다.
- **해결:** `PlayerScreen`의 재생 로직을 근본적으로 재구성했습니다. 여러 `useEffect`로 분산되어 문제를 일으키던 로직을 하나로 통합하고, `useRef`를 사용해 마지막 재생 대본의 순번을 추적하도록 변경했습니다. 이로써 재생 루프가 항상 최신 상태를 참조하게 되어, TTS 출력이 누락되거나 멈추는 문제를 완전히 해결하고 재생 안정성을 확보했습니다.

### 20차: 실시간 대본 생성 시 중복 제거
- **문제:** 새로운 영상의 대본을 실시간으로 생성할 때, 동일한 대본이 중복으로 화면에 표시되고 음성으로 출력되는 문제가 있었습니다.
- **해결:** 프론트엔드에서 서버로부터 대본 조각(chunk)을 수신할 때, 각 대본 라인의 고유 ID를 기반으로 중복을 제거하는 로직을 추가했습니다. 이를 통해 항상 고유한 대본 목록만 유지하도록 하여 중복 문제를 해결했습니다.

### 21차: 상세 수준별 재생 흐름 개선
- **문제:** '기본' 또는 '최대' 상세 수준을 선택했을 때, 같은 시점에 v1, v2 등의 여러 해설이 연속으로 재생되어 영상 시청 흐름을 방해했습니다.
- **해결:** 대본 필터링 로직을 근본적으로 변경했습니다. 기존에는 선택된 상세 수준 이하의 모든 해설을 포함했지만, 이제는 각 시점(timestamp)별로 사용자가 선택한 상세 수준에 맞는 **가장 상세한 해설 단 하나만**을 선택하도록 수정했습니다. 이를 통해 재생 흐름의 끊김 현상을 해결하고 상세 조절 기능의 본래 의도를 명확히 했습니다.

### 22차: 전체 페이지 홈 링크 추가
- **문제:** 어느 페이지에서든 첫 화면으로 한번에 돌아갈 수 있는 일관된 방법이 없었습니다.
- **해결:** 모든 페이지 상단에 공통으로 표시되는 '유튜브 화면 해설 생성기' 제목 전체를 첫 화면(`/`)으로 이동하는 링크로 만들었습니다. 이를 통해 사용자 편의성을 향상시켰습니다.

### 23차: 모바일 반응형 디자인 적용
- **문제:** PC 화면에만 최적화되어 있어, 모바일 기기에서 볼 때 레이아웃이 깨지고 사용하기 불편했습니다.
- **해결:** CSS 미디어 쿼리(`@media`)를 사용하여 반응형 디자인을 적용했습니다. 화면 너비가 600px 이하인 모바일 환경에서는 자동으로 레이아웃이 변경되도록 수정했습니다. (예: 컨트롤 버튼 세로 배치, 폰트 및 여백 조절 등)

### 24차: 서버 배포 및 초기 안정화
- **문제 1 (서버 배포 장애):** 실제 서버 환경에 배포하는 과정에서 여러 문제가 발생했습니다. `yt-dlp` 설치 시 파이썬 환경 충돌 오류, `pm2` 명령어 실행 불가, 배포 후 500 서버 에러 등 복합적인 이슈가 있었습니다.
- **해결 1:**
    1.  **배포 계획 수립:** `Nginx` 리버스 프록시와 `pm2`를 사용하는 표준 배포 계획을 수립하고 문서화(`deploy_plan.txt`)했습니다.
    2.  **설치 문제 해결:** `pip` 대신 `wget`으로 `yt-dlp` 바이너리를 직접 설치하여 파이썬 의존성 문제를 해결하고, `pm2`는 설치 경로를 찾아 심볼릭 링크를 생성하여 명령어 실행 문제를 해결했습니다.
    3.  **서버 에러 디버깅:** `pm2`와 `Nginx` 로그를 체계적으로 분석하도록 안내하여, 최종적으로 서버 디렉터리의 ‘쓰기 권한’ 문제임을 사용자가 발견하고 해결하도록 지원했습니다.
- **문제 2 (모바일 재생 오류):** 배포 후, 아이폰 등 모바일 환경에서 TTS 음성 해설이 재생되지 않는 현상이 발견되었습니다.
- **해결 2:** 원인이 모바일 브라우저의 엄격한 ‘자동 재생 정책’ 때문임을 진단했습니다. 사용자의 직접적인 터치 없이는 코드 기반의 오디오 재생이 차단되는 문제를 해결하기 위해, 재생 시작 전 사용자가 버튼을 눌러 오디오 컨텍스트를 ‘활성화’하는 ‘Audio Unlock’ 패턴을 해결책으로 제시했습니다.

### 25차: 개발 환경 안정성 및 스크린리더 안내 로직 개선
- **문제 1 (개발 환경 불안정):** 로컬 개발 환경에서 React 개발 서버의 프록시 기능이 특정 네트워크(모바일 핫스팟)에 연결 시 `Invalid options object` 오류를 내며 서버가 충돌하는 문제가 발생. 또한, 프록시 기능이 활성화되면 실시간 대본 생성(SSE) 스트림이 버퍼링되어 UI가 마지막에 한 번만 갱신되는 문제가 있었음.
- **해결 1:** 수많은 디버깅 끝에, `react-scripts`의 프록시 기능 자체의 불안정성을 확인하고 이를 완전히 우회하는 방식으로 최종 해결.
    1.  `package.json`의 `proxy` 설정은 일반 API 호출용으로 유지.
    2.  문제가 되었던 SSE 스트림(`EventSource`) 요청은, 개발 환경일 때만 백엔드(`http://localhost:4000`)로 직접 요청하도록 URL을 동적으로 변경하여 프록시를 거치지 않게 함. 이로써 개발 환경의 버퍼링 문제를 해결하고, 운영 서버 배포 시에도 문제가 없도록 구현.
- **문제 2 (스크린리더 안내 과다):** 대본 생성의 모든 단계(특히 반복적인 AI 처리)가 스크린리더로 안내되어, 영상 시청 시 사용자에게 혼란과 방해를 주었음.
- **해결 2:** 프론트엔드에서 `useRef` 플래그를 사용하여, "AI 대본 생성" 시작은 한 번만 안내하고, 이후 반복되는 진행 상황은 음성 안내에서 제외하도록 로직을 수정. 이를 통해 꼭 필요한 정보만 간결하게 전달하여 스크린리더 사용 경험을 크게 향상시킴.

### 26차: 백엔드 로깅 시스템 도입
- **문제:** 서버 운영 중 발생하는 이벤트나 오류를 추적하기 위한 체계적인 방법이 없었습니다. `console.log`는 실시간 확인에는 유용하지만, 문제 발생 후 원인을 분석하기에는 정보가 부족하고 영속성이 없었습니다.
- **해결:**
    1.  **파일 기반 로거 구현:** 모든 로그를 `backend/logs` 디렉터리 내에 날짜별 파일(예: `2025-10-16.log`)로 저장하는 `logger.js` 모듈을 구현했습니다.
    2.  **타임스탬프 및 레벨 적용:** 모든 로그 메시지에 KST(한국 표준시) 기준의 타임스탬프와 `[INFO]`, `[ERROR]` 등의 로그 레벨을 자동으로 추가하여 가독성과 추적 용이성을 높였습니다.
    3.  **전역 적용:** 백엔드의 모든 `console.log` 및 `console.error` 호출을 새로운 로거로 교체하여, 애플리케이션 전반의 모든 이벤트가 일관되게 기록되도록 시스템을 통합했습니다.

---

### 기능 및 SSE 통신 요약 (Functionality and SSE Communication Summary)

이 섹션은 프론트엔드와 백엔드의 책임 영역을 요약하고, 둘 사이의 실시간 통신을 가능하게 하는 Server-Sent Events(SSE)의 상세 사양을 기술합니다.

#### 백엔드 책임 (Backend Responsibilities)

Node.js 백엔드는 애플리케이션의 핵심 로직 및 데이터 처리 엔진 역할을 합니다. 주요 책임은 다음과 같습니다.
- **API 서버:** 프론트엔드와 통신하기 위한 RESTful API 및 SSE(Server-Sent Events) 엔드포인트를 제공합니다.
- **영상 및 자막 처리:** `yt-dlp`를 사용하여 영상 메타데이터(제목, 길이)를 가져오고, 자동 생성된 한국어 자막을 다운로드합니다.
- **키프레임 추출:** `ffmpeg`을 사용하여 영상 스트림을 분석하고 장면 전환에 따라 키프레임을 추출하여 AI의 시각적 입력으로 사용합니다.
- **AI 대본 생성:** **Google Gemini 2.5 Pro** 모델과 연동됩니다. 영상 제목, 전체 자막 텍스트, 추출된 모든 키프레임을 단일 요청으로 전송하여 문맥을 이해하는 화면 해설을 생성하고, 응답을 스트림으로 다시 받습니다.
- **실시간 통신 (SSE):** `/api/process` SSE 엔드포인트를 통해 상태 업데이트, 대본 조각, 오류를 프론트엔드로 실시간 전송합니다.
- **데이터베이스 관리:** **SQLite** (`better-sqlite3` 사용)를 이용하여 생성된 모든 영상 데이터(제목, 상태, 대본 등)를 캐시합니다. 또한 사용자 댓글, API 비용, 후원 내역, 서비스 설정 등을 관리합니다.
- **주문형 TTS (On-Demand TTS):** 프론트엔드의 요청에 따라 **Google Cloud TTS**를 사용하여 텍스트를 음성으로 변환하는 `/api/tts` 엔드포인트는 제공합니다. API 비용 최소화를 위해 강력한 파일 기반 캐싱 시스템을 구현했습니다.
- **관리자 및 재정 관리:** 콘텐츠 관리, 사용자 댓글, 재정 추적(후원금 vs 비용), 서비스 설정을 위한 포괄적인 관리자 기능을 포함합니다.

#### 프론트엔드 책임 (Frontend Responsibilities)

React 기반의 프론트엔드는 서비스와 상호작용하기 위한 접근성 높고 반응형인 사용자 인터페이스를 제공합니다.
- **사용자 인터페이스:** `HomeScreen`(탐색)과 `PlayerScreen`(소비)의 두 가지 화면 경험을 제공합니다.
- **통합 검색:** 사용자가 URL(신규 생성용) 또는 키워드(로컬 DB와 YouTube 동시 검색)로 영상을 검색할 수 있게 합니다.
- **실시간 피드백:** 백엔드의 SSE 엔드포인트에 연결하여 대본 생성 중 실시간 진행 상황 업데이트와 오류 메시지를 수신하고 표시합니다.
- **점진적 로딩:** 첫 번째 대본 조각이 도착하는 즉시 영상 재생을 시작하여 사용자가 느끼는 성능을 개선합니다.
- **커스텀 영상 플레이어:** `react-youtube`를 사용하며, 재생/일시정지를 위한 단순화된 커스텀 오버레이를 제공하여 네이티브 YouTube 컨트롤을 숨김으로써 더 나은 사용자 경험을 제공합니다입니다.
- **동적 오디오 재생:** 영상 재생에 맞춰 화면 해설 오디오를 주문형으로 가져와 재생하며, 주 영상 볼륨을 줄입니다. 모바일 브라우저에서의 안정성을 위해 재사용되는 단일 HTML5 오디오 요소를 사용합니다.
- **사용자 컨트롤:** 사용자가 해설의 상세 수준(`없음/최소/기본/최대`)을 조절하고, 대본 표시 여부를 토글하며, 해설된 영상의 직접 링크를 공유할 수 있게 합니다.
- **커뮤니티 기능:** 사용자가 각 영상에 댓글을 읽고 쓸 수 있는 완전한 CRUD 인터페이스를 포함합니다.
- **관리자 패널:** 관리자가 서비스를 관리할 수 있는 포괄적인 대시보드를 제공합니다.

---

#### 서버-전송 이벤트 (SSE) 사양

다음 이벤트들은 실시간 대본 생성 과정을 관리하기 위해 백엔드의 `/api/process` 엔드포인트에서 프론트엔드로 전송됩니다.

| 이벤트 이름 | 방향 | 페이로드 (JSON) | 설명 |
| :--- | :--- | :--- | :--- |
| `start` | B → F | `{ "videoId": "...", "title": "..." }` | 성공적인 프로세스 시작 시 한 번 전송됩니다. 클라이언트에 최종 영상 ID와 제목을 알립니다. |
| `status_update` | B → F | `{ "message": "..." }` | "주요 장면 프레임 추출 중... (55%)", "AI로 전체 대본 생성 중..."과 같이 사람이 읽을 수 있는 상태 업데이트를 여러 번 전송합니다. |
| `script_chunk` | B → F | `[{ "id": "...", "timestamp": ..., "text": "...", "verbosity": "v1" }, ...]` | AI에 의해 새로운 대본 조각이 생성될 때마다 전송됩니다. 페이로드는 하나 이상의 대본 라인 배열이며, 이를 통해 대본을 점진적으로 표시할 수 있습니다. |
| `end` | B → F | `{ "message": "Processing complete." }` | 전체 대본 생성 과정이 성공적으로 완료되고 모든 데이터가 저장되었을 때 한 번 전송됩니다. |
| `backend_error` | B → F | `{ "message": "...", "details": "..." }` | 백엔드에서 복구 가능하거나 치명적인 오류가 발생했을 때 전송됩니다. `message`는 기계가 읽을 수 있는 키(예: `duration_exceeded`, `funds_depleted`)이며, `details`는 사람이 읽을 수 있는 설명을 포함합니다. |
| `duplicate_request` | B → F | `{ "message": "This video is already being processed." }` | 이미 다른 요청에 의해 처리 중인 영상 ID에 대한 요청이 들어올 경우 전송됩니다. 프론트엔드는 이 이벤트를 수신하면 조용히 연결을 닫습니다. |

---

## 향후 개선 제안 (Future Improvement Suggestions)

향후 서비스의 발전을 위해 아래와 같은 기능 및 프롬프트 개선 방향을 제안합니다.

### 제안된 신규 기능 (Proposed New Features)

#### 1. OAuth 2.0 도입을 통한 인증 시스템 고도화
- **문제점:** 현재 시스템은 수동으로 갱신해야 하는 여러 개의 쿠키 파일에 의존하여 `yt-dlp` 인증을 처리합니다. 이 방식은 쿠키 만료 시 서비스가 중단될 수 있고, 주기적인 수동 작업이 필요하며, IP 기반 차단 등 유튜브의 제재에 취약한 구조입니다.
- **해결 방안:** 사용자가 'Google 계정으로 로그인' 하도록 하는 **OAuth 2.0 인증 흐름**을 도입합니다.
  - **인증 절차:** 사용자는 최초 1회만 자신의 구글 계정으로 서비스 사용을 허가합니다. 백엔드는 이때 발급받은 '리프레시 토큰'을 안전하게 저장하여, 이후 접속 시에는 사용자 모르게 백그라운드에서 새로운 '액세스 토큰'을 자동으로 발급받습니다.
  - **`yt-dlp` 연동:** 백엔드는 쿠키 파일 대신, 발급받은 액세스 토큰을 `--add-header "Authorization: Bearer [TOKEN]"` 옵션을 통해 `yt-dlp`에 전달하여 인증된 요청을 수행합니다.
- **기대 효과:**
  - **인증 안정성 확보:** 쿠키 만료로 인한 서비스 중단 문제를 원천적으로 해결하고, 반영구적인 자동 인증 시스템을 구축합니다.
  - **운영 효율성 증대:** 더 이상 주기적으로 쿠키를 수동 갱신할 필요가 없어집니다.
  - **비용 절감:** 인증된 사용자 요청은 비정상 트래픽으로 간주될 확률이 낮아지므로, IP 우회를 위한 유료 프록시 서비스의 필요성이 없어져 운영 비용을 절감할 수 있습니다.
  - **보안 강화:** 민감한 쿠키 파일을 서버에 저장하고 관리하는 대신, 표준화된 토큰 기반 인증 방식을 사용하므로 보안성이 향상됩니다.
- **필수 요건:** 이 기능을 구현하기 위해서는 Google Cloud Platform에서 프로젝트를 생성하고, YouTube Data API를 활성화해야 합니다. 또한, 일반 사용자에게 서비스를 제공하기 위해 구글의 **OAuth 앱 인증 절차**를 통과해야 합니다.

#### 2. 핵심 기능 강화 (품질 및 접근성 향상)
- **AI 기반 화면 텍스트(OCR) 및 시각적 설명:**
    - **문제점:** 현재 시스템은 영상 자체에 삽입된 텍스트(burned-in subtitles, 간판, 이름 등)를 직접 인식하고 읽어주지 못합니다. 시각장애인 사용자는 화면에 중요한 텍스트 정보가 있어도 이를 인지하기 어렵습니다.
    - **개선 방안:** 별도의 OCR 라이브러리를 추가하는 대신, Gemini 2.5 Pro 모델의 강력한 멀티모달 기능을 활용하여 AI가 직접 프레임 내의 텍스트를 인식하고 시각적 설명을 생성하도록 프롬프트를 고도화합니다.
    - **새로운 프롬프트 계획:**
        - **역할 정의:** AI의 역할을 "고급 OCR 기능이 탑재된, 시각장애인을 위한 전문가 오디오 해설가"로 재정의합니다.
        - **두 가지 핵심 지시사항:**
            1.  **첫 번째 임무: 화면 속 텍스트 인식 (OCR)**: 최우선으로 이미지를 스캔하여 눈에 보이는 모든 텍스트(삽입 자막, 간판, 제목 등)를 찾아내도록 지시합니다. 텍스트 감지 시, 반드시 "화면에 쓰인 자막:" 안내 문구와 함께 정확한 텍스트를 보고하도록 합니다.
            2.  **두 번째 임무: 시각적 장면 묘사**: 텍스트 보고 후에, 장면에 대한 간결한 시각적 묘사를 제공하도록 지시합니다.
        - **실행 규칙:**
            -   **순서 엄수:** 항상 텍스트 인식 임무를 먼저 수행하고, 그 다음 장면 묘사를 수행합니다.
            -   **텍스트가 없는 경우:** 텍스트가 없으면 텍스트 인식 임무는 건너뛰고 바로 장면 묘사로 넘어갑니다.
            -   **맥락 활용:** 제공된 전체 자막 정보를 대화 흐름 파악에 활용하고, 대사를 반복하지 않도록 합니다. 하지만, 화면에 직접 표시되는 모든 burned-in 텍스트는 반드시 읽어주도록 합니다.
            -   **출력 형식:** `[타임스탬프][v-레벨] 설명` 형식을 엄격하게 준수하도록 지시합니다.
    - **기대 효과:** 백엔드 코드의 복잡성을 줄이고(`tesseract.js`와 같은 OCR 라이브러리 추가 불필요), Gemini 모델의 뛰어난 이미지 분석 및 텍스트 인식 능력을 활용하여 더 정확하고 자연스러운 화면 해설을 제공할 수 있습니다.
- **커뮤니티 편집 기능 (위키 방식):** AI가 생성한 해설을 사용자들이 직접 수정하고 개선할 수 있는 기능을 제공하여 집단 지성으로 해설의 품질을 향상시킵니다.
- **다양한 음성 및 속도 조절:** 사용자가 선호하는 TTS 음성을 선택하고, 영상과 별개로 해설 음성의 재생 속도를 조절하여 개인화된 청취 경험을 제공합니다.
- **다국어 지원:** 한국어 외 다른 언어로도 화면 해설을 생성하여 서비스 대상을 전 세계로 확장합니다.

#### 3. 사용자 경험 고도화 (편의성 증대)
- **브라우저 확장 프로그램:** 유튜브 웹사이트에서 바로 화면 해설을 생성하고 재생할 수 있는 확장 프로그램을 개발하여 편의성을 극대화합니다.
- **사용자 계정 시스템:** 해설 생성 기록 관리, 개인화 설정(기본 상세 수준, 선호 음성 등) 저장 기능을 제공합니다.
- **대본 내 키워드 검색:** 생성된 대본에서 키워드를 검색하고 해당 장면으로 바로 이동하여 원하는 정보를 빠르게 찾을 수 있도록 돕습니다.
- **AI 기반 자동 카테고리 분류:** 사용자들이 주제별로 영상을 쉽게 찾아볼 수 있도록 자동 분류 기능을 도입합니다.
    - **1단계 (마스터 목록 생성):** 먼저, AI를 사용하여 기존 영상 제목들을 분석하고, 서비스에 가장 적합한 8-10개의 핵심 카테고리 목록을 생성합니다. 이 목록은 관리자의 검토 및 승인을 거칩니다.
    - **2단계 (기존 데이터 분류):** 일회성 배치 스크립트를 실행하여, 승인된 마스터 카테고리 목록을 기준으로 DB에 있는 모든 기존 영상들을 분류하고 `category` 필드에 저장합니다.
    - **3단계 (신규 데이터 자동 분류):** 새로운 영상을 처리할 때 사용하는 메인 프롬프트를 수정하여, AI가 화면 해설 스크립트 생성과 동시에 마스터 목록 내에서 가장 적합한 카테고리를 함께 출력하도록 합니다. 이 결과는 `videos` 테이블의 `category` 필드에 자동으로 저장됩니다.
    - **기대 효과:** 일관성 있는 카테고리 체계를 통해 사용자는 원하는 주제의 영상을 쉽게 모아볼 수 있으며, 서비스의 콘텐츠 탐색 경험이 크게 향상됩니다.

#### 4. 콘텐츠 발견 및 공유 (커뮤니티 활성화)
- **해설된 영상 라이브러리 및 검색:** 기존에 해설이 생성된 모든 영상의 라이브러리를 구축하고 검색 기능을 제공하여 사용자들이 양질의 콘텐츠를 쉽게 발견하도록 합니다.
- **소셜 공유 기능:** 해설이 적용된 영상 페이지를 외부에 쉽게 공유하여 서비스의 자연스러운 홍보를 유도합니다.

#### 5. 서비스 지속 가능성 확보
- **후원/기부 시스템 연동:** 서버 및 API 사용료 등 운영 비용 충당을 위해 사용자들이 자발적으로 후원할 수 있는 기능을 연동합니다.

#### 6. 인증 안정성 강화 (쿠키 자동 갱신) - 실패
- **문제점:** 현재 `yt-dlp`가 사용하는 `cookies.txt`는 개발자의 개인 계정에서 수동으로 추출해야 하므로, 쿠키 만료 시 서비스가 중단되고 보안에 취약합니다.
- **시도된 개선 방안 (실패):** 헤드리스 브라우저(Puppeteer)를 사용하여 쿠키를 자동으로 갱신하는 스크립트를 도입하는 것을 검토하고 테스트했습니다.
  - **테스트 결과:** **실패.** 유튜브는 자동화된 브라우저(헤드리스 포함)를 이용한 로그인을 감지하고 차단하는 고도화된 보안 정책을 사용하고 있습니다. 이로 인해 Puppeteer를 이용한 자동 로그인 및 쿠키 갱신 시도가 구글의 보안 정책에 의해 막혔으며, 안정적인 쿠키 확보가 불가능하다고 판명되었습니다.
- **결론:** 현재로서는 주기적으로 유효한 쿠키를 수동으로 갱신하는 방법 외에 안정적인 자동화 솔루션은 없는 것으로 판단됩니다.

#### 미해결 문제 (Unresolved Issues)
- **0초 화면 해설 재생 문제:** 영상의 00:00:00 시점에 설정된 화면 해설이 PC 및 모바일 환경에서 모두 재생되지 않는 문제가 있습니다. 이 문제는 브라우저의 오디오 자동 재생 정책과 비동기 오디오 로딩/재생 시점 간의 복잡한 상호작용으로 인해 발생하며, 추후 심층적인 분석과 해결책 모색이 필요합니다.

### 비용 최적화를 위한 프레임 필터링 (제안됨)

- **문제:** 현재 아키텍처는 장면 전환마다 모든 키프레임을 AI에 전송하므로, 대사가 있어 시각적 설명이 불필요한 장면의 프레임까지 처리하여 비용이 높게 발생합니다.
- **해결 방안:** 자막 데이터와 키프레임 데이터를 교차 분석하여, AI에 프레임을 보내기 전에 비용 효율적인 필터링 단계를 추가합니다.
  - **동작 방식:**
    1. `videoProcessor.js`에서 자막 파일(`.vtt`)을 파싱하여 모든 대사의 `[{시작, 종료}]` 시간 구간 배열을 생성합니다.
    2. 추출된 모든 키프레임의 타임스탬프를 순회하며, 해당 타임스탬프가 자막의 시간 구간 내에 포함되는지 확인합니다. (예: `timestamp >= range.start && timestamp <= range.end + 1.5s` 와 같이 약간의 버퍼를 둠)
    3. 자막으로 '커버'되는 프레임은 AI 요청에서 제외하고, 필터링된 프레임 목록만 AI 모델에 전송합니다.
  - **기대 효과:** AI에 전송되는 이미지 토큰의 수를 크게 줄여 처리 비용을 직접적으로 절감하고, 동시에 자막을 통해 전체 컨텍스트를 유지하는 기존의 장점은 그대로 보존합니다.
- **구현 코드 예시 (`videoProcessor.js`에 적용):**
  ```javascript
  // --- FRAME FILTERING LOGIC ---
  let finalTimestamps = [...allTimestamps];
  if (subtitleContent) {
      const subtitleRanges = [];
      const timeRangeRegex = /\((\d+\.?\d*)s\) --> \((\d+\.?\d*)s\)/g;
      let match;
      while ((match = timeRangeRegex.exec(subtitleContent)) !== null) {
          subtitleRanges.push({ start: parseFloat(match[1]), end: parseFloat(match[2]) });
      }

      if (subtitleRanges.length > 0) {
          const SUBTITLE_COVERAGE_SECONDS = 1.5; // Frame is covered if within 1.5s after a subtitle ends.
          finalTimestamps = allTimestamps.filter(timestamp => {
              const isCovered = subtitleRanges.some(range => 
                  timestamp >= range.start && timestamp <= (range.end + SUBTITLE_COVERAGE_SECONDS)
              );
              return !isCovered;
          });
          logger.info(`[${requestHash}] Filtered frames covered by subtitles. Original: ${allTimestamps.length}, Final: ${finalTimestamps.length}`);
      }
  }
  // --- END FRAME FILTERING LOGIC ---

  const allFrameFiles = (await fs.promises.readdir(baseTempDir)).filter(f => f.endsWith('.png')).sort();
  const imageParts = [];
  const finalTimestampsSet = new Set(finalTimestamps);

  for (let i = 0; i < allTimestamps.length; i++) {
      const timestamp = allTimestamps[i];
      if (finalTimestampsSet.has(timestamp)) {
          const frameFile = allFrameFiles[i];
          if (frameFile) {
              const framePath = path.join(baseTempDir, frameFile);
              if (fs.existsSync(framePath)) {
                  imageParts.push({ inlineData: { data: Buffer.from(await fs.promises.readFile(framePath)).toString("base64"), mimeType: 'image/png' } });
                  imageParts.push({ text: `Timestamp: [${Math.round(timestamp)}]` });
              }
          }
      }
  }
  ```

### 프롬프트 개선 방향 (Prompt Improvement Directions)

#### 1. 콘텐츠 유형에 따른 '전문성' 부여
- **방향:** 영상 종류(요리, 게임, 학습 등)를 추측하여, 그에 맞는 **'맞춤형 역할'**을 프롬프트에 동적으로 추가합니다.
- **효과:** 각 분야에 특화된 전문적이고 실감 나는 묘사가 가능해집니다.

#### 2. '분위기'와 '감정'을 담아내기
- **방향:** '객관성 유지' 규칙을 완화하여, 장면의 전반적인 분위기나 인물의 핵심적인 감정 표현을 묘사하도록 허용합니다.
- **효과:** 영상이 전달하고자 하는 감성까지 사용자에게 전달하여 훨씬 더 풍부한 감상 경험을 제공합니다.

#### 3. 등장인물/사물에 '일관된 이름' 붙여주기
- **방향:** 주요 등장인물이나 반복해서 나오는 사물에 일관된 명칭을 사용하도록 명확하게 지시합니다.
- **효과:** 여러 인물이 등장하는 복잡한 장면도 사용자가 헷갈리지 않고 쉽게 따라갈 수 있습니다.

#### 4. '핵심 장면 요약' 기능 추가
- **방향:** 모든 해설이 끝난 후, 영상의 핵심적인 시각적 사건들을 3~5가지로 요약해서 별도로 정리해달라고 요청합니다.
- **효과:** 사용자가 영상의 전체적인 시각적 흐름을 빠르게 파악하고 원하는 부분만 선택해서 볼 수 있도록 돕습니다.

---

## 비용 분석 (2025-11-13 기준)

영상 1개를 처리하는 데 소요되는 API 비용은 사용되는 토큰의 종류(입력/출력)와 총량에 따라 결정됩니다. `videoProcessor.js`에 구현된 비용 계산 로직과 공식 가격 정책에 따르면, Gemini 2.5 Pro 모델의 비용은 다음과 같은 계층적 구조를 따릅니다.

### Gemini 2.5 Pro 공식 가격 정책 (100만 토큰당)

| 총 토큰 수 | 입력 (Input) 비용 | 출력 (Output) 비용 |
| :--- | :--- | :--- |
| 200,000개 이하 | $1.25 | $10.00 |
| 200,000개 초과 | $2.50 | $15.00 |

- **입력 토큰:** AI에 전송되는 모든 데이터 (이미지 프레임, 프롬프트 텍스트, 자막 등)
- **출력 토큰:** AI가 생성하는 화면 해설 스크립트 텍스트

### 영상 1개당 예상 비용 분석

과거 로그 분석에 따르면, 영상 1개를 처리할 때 **평균적으로 약 122,200개의 입력 토큰**이 사용됩니다. 이는 대부분 이미지 프레임에서 발생합니다.

이 평균값을 기준으로 예상 비용을 계산하면 다음과 같습니다.

- **입력 비용:** (122,200 / 1,000,000) * $1.25 = **약 $0.153**
- **출력 비용:** 출력 토큰의 양은 영상의 내용과 길이에 따라 크게 달라지지만, 일반적으로 입력 토큰보다 훨씬 적습니다. 예를 들어, 2,000개의 출력 토큰이 생성되었다고 가정하면 (2,000 / 1,000,000) * $10.00 = **$0.02** 입니다.

따라서 영상 1개당 총 처리 비용은 **입력 비용이 대부분을 차지하며, 평균적으로 약 $0.17 ~ $0.20 (약 230원 ~ 270원)** 범위가 될 것으로 추정됩니다. 이는 기존의 단일 요금제 기반 분석보다 훨씬 정확하고 저렴한 추정치입니다.

*환율은 1달러 = 1,350원 기준으로 계산되었습니다.*

---

## 관리자 페이지 기능 제안 (Admin Page Feature Proposal)

서비스의 안정적인 운영, 비용 관리, 사용자 지원을 위해 관리자 페이지는 다음과 같은 기능들을 포함하는 것이 좋습니다. 핵심 목표는 **1) 시스템 상태 모니터링, 2) 생성된 콘텐츠 관리, 3) 비용 최적화, 4) 문제 해결**입니다.

### 1. 대시보드 (종합 현황)
로그인 시 가장 먼저 보게 될 화면으로, 서비스의 핵심 지표들을 한눈에 파악할 수 있어야 합니다.

*   **핵심 통계:**
    *   오늘/이번 주/이번 달 처리된 총 영상 수
    *   생성된 총 해설 스크립트 수
    *   등록된 총 댓글 수
    *   **API 예상 비용:** 이번 달 누적된 Gemini 및 TTS API 사용량을 기반으로 한 예상 비용
*   **시스템 상태:**
    *   현재 처리 중인 영상(`processing` 상태) 목록
    *   최근 24시간 내 발생한 오류(`failed` 상태) 목록
    *   **TTS 오디오 캐시 사용량:** 현재 저장된 오디오 캐시 파일의 총 용량 및 개수
*   **최신 활동:**
    *   최근에 성공적으로 처리된 영상 목록
    *   최근에 등록된 댓글 목록

### 2. 콘텐츠 관리
서비스의 핵심 데이터인 영상과 댓글을 관리하는 기능입니다.

*   **영상 관리:**
    *   **목록:** 데이터베이스에 저장된 모든 영상을 목록 형태로 제공 (검색 및 필터링 기능 포함)
        *   **필터:** 영상 제목, 유튜브 ID, 처리 상태(`completed`, `failed`, `processing`)
    *   **상세 정보:** 특정 영상을 클릭하면 저장된 스크립트(v1, v2, v3 모두), 생성 시각, 처리 소요 시간 등의 상세 정보 확인
    *   **주요 기능:**
        *   **재처리:** `failed` 상태의 영상에 대해 다시 처리를 시도하는 기능
        *   **삭제:** 특정 영상을 DB에서 삭제 (관련 스크립트, 댓글, 오디오 캐시 파일도 함께 삭제하는 옵션 제공)

*   **댓글 관리:**
    *   **목록:** 모든 댓글을 최신순으로 보여주며, 어떤 영상에 달린 댓글인지 표시
    *   **검색 및 필터링:** 영상 제목, 닉네임, 댓글 내용으로 검색
    *   **주요 기능:**
        *   **강제 삭제:** 관리자 권한으로 부적절하거나 스팸성 댓글을 비밀번호 없이 즉시 삭제

### 3. 시스템 모니터링 및 로그
서버의 상태를 실시간으로 확인하고 문제가 발생했을 때 원인을 빠르게 파악하는 기능입니다.

*   **오류 로그 뷰어:**
    *   `backend/logs/` 디렉터리의 로그 파일을 웹 인터페이스에서 직접 볼 수 있는 기능
    *   `[ERROR]` 레벨의 로그만 필터링해서 볼 수 있는 옵션 제공
*   **TTS 캐시 관리:**
    *   `clear-cache.js` 스크립트를 실행하는 버튼 (예: "30일 이상된 캐시 파일 삭제")
    *   전체 오디오 캐시를 비우는 기능 (주의 필요)

### 4. 비용 및 사용량 분석
API 비용을 체계적으로 추적하고 분석하여 비용을 최적화하기 위한 기능입니다.

*   **API 호출 기록:**
    *   영상 1개를 처리할 때마다 발생한 Gemini 토큰 사용량(이미지+텍스트)과 TTS API 호출 글자 수를 DB에 기록
    *   이 기록을 바탕으로 영상별 처리 비용을 계산하여 목록으로 표시
*   **분석 대시보드:**
    *   일별/주별/월별 API 비용 추이 그래프
    *   가장 비용이 많이 발생한 영상 Top 10 목록 (프롬프트 튜닝이나 정책 수립에 활용)

### 5. 환경설정
코드 배포 없이 간단한 설정을 변경할 수 있는 기능입니다.

*   **프롬프트 관리:**
    *   `prompt_template.txt` 파일의 내용을 관리자 페이지에서 직접 수정하고 저장할 수 있는 기능. (A/B 테스트나 프롬프트 개선 시 매우 유용)
*   **설정 값 변경:**
    *   TTS 캐시 보관 기간(현재 30일) 등 주요 설정 값을 변경할 수 있는 인터페이스

### 구현 우선순위 제안
1.  **1단계 (필수):** 영상 관리(목록, 재처리, 삭제), 댓글 관리(삭제), 오류 로그 뷰어
2.  **2단계 (운영 고도화):** 대시보드, TTS 캐시 관리
3.  **3단계 (비용 최적화):** 비용 및 사용량 분석, 프롬프트 관리

---

## 뷰레이터 서비스 2.0 계획: 개인 영상 업로드 및 해설 (ViewRator 2.0 Plan)

시각장애인 사용자가 자신의 휴대폰으로 촬영한 영상이나 소장 중인 영상을 업로드하여, 나만의 추억을 소리로 '볼' 수 있게 하는 핵심 기능 확장 계획입니다.

### 1. 핵심 아키텍처 및 철학
*   **프라이버시 최우선:** 업로드된 원본 영상은 해설 생성 즉시 **영구 삭제**합니다.
*   **스토리지/비용 효율화:** 영상 스트리밍 대신 **"오디오 + 키프레임 슬라이드 쇼"** 방식을 채택합니다.
    *   서버에는 `추출된 오디오(.mp3)`와 `주요 장면 이미지(.jpg)`만 저장합니다.
    *   영상 트랙을 제거하여 스토리지 용량을 90% 이상 절약합니다.
*   **안전한 콘텐츠 (Safe AI):** 성인물 등 유해 콘텐츠가 Gemini API로 전송되는 것을 원천 차단하기 위해 **3중 방어막**을 구축합니다.

### 2. 기술적 구현 상세
*   **인증 (Authentication):**
    *   **Google OAuth 2.0** 도입 필수 (익명 업로드 불가, 블랙리스트 관리를 위한 실명 기반 인증).
*   **업로드 파이프라인:**
    1.  사용자 파일 업로드 (Multer).
    2.  `ffmpeg`으로 오디오 및 키프레임 추출.
    3.  **Local AI 보안 검사 (nsfwjs):** 추출된 키프레임 중 3~5장을 무작위 샘플링하여 로컬에서 성인물 여부 판독 (vCPU 2 Core 서버 부하 최소화).
    4.  통과 시 Gemini에 전송하여 해설 생성, 실패 시 즉시 삭제 및 계정 경고.
    5.  **원본 영상 삭제.**
*   **재생 경험:**
    *   자체 개발한 **'슬라이드 쇼 플레이어'**를 통해 오디오에 맞춰 관련 키프레임이 전환되는 경험 제공.

### 3. 개발 로드맵
1.  **Phase 1 (인증):** Google OAuth 2.0 연동 및 사용자 DB 구축.
2.  **Phase 2 (파이프라인):** 파일 업로드, 오디오/이미지 추출, 원본 삭제 로직 구현.
3.  **Phase 3 (보안):** `nsfwjs` (MobileNet) 도입 및 샘플링 검사 로직 구현.
4.  **Phase 4 (UI/UX):** 업로드 UI 및 슬라이드 쇼 플레이어 개발.

## 운영 비용 (Operating Expenses)

**기간: 2026년 2월 3일 ~ 2026년 3월 2일**

- 2026-03-02: 구글클라우드 출금 -306,233원
- 2026-02-04: 스마트프록시 출금 -96,098원

**합계: -402,331원**

**기간: 2026년 1월 1일 ~ 2026년 2월 2일**

- 2026-02-02: 구글클라우드 출금 -160,995원
- 2026-01-16: 프록시 출금 -14,423원
- 2026-01-15: 구글클라우드 출금 -200,000원
- 2026-01-04: 프록시 출금 -14,189원

**합계: -389,607원**

**기간: 2025년 11월 14일 ~ 2025년 12월 31일**

- 2026-01-02: 구글클라우드 출금 -110,974원
- 2025-12-04: 프록시 10GB 출금 -14,414원
- 2025-11-24: 프록시 10GB 출금 -14,453원
- 2025-11-17: 프록시 10GB 출금 -14,241원

**합계: -154,082원**
## Future Architecture: Prompt Chaining Refactoring Plan (Process Video CLI)

### 개요 (Overview)
현재 `process_video_cli.js`는 단일 프롬프트에 모든 지시사항을 몰아넣어 처리하고 있어, 복잡한 영상에서 품질 저하가 발생할 수 있습니다. 이를 해결하기 위해 작업을 **3단계의 전문화된 체인(Chain)**으로 분리하는 리팩토링을 제안합니다.

### 목표 (Goals)
1. **장르 적응성:** 영화, 다큐, 예능 등 장르에 따라 톤앤매너를 자동으로 최적화.
2. **일관성 유지:** 영상 초반에 등장인물과 용어를 정의하고 끝까지 유지.
3. **싱크 정확도:** 번역/묘사 단계와 타임스탬프 동기화 단계를 분리하여 오류 최소화.

### 상세 아키텍처 (3-Stage Pipeline)

#### Stage 1: The Analyzer (분석가)
* **입력:** 영상 메타데이터, 대표 프레임(10~20장), 초반 자막.
* **역할:** 영상의 '설계도'를 그리는 단계.
* **출력 (JSON):** 장르, 주요 등장인물 특징, 해설 전략.

#### Stage 2: The Describer (묘사가)
* **입력:** Stage 1 리포트, 해당 파트 자막 및 모든 프레임.
* **역할:** 풍부한 재료를 쏟아내는 단계. 시간 제약 없이 자유롭게 묘사하고 번역.
* **출력:** Raw Script (Draft).

#### Stage 3: The Synchronizer (편집자)
* **입력:** Stage 2 Raw Script, 원본 자막 파일.
* **역할:** 정해진 규격에 맞춰 조립하고 다듬는 단계. (이미지 불필요 -> 비용 절감)
* **프롬프트 핵심:** 정확한 타임스탬프 배치, 빈 시간(Gap) 채우기, Smart Editing(대사 삭제).
* **출력:** Final Script.

### 구현 로드맵 (Roadmap)
1. **모듈 분리:** process_video_cli.js를 메인으로 두고, analyzer.js, describer.js, synchronizer.js 모듈 작성.
2. **State 관리:** 파이프라인 데이터 흐름 구축.
3. **Analyzer/Synchronizer:** 효율적인 프롬프트 엔지니어링.

### 비용 효율화 전략
* **Stage 1:** 이미지 소량 사용 (Low Cost).
* **Stage 2:** 이미지 대량 사용 (High Cost).
* **Stage 3:** 텍스트 전용 (Very Low Cost) -> 저렴한 모델(Gemini Flash 등) 사용 가능.
* **결론:** 비용 상승 억제, 품질 비약적 향상.

### 운영 서버 관리 (Operation Server Management)
- **접속 방법:** `ssh chacha@mom `
  - *주의: DB 위치는 `/app/youtube-describer/backend/db` 입니다.*
- **배포 순서:**
  1. 로컬 코드 수정 및 테스트
  2. `./deploy-prod.sh "커밋 메세지"` 실행 (GitHub 푸시)
  3. 운영 서버 접속 후 `~/deploy-app.sh` 실행 (최종 반영 및 서버 재시작)

### 유튜브 쿠키 자동 갱신 시스템 (Headless Playwright)
서버 단독으로 유튜브 쿠키 세션을 유효하게 유지하고, 검증 통과한 쿠키를 서비스 디렉토리들에 전파하는 시스템입니다.

- **스크립트 경로**: [server-refresh-cookies.py](file:///Users/chacha/src/youtube-describer/backend/bin/server-refresh-cookies.py)
  - *운영서버 배치 경로: `/home/chacha/bin/server-refresh-cookies.py`*
- **가상환경 경로**: `/home/chacha/bin/venv` (Playwright & Chromium 구동용)
- **쿠키 저장소**:
  - 임시/검증용: `/home/chacha/bin/cookies/`
  - 실서비스 전파처: `/app/youtube-describer/backend/cookies/`, `/app/test-youtube-describer/backend/cookies/`, `/app/qa-youtube-describer/backend/cookies/`
- **Systemd 자동화 설정**:
  - **서비스 유닛**: `/etc/systemd/system/youtube-cookie-refresh.service`
    ```ini
    [Unit]
    Description=YouTube Cookie Auto Refresh Service
    After=network.target

    [Service]
    Type=oneshot
    User=chacha
    ExecStart=/home/chacha/bin/server-refresh-cookies.py
    StandardOutput=append:/home/chacha/bin/cookies/refresh.log
    StandardError=append:/home/chacha/bin/cookies/refresh.log

    [Install]
    WantedBy=multi-user.target
    ```
  - **타이머 유닛** (4시간 간격 실행): `/etc/systemd/system/youtube-cookie-refresh.timer`
    ```ini
    [Unit]
    Description=Run YouTube Cookie Auto Refresh Service every 4 hours

    [Timer]
    OnCalendar=0/4:00:00
    Persistent=true
    Unit=youtube-cookie-refresh.service

    [Install]
    WantedBy=timers.target
    ```
  - **상태 제어**:
    ```bash
    sudo systemctl daemon-reload
    sudo systemctl enable --now youtube-cookie-refresh.timer
    sudo systemctl start youtube-cookie-refresh.service  # 수동 즉시 실행
    ```
  - **로그 모니터링**:
    ```bash
    tail -f /home/chacha/bin/cookies/refresh.log
    journalctl -u youtube-cookie-refresh.service -f
    ```

