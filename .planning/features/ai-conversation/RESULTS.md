# AI와 대화하기 — 01 기준 측정·기능 검증 결과

최종 갱신: 2026-09-14. **01은 실기 검증이 남아 있으며, 02 캐시·자원 기반을 구현했다.** 이 문서의 2026-09-13 실험 기록과 아래 추가 다운로드 실험을 구분한다. [02 구현 범위](02-IMPLEMENTATION.md)를 참고한다. 제품 첫 음성 개선 전체 완료를 의미하지 않는다.

## 구현

- `test_scripts/qa_latency_benchmark.js`: 실행 환경, 합성 미디어 PTS/coverage 비교, 시험 조건표, 브라우저 표본의 층별 P50/P95 집계.
- `test_scripts/qa_provider_probe.js`: 호출 예산이 있는 JSONL·검색 설정+schema·문장 MP3·지연 입력 OGG 실험. 애플리케이션 DB를 사용하지 않는다.
- `frontend/src/services/qaLatencyTrace.js`와 플레이어 연결: 탭별 opt-in, 실제 첫 `playing`, 실패·timeout 보존, 원문/티켓 미수집. 사용자 인터페이스와 기존 답변/TTS 순서는 유지한다.
- `test_scripts/qa_browser_audio_probe.js`: 저장된 실제 provider 오디오와 Chromium으로 키보드 활성화 및 계측 연결 확인.
- 실행 방법: [QA_BENCHMARK.md](../../../../test_scripts/QA_BENCHMARK.md).

## 실행 환경과 표본

Node v24.7.0, macOS arm64, FFmpeg/ffprobe 8.0, `@google/generative-ai` 0.24.1, `@google-cloud/text-to-speech` 6.3.0, QA 모델 `gemini-3.5-flash-lite`, Chrome 141.0.7390.122(headless). 실험별 1회 실행이며 통계적 성능 보장은 아니다.

기본 PATH의 yt-dlp는 `/usr/bin/python3`가 오래되어 실행 실패했다. 전역 설정을 변경하지 않고 `/opt/homebrew/bin/python3 /Users/chacha/src/yt-dlp/yt_dlp/__main__.py --version`으로 2026.09.01.1 실행을 확인했다. 실제 다운로드 비교는 수행하지 않았다.

## 관찰 결과

| 시험 | 관찰 | 해석 |
|---|---|---|
| 조밀 CFR | 원본 키프레임 12개, 기존 fps 출력 11개 | 마지막 프레임 시각 손실 재현 |
| 성긴 CFR | 원본 0/8/16초, fps 출력에 2/4/6/10/12/14초 추가 | 재표본화 시각을 원본 PTS로 사용할 수 없음 |
| VFR+7초 offset | 원본 7/15초, fps 출력 8/10/12/14초 | 격자 변환 후 시간은 원본 근거가 아님 |
| 원본 PTS 유지 | 3종 모두 ffprobe와 정확 일치 | 공통 추출기는 원본 PTS를 유지하고 실제 hole을 백필해야 함 |
| 모델 JSONL | 첫 완결 레코드 약 1,009ms, 전체 약 1,129ms | 설치 SDK/모델에서 완결 문장 후보 선행 파싱 가능 |
| JSON schema+검색 설정 | 약 1,014ms, 요청·형식 성공, 실제 검색 0회 | 옵션 조합은 수락됨. 검색 결과가 있는 경우는 미검증 |
| 문장 MP3 2회 | 약 918ms / 609ms | 개별 합성 API 성공; 휴대폰 첫 청취 시간은 아님 |
| 연속 OGG | 첫 byte 약 208ms, 두 번째 입력 약 3,004ms | 두 번째 입력 이전 오디오 수신 확인 |
| Chromium 저장 오디오 | MP3/OGG 모두 키보드 Enter 후 실제 playing 기록 | 계측 연결 성공. live stream/mobile/실제 소리는 미검증 |

Provider 시험은 모델 2회(실제 총 입력 133토큰, 출력 129토큰), TTS 3회(고정 문장 총 52자), 자동 재시도 0회다. usage 원본을 결과 JSON에 남겼으며 달러 비용을 추정하거나 운영 QA 장부에 기록하지 않았다.

원본 결과: [media](results/media-20260913.json), [provider](results/provider-20260913.json), [browser](results/browser-20260913.json). 브라우저 저장 파일 재생 수치는 제품 warm/cold 지연 표본과 합치지 않는다.

## 테스트

- 새 backend 측정/파서 테스트 6개와 기존 Q&A streaming/TTS 테스트 8개: 14/14 통과. 임시 SQLite, `--test-concurrency=1` 사용.
- 첫 회귀 실행은 같은 임시 DB에 두 테스트 파일이 동시에 접근하여 SQLITE_BUSY 1건 발생했다. 결과를 숨기지 않고 직렬 실행으로 재검증했다. 제품 DB 변경은 없다.
- frontend 계측 테스트: 5/5 통과. `play`와 `playing` 구분, opt-in 비활성, autoplay 실패 후 늦은 이벤트, 오디오 교체, timeout/첫 시각 고정을 검증했다.
- frontend production build 성공. 기존 Browserslist 데이터 갱신 및 Node deprecation 안내가 있었다.
- Chromium 저장 오디오 시험: 두 형식 모두 통과. 실제 VoiceOver/TalkBack/NVDA 검증은 수행하지 않았다.

