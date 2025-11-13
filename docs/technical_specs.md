# 뷰레이터(Vureater) 기술 명세서

이 문서는 뷰레이터 서비스의 전체 아키텍처, 핵심 기술, 데이터 흐름 및 배포 환경에 대한 상세한 기술 정보를 제공합니다.

## 1. 시스템 아키텍처

본 서비스는 사용자의 초기 응답 속도를 최적화하고 운영 비용을 최소화하기 위해 **점진적 데이터 처리(Progressive Data Processing)**와 **주문형 리소스 생성(On-Demand Resource Generation)** 모델을 채택하고 있습니다. 아키텍처는 크게 프론트엔드와 백엔드로 분리됩니다.

-   **프론트엔드 (React)**: 사용자 인터페이스와 상호작용을 담당하며, 백엔드로부터 실시간(SSE)으로 대본을 수신하여 즉시 사용자에게 제공합니다.
-   **백엔드 (Node.js)**: 영상 처리, AI 연동, 데이터베이스 관리, API 제공 등 모든 핵심 로직을 수행합니다.

![System Architecture Diagram](https://i.imgur.com/example.png) (향후 다이어그램 추가)

---

## 2. 백엔드 아키텍처 (`/backend`)

### 2.1. 핵심 기술 스택

-   **런타임 / 프레임워크**: Node.js, Express.js
-   **데이터베이스**: SQLite (라이브러리: `better-sqlite3`)
-   **AI 모델**:
    -   **화면 해설**: Google Gemini 2.5 Pro (`@google/generative-ai`)
    -   **음성 합성**: Google Cloud Text-to-Speech (`@google-cloud/text-to-speech`)
-   **영상/오디오 처리**:
    -   `yt-dlp`: 유튜브 영상 메타데이터, 자막, 오디오 소스 다운로드
    -   `fluent-ffmpeg`: 키프레임 추출 및 오디오 처리
-   **실시간 통신**: Server-Sent Events (SSE)
-   **프로세스 관리**: PM2
-   **기타**: `cors`, `dotenv`, `crypto` (해시 생성)

### 2.2. 핵심 프로세스 상세

#### A. 점진적 대본 생성 (Progressive Script Generation)

사용자의 대기 시간을 최소화하기 위한 핵심 프로세스입니다.

1.  **요청 수신**: 프론트엔드에서 `GET /api/process`로 영상 ID와 함께 요청을 보냅니다.
2.  **사전 데이터 수집**:
    -   `yt-dlp`를 사용하여 영상의 기본 정보(제목, 길이)와 한국어 자동 생성 자막 전체를 다운로드합니다.
    -   `ffmpeg`을 사용하여 영상 전체를 스캔하고, 장면 전환(Scene Change)을 기준으로 모든 키프레임을 이미지 파일(.png)로 추출합니다.
3.  **AI 컨텍스트 구성 및 스트리밍 요청**:
    -   영상 제목, 전체 자막, 추출된 모든 키프레임 이미지를 하나의 컨텍스트로 묶습니다.
    -   이 컨텍스트를 **Google Gemini 2.5 Pro** 모델에 **단일 스트리밍 요청**으로 전송합니다. 이를 통해 AI는 영상의 전체 서사를 이해한 상태에서 해설을 생성합니다.
4.  **실시간 스트리밍 응답 (SSE)**:
    -   AI 모델이 해설 스크립트를 스트림 형태로 생성하면, 백엔드는 이를 즉시 파싱하여 `script_chunk` 이벤트를 통해 프론트엔드로 실시간 전송합니다.
    -   처리 단계별 진행 상황(예: "키프레임 추출 중...")은 `status_update` 이벤트를 통해 전송됩니다.
5.  **데이터베이스 저장 및 완료**:
    -   스트리밍이 진행되는 동안, 생성된 스크립트는 실시간으로 DB의 `scripts` 테이블에 저장됩니다.
    -   모든 프로세스가 완료되면 영상의 상태를 `videos.status` = `completed`로 업데이트하고 `end` 이벤트를 전송합니다.

#### B. 하이브리드 TTS 캐싱 (Hybrid TTS Caching)

API 비용을 획기적으로 절감하고 응답 속도를 극대화하는 주문형 음성 생성 및 캐싱 시스템입니다.

1.  **요청 수신**: 프론트엔드에서 `POST /api/tts`로 해설 텍스트 한 줄을 담아 요청합니다.
2.  **캐시 키 생성**:
    -   수신된 텍스트를 SHA256 알고리즘으로 해시하여 고유한 파일명을 생성합니다.
    -   파일 시스템의 단일 디렉터리 부하를 줄이기 위해, 해시값의 앞 4자리를 사용하여 2단계의 하위 디렉터리를 생성합니다. (예: `tts_cache/{char1}{char2}/{char3}{char4}/{hash}.mp3`)
3.  **캐시 확인 (Cache Check)**: 생성된 경로에 해당 오디오 파일이 이미 존재하는지 확인합니다.
4.  **캐시 히트 (Cache Hit)**: 파일이 존재하면, TTS API를 호출하지 않고 즉시 해당 파일을 프론트엔드로 전송합니다. (응답 시간: ~10-50ms)
5.  **캐시 미스 (Cache Miss)**: 파일이 없으면,
    -   Google Cloud TTS API를 호출하여 텍스트를 음성(MP3)으로 변환합니다.
    -   생성된 오디오 파일을 위에서 계산된 캐시 경로에 저장합니다.
    -   저장된 파일을 프론트엔드로 전송합니다.

### 2.3. API 엔드포인트 명세

| 메서드 | 경로 | 설명 | 주요 기능 |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/process` | **(SSE)** 영상 해설을 실시간으로 생성하고 스트리밍합니다. | `yt-dlp`, `ffmpeg`, Gemini AI 연동, SSE 이벤트 전송 |
| `POST` | `/api/tts` | 텍스트를 음성으로 변환하고 캐싱합니다. | Google TTS, 하이브리드 캐싱 로직 |
| `GET` | `/api/cached-videos` | DB에 저장된 모든 영상 목록을 반환합니다. | `videos` 테이블 조회 |
| `GET` | `/api/search` | 키워드로 로컬 DB와 유튜브를 동시에 검색합니다. | DB 검색, `googleapis` 연동 |
| `GET` | `/api/script/:videoId` | 특정 영상의 전체 텍스트 스크립트를 반환합니다. | `scripts` 테이블 조회 |
| `GET` | `/api/comments/:videoId` | 특정 영상의 모든 댓글을 조회합니다. | `comments` 테이블 조회 |
| `POST` | `/api/comments` | 새 댓글을 추가합니다. (비밀번호는 해시하여 저장) | `comments` 테이블 삽입 |
| `PUT` | `/api/comments/:commentId` | 기존 댓글을 수정합니다. (비밀번호 검증) | `comments` 테이블 업데이트 |
| `DELETE`| `/api/comments/:commentId` | 댓글을 삭제합니다. (비밀번호 검증) | `comments` 테이블 삭제 |
| `GET` | `/api/admin/*` | 관리자 페이지용 데이터(통계, 설정 등)를 제공합니다. | 인증 미들웨어, 각 테이블 조회 |
| `PUT` | `/api/admin/*` | 관리자 페이지에서 수정한 내용을 저장합니다. | 인증 미들웨어, 각 테이블 업데이트 |

### 2.4. 데이터베이스 스키마 (SQLite)

-   **`videos`**: 영상의 메타데이터 관리
    -   `id`, `youtubeId`, `title`, `duration` (영상 길이), `status` ('processing', 'completed', 'failed'), `createdAt`
-   **`scripts`**: 생성된 화면 해설 대본
    -   `id`, `videoId` (FK), `timestamp`, `text`, `verbosity` ('v1', 'v2', 'v3')
-   **`comments`**: 사용자 댓글
    -   `id`, `videoId` (FK), `nickname`, `password` (hashed), `content`, `createdAt`
-   **`donations`**: 후원 내역
    -   `id`, `donor`, `amount`, `message`, `donatedAt`
-   **`api_costs`**: API 사용 비용 기록
    -   `id`, `videoId` (FK), `model`, `input_tokens`, `output_tokens`, `cost_usd`, `createdAt`
-   **`settings`**: 서비스 전체 설정
    -   `key` (e.g., 'maxDuration', 'processingPaused'), `value`

---

## 3. 프론트엔드 아키텍처 (`/frontend`)

### 3.1. 핵심 기술 스택

-   **UI 라이브러리**: React (CRA 기반)
-   **라우팅**: `react-router-dom`
-   **HTTP 클라이언트**: `axios` (일반 API), `EventSource` (SSE)
-   **유튜브 플레이어**: `react-youtube`
-   **상태 관리**: React Hooks (`useState`, `useEffect`, `useContext`, `useRef`)

### 3.2. 주요 기능 및 구현 방식

-   **통합 검색 (`HomeScreen.js`)**:
    -   단일 입력 필드에서 사용자의 입력이 URL 형식인지, 일반 텍스트인지 감지합니다.
    -   텍스트 입력 시, `axios`를 통해 `/api/search`를 호출하여 로컬 DB와 유튜브 검색 결과를 동시에 받아와 렌더링합니다.
-   **커스텀 플레이어 (`PlayerScreen.js`)**:
    -   `react-youtube`를 사용하되, `controls: 0` 옵션으로 기본 UI를 숨깁니다.
    -   영상 위에 자체 제작한 재생/일시정지 버튼 오버레이를 띄워 사용자 상호작용을 단순화합니다.
    -   **단일 오디오 객체 재사용**: 모바일 브라우저의 자동 재생 정책 문제를 해결하기 위해, 앱 로드 시 단 하나의 `<audio>` 엘리먼트만 생성하여 `useRef`로 관리합니다. TTS 재생 시에는 이 객체의 `src`만 교체하여 안정적인 재생을 보장합니다.
-   **실시간 데이터 수신 및 처리**:
    -   `EventSource` API를 사용하여 `/api/process` 엔드포인트에 연결합니다.
    -   `onmessage` 핸들러에서 `event.type`에 따라 (`status_update`, `script_chunk` 등) 상태를 업데이트하고 화면을 다시 렌더링합니다.
    -   수신된 `script_chunk`는 중복을 제거한 후 기존 대본 배열에 추가됩니다.
-   **접근성 (Accessibility)**:
    -   `aria-live` 영역을 두어 "검색 중...", "오류 발생" 등 주요 상태 변화를 스크린리더 사용자에게 음성으로 즉시 알립니다.
    -   페이지 전환 시 `useRef`와 `useEffect`를 활용하여 각 페이지의 주 제목(`h1`)으로 포커스를 자동으로 이동시켜 컨텍스트를 명확히 전달합니다.
    -   모든 인터랙티브 요소에 `aria-label`, `role` 등 적절한 ARIA 속성을 부여합니다.

---

## 4. 배포 및 인프라

-   **클라우드 제공자**: Google Cloud Platform (GCP)
-   **서버**: Ubuntu (ARM 아키텍처)
-   **웹 서버**: Nginx
    -   프론트엔드 `build` 디렉터리의 정적 파일을 직접 서빙합니다.
    -   `/api` 경로로 들어오는 모든 요청을 백엔드 Node.js 애플리케이션(localhost:8080)으로 전달하는 **리버스 프록시** 역할을 수행합니다.
    -   SSE 통신을 위해 `proxy_buffering off;` 등의 설정을 포함합니다.
-   **프로세스 관리**: PM2
    -   Node.js 백엔드 서버를 데몬으로 실행하고, 오류 발생 시 자동으로 재시작합니다.
    -   `pm2 startup` 및 `pm2 save`를 통해 서버 재부팅 시에도 서비스가 자동으로 실행되도록 설정합니다.
-   **HTTPS**: Certbot을 사용하여 Let's Encrypt로부터 무료 SSL 인증서를 발급받고, Nginx에 자동으로 설정 및 갱신합니다.

## 5. 시스템 필수 요구사항

서비스를 정상적으로 구동하기 위해 서버에는 다음 명령줄 도구들이 반드시 설치되어 있고, 시스템 `PATH`에 등록되어 있어야 합니다.

-   **Node.js** (LTS 버전)
-   **`yt-dlp`**
-   **`ffmpeg`**
