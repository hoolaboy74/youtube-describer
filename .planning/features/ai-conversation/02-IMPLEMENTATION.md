# AI와 대화하기 — 02 캐시·자원 기반 구현

작성: 2026-09-14. `test` 브랜치 구현. 운영 배포·푸시는 하지 않는다.

## 제공하는 기반

- SQLite에 `qa_cache_jobs`, `qa_frame_assets`, `qa_subtitle_assets`를 추가한다. 기존 영상/대본 레코드를 다시 쓰지 않는다. 캐시 루트는 `QA_CACHE_ROOT` 또는 기본 `backend/cache/qa`이며, 격리 DB 설정 시에는 해당 DB 옆 `qa-cache`를 사용한다. 서버 DB 초기화 시 캐시 자산을 대조하고, 만료 작업·없는 파일·손상 파일을 재조정한다. 영상 삭제 시 캐시 레코드와 작업 소유권도 함께 제거한다.
- 작업 선점은 SQLite immediate transaction, 60초 lease, 증가하는 fencing token을 사용한다. 만료 작업자는 갱신·자산 등록을 할 수 없다. 재사용 가능한 `renew` API를 제공하며 15초 갱신 루프는 03의 실제 worker에서 연결한다.
- JPEG는 복사본을 디코딩·크기·checksum 검증한 뒤 원자적 rename과 fenced DB 등록을 수행한다. VTT는 파일 형식을 확인하고 언어/provenance를 별도로 저장한다. VTT 큐의 문장 정책 검증을 대신하지 않는다.
- 현재 질문에는 timestamp 이하의 정상 자산만 반환한다. 프레임의 실제 PTS와 영상 시작 PTS, 정규화된 시각을 각각 저장한다. legacy 파일명에서 얻은 시각은 `legacy-*` 버전에만 저장하며 verified coverage로 승격하지 않는다.
- 자막 부재는 24시간, 일시 오류는 60초 재시도 정보를 갖는다. 정상 VTT는 부재 표시보다 우선한다. `.ko.vtt`라는 이름으로 한국어 원음을 추정하지 않는다.
- 세션 관심 참조는 개별 답변 취소와 구분하고 5분 만료를 제공한다. 실제 API heartbeat와 worker 재개는 03/05에서 연결한다.

## 실제 생성 경로 변경

`extractKeyframesHybrid`는 공통 `frameExtraction`을 호출하는 호환 wrapper가 된다. 반환값은 기존과 같은 초 단위 배열이고 파일명도 `frame-0001.jpg` 순서를 유지한다. 재표본화된 `fps` 시각과 `idx * 2` 보정을 제거했다. 원본 PTS 키프레임을 먼저 공개한 뒤 실제 coverage hole을 정확 seek로 백필하며, 백필 실패가 있으면 전체 완료로 반환하지 않는다.

신규 생성·배치·Q&A가 같은 프로세스의 다운로드 3개/전체 다운로드 1개/FFmpeg 3개/백필 2개 한도를 공유한다. 음성 언어 판별 FFmpeg도 포함하고 Whisper는 전역 2개로 제한한다. 여러 자원이 필요한 작업은 한 번에 예약하여 일부 permit만 잡은 채 기다리지 않는다. 진행 중 작업의 취소·timeout은 POSIX 프로세스 그룹을 종료하며 필요 시 강제 종료한다. 프로세스별 출력 버퍼도 제한한다.

디스크 예약은 같은 볼륨에서 공유하고 가용 2GiB 여유와 남은 쓰기 예약을 확인한다. 다운로드·키프레임 출력 초기 최대 1GiB, 자막 32MiB, 백필 임시 출력 16MiB를 적용한다. 실행 중 1초 간격과 종료 시 실제 크기를 확인한다. 외부 프로세스 쓰기를 바이트마다 가로채지는 않으므로 순간 초과 가능성은 있다. 완성된 미디어 삭제/재개 정책은 실제 캐시 worker의 책임으로 남긴다.

## 이번 단계의 검증

- 로컬 VFR+7초 시작 오프셋 fixture에서 키프레임·백필의 모든 source PTS를 원본 ffprobe 프레임과 대조했다. 같은 입력 재실행의 파일/checksum/시각 일치도 확인했다.
- 실제 1,040초 영상: 약 13.76초에 프레임 524개(키프레임 233, 백필 291), 2초 격자 coverage hole 0개. 추출 실험 1회이며 질문→첫 음성 지연과는 다른 수치다. [결과](results/extraction-20260913.json)
- SQLite 두 연결의 단일 선점, fencing, 반복 migration, 과거 프레임 선택, 손상 자산 거부, legacy 분리, VTT 부재 상태, 재시작 재사용, 관심 참조를 결정론적으로 검증한다.
- 자원 예약 원자성, 우선순위, 대기 취소, spawn 실패, timeout, 출력 한도, 자식 프로세스 종료, 디스크 부족/예약 한도와 기존 spawn 이벤트 호환을 검증한다.
- 기존 canonical·원음 언어·자막 provenance·Q&A 회귀와 기존 generator wrapper의 파일/시각 호환을 함께 실행한다.

최종 회귀 결과: backend 78/78 통과(임시 SQLite, 파일별 직렬 실행). 이번 변경은 backend와 검증 도구에 한정되므로 frontend 빌드를 반복하지 않았다. 기존 01의 frontend 계측 테스트/빌드 결과는 RESULTS.md에 남아 있다.

## 경계와 다음 작업

03에서 `ensureCurrentWindow`/`ensureFullCache`/`ensureSubtitles` 작업을 이 기반에 연결해야 한다. 현재 API가 이미 전체 Q&A 캐시를 구축한다고 주장하지 않는다. 자막 갱신 작업의 독립적인 소유권, 재시도 스케줄러, 15초 heartbeat, 공유 중 MP4 수명, 첫 질문 우선 처리도 그 연결 단계에서 구현한다.

01의 iPhone/Android 실기와 대표 5/15/30분 영상의 전체 전후 지연 비교는 계속 미완료다. 이 실기 검증을 완료로 표시하지 않고, 이미 확인한 원본 PTS와 제한된 프로세스·캐시 저장 계약을 먼저 구현했다. 단계 04–06의 문장 검증/TTS/플레이어 전환은 아직 적용하지 않았다.

FFmpeg 시간 처리 계약은 [공식 FFmpeg 문서](https://ffmpeg.org/ffmpeg.html), 구간 다운로드 옵션은 [yt-dlp 문서](https://github.com/yt-dlp/yt-dlp#download-options)를 확인했으며, 실제 설치 버전의 실행 결과를 위에 별도로 남겼다.