## 다음 완료 조건

1. 격리된 시험 서버와 실제 5/15/30분 대표 영상에서 cold/warming/warm 및 1/10/50턴 기준 데이터를 수집한다. 현재 저장된 browser JSON은 계측 동작 시험일 뿐이다.
2. yt-dlp 구간/전체 다운로드의 시간, 실제 전송 바이트, 중복량, seek 정확도를 쿠키/프록시/프로토콜 조건별로 측정한다. 로컬 실행에 사용할 Python 경로도 명시한다.
3. 실제 검색 결과가 존재하는 구조화 응답과 문장별 근거·언어·중복 validator의 조합을 검증한다. 형식 시험용 parser를 제품 validator로 사용하지 않는다.
4. iPhone Safari/VoiceOver와 Android Chrome/TalkBack, 데스크톱 NVDA에서 첫 문장 청취, autoplay, 문장 사이 공백, 속도, 취소·오류 행동을 확인한다.
5. 이후 단계의 모델→정책 검증→TTS 통합 구현으로 두 번째 문장 지연 및 전체 워밍 지연 중 첫 재생을 확인한다.

아직 warm P50 3초/P95 6초, cold P95 30% 단축을 달성했다고 판정하지 않는다. 기존 DESIGN/PLAN/ROADMAP의 사용자 변경이나 마일스톤 완료 상태는 변경하지 않았다.

## 외부 계약 참고

- [Google 구조화 출력](https://ai.google.dev/gemini-api/docs/structured-output): 문서상 구조화 출력과 도구 병용 지원을 확인하되, 위 설치 SDK의 실제 요청 결과를 별도로 남겼다.
- [Chirp 3 HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd): 스트리밍 OGG와 일괄 MP3 경로 구분. 실험도 MP3를 문장별 일괄 호출로 사용했다.


## 2026-09-14 추가 결과: 다운로드와 공통 캐시 기반

기존 시험 문서의 `OT0wMk7yIEo`(1,040초)에서 120초 시점의 구간 `[116,122]`를 전체 영상과 비교했다. 쿠키 없이 동일 format 397/HTTPS, video-only 최대 480p, 로컬 계측 proxy를 사용해 각 1회 실행했다.

| 경로 | 경과 시간 | 파일 크기 | 실제 미디어 수신 TLS 바이트 |
|---|---:|---:|---:|
| 전체 | 9.364초 | 34,660,766 | 34,737,046 |
| 구간 | 9.200초 | 330,333 | 485,909 |

구간 프레임 180개는 모두 원본의 한 PTS에 대응했다. 첫 구간 프레임의 실제 원본 시각은 약 116.0159초다. 구간 파일 0초를 정확한 원본 116초로 가정해서는 안 된다. 비교 스크립트의 초기 `-copyts`/종료 시각 혼용은 빈 원본 비교를 만들었고, 같은 파일에 올바른 종료 시각을 적용해 재검증했다. 원본 다운로드를 재실행하지 않았다.

구간 전송량은 줄었으나 1회 표본에서 시간 차이는 약 0.16초에 그쳤다. 구간 방식의 속도 우위를 일반화하지 않으며, 실패하거나 느린 프로토콜은 같은 전체 다운로드를 재사용하는 fallback을 유지한다. 측정량에는 TLS/HTTP 오버헤드가 포함되고, 정확한 원본 payload 중복 바이트는 측정하지 않았다. [다운로드 결과](results/download-20260913.json)

동일 영상에서 새 공통 추출기는 약 13.76초에 프레임 524개를 생성했고 2초 격자 coverage hole이 없었다. 이 시간은 로컬 영상의 프레임 추출 시간이며 질문→첫 음성과 다르다. [추출 결과](results/extraction-20260913.json)

02는 SQLite lease/fencing/자산 등록/재시작 대조, legacy 자산 분리, 공통 원본 PTS 추출, 기존 생성 경로 연결, 다운로드·FFmpeg·Whisper 실행 한도 및 디스크 예약을 구현했다. 전체 캐시 worker·현재 구간 우선 실행·신규 Q&A API 연결은 03 이후의 작업이다. 실제 모바일 청취와 대표 5/15/30분 영상의 전후 지연 비교는 미완료다.

최종 통합 회귀: backend 78/78 통과. 임시 SQLite와 파일별 직렬 실행을 사용했다. 이번 단계에서 실제 frontend 사용자 흐름은 바꾸지 않았다.

## 2026-09-14 production speech-module integration probe

Controlled closed model records with the second record delayed three seconds, production request/policy/generation/speech modules, real Google TTS, zero model/download calls. Raw report: `results/incremental-speech-20260914.json`.

| Mode | First audio | Second candidate | Before generation finished? |
|---|---:|---:|---|
| OGG | 3463 ms | 3002 ms | **No** |
| Sentence MP3 | 826 ms | 3001 ms | Yes |

Both completed; neither failure nor slow sample was discarded. This is one sequential cold-client OGG / subsequent MP3 sample, not a fair P50/P95 comparison or mobile audible playback measurement. The OGG implementation sends the first sentence before later TTS inputs, but that alone did not deliver first audio before the three-second model gate in this run. Browser defaults therefore remain sentence MP3. `QA_OGG_STREAMING_ENABLED=true` permits staging browser capability selection for further testing; it is not enabled by default.
