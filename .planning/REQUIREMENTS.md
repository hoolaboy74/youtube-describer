# Requirements: 뷰래이터: YouTube 화면 해설 서비스

**Defined:** 2026-08-24
**Core Value:** 원음과 중복되지 않으면서 영상 이해에 꼭 필요한 시각 정보를 정확하고 자연스러운 한국어 음성 해설로 전달하는 것.

## v1 Requirements

### Description Policy and Language

- [ ] **POLICY-01**: 서비스는 `prompt_template_codex_v2.txt`의 시각적 근거 우선, 추측 금지, 짧은 한국어 존댓말, 태그, 타임스탬프, 반복 억제 규칙을 모든 장르 프롬프트에 적용한다.
- [ ] **POLICY-02**: 서비스는 한국어·외국어·혼합·unknown 원음 상태를 구분하고, 확인된 외국어만 필요한 경우 한국어 `[trans]`로 번역한다.
- [ ] **POLICY-03**: 한국어 원음 대사와 의미가 같은 자막·OCR·번역을 `[txt]`나 `[trans]`로 생성하거나 TTS로 중복 낭독하지 않는다.
- [ ] **POLICY-04**: 서비스는 생성 결과를 재생 전에 태그, 타임스탬프 범위, 언어 정책, 중복, 문장 길이, 대사와의 겹침, TTS 적격성 기준으로 검증한다.

### Genre Routing

- [ ] **GENRE-01**: 서비스는 제목, 대사 트랙, 오디오 언어, 대표 프레임을 사용해 영상을 뉴스·다큐, 강의, 예능, 영화·드라마, 스포츠·게임 중 하나로 분류한다.
- [ ] **GENRE-02**: 분류 신뢰도가 낮거나 신호가 충돌하면 서비스는 장르별 단정을 하지 않고 보수적인 범용 프로파일로 처리한다.
- [ ] **GENRE-03**: 서비스는 분류된 장르에 따라 화면 해설의 정보 우선순위, 말투, 상세도, 장면 변화 민감도를 조절하되 공통 안전·언어 정책은 완화하지 않는다.
- [ ] **GENRE-04**: 운영자는 5개 장르군과 한국어·외국어·혼합·unknown 원음 조합별 대표 영상 결과를 비교해 장르 라우팅 품질을 확인할 수 있다.

### Universal Chunk Processing

- [ ] **CHUNK-01**: 서비스는 짧은 영상과 긴 영상을 포함한 모든 영상을 기본 약 15분 단위의 청크로 분할해 처리한다.
- [ ] **CHUNK-02**: 각 청크는 전체 영상 메모리, 인접 구간 문맥, 장르 프로파일, 청크별 continuity state를 사용해 앞뒤 흐름을 유지한다.
- [ ] **CHUNK-03**: 서비스는 청크 초안을 제한된 동시성으로 병렬 생성하되 Gemini·FFmpeg·다운로드·TTS 자원 한도를 초과하지 않는다.
- [ ] **CHUNK-04**: 서비스는 청크 결과를 시간순으로 병합하고, 경계 중복·타임스탬프 오프셋·동일 대상의 불필요한 재소개를 제거한다.
- [ ] **CHUNK-05**: 서비스는 모든 청크가 완료되거나 명시적으로 실패한 상태를 보여주며, 최종 대본에 누락된 시간 구간과 검증되지 않은 결과를 조용히 포함하지 않는다.

### Jobs, Progress, and Recovery

- [ ] **JOB-01**: 사용자는 영상 생성 요청 직후 작업 ID와 접수 상태를 받고, HTTP 요청이 생성 완료까지 점유되지 않는다.
- [ ] **JOB-02**: 서비스는 작업·청크·시도 상태를 영속적으로 저장하고, 프로세스 재시작 후에도 완료된 청크를 보존하며 실패한 청크만 재시도하거나 작업을 재개한다.
- [ ] **JOB-03**: 동일 영상에 대한 중복 요청은 동일 작업으로 합쳐지거나 명확한 중복 상태를 반환하며, 청크 재시도가 중복 대본·중복 비용·중복 TTS를 만들지 않는다.
- [ ] **JOB-04**: 사용자는 준비 중인 단계, 현재 청크, 전체 진행률, 재시도 필요 여부, 재생 가능한 시간 범위를 확인할 수 있다.
- [ ] **JOB-05**: SSE 연결이 끊겼다가 복구되면 클라이언트는 저장된 이벤트와 현재 작업 상태를 기준으로 진행률과 대본을 복구하며, 이벤트 유실로 재생이 중복되지 않는다.

### Playback and Accessibility

- [ ] **PLAY-01**: 서비스는 검증이 끝난 시간 범위만 부분 재생으로 제공하고, 새 청크가 검증되면 기존 재생을 불필요하게 중단하지 않고 재생 가능 범위를 확장한다.
- [ ] **PLAY-02**: TTS 스케줄러는 한국어 원음과 중복되는 대사를 읽지 않고, 외국어 번역·독립적인 화면 글자·화면 해설만 정책에 맞게 재생한다.
- [ ] **PLAY-03**: 사용자는 키보드와 스크린리더로 생성 상태, 오류, 재시도, 재생·일시정지, 탐색, verbosity, 자막 읽기, 해설 오디오를 조작할 수 있다.
- [ ] **PLAY-04**: TTS 음성 길이와 원음·대사 시간 범위를 고려해 해설이 중요한 원음 정보를 가리거나 예기치 않게 겹치지 않는다.

### Evaluation and Operations

- [ ] **EVAL-01**: 프로젝트는 5개 장르군과 한국어·외국어·혼합·unknown 원음, 빠른 장면 변화, 화면 글자 중심 장면을 포함하는 재현 가능한 평가셋을 보유한다.
- [ ] **EVAL-02**: 평가 결과는 시각적 사실성, 원음 중복률, 번역 정확성, 타이밍·겹침, 청크 연속성, 장르 적합성, 반복·추측 발생률을 별도로 기록한다.
- [ ] **EVAL-03**: 운영자는 작업별 처리시간, 청크 대기시간, AI 비용, 재시도율, 캐시 적중률, 실패 원인, 임시 디스크 사용량을 확인할 수 있다.
- [ ] **EVAL-04**: 주요 릴리스는 시각장애인 또는 저시력 사용자의 실제 청취·스크린리더 사용성 검토와 재시작·디스크 부족·외부 API 오류 테스트를 통과해야 한다.

## v2 Requirements

### Extended Product Scope

- **V2-01**: 세분화된 전 장르·전 언어 자동 taxonomy와 사용자가 직접 만드는 장르 프로파일
- **V2-02**: 라이브 스트리밍 중 실시간 화면 해설 생성
- **V2-03**: 네이티브 iOS·Android 앱과 오프라인 다운로드
- **V2-04**: 사용자 편집, 커뮤니티 correction, 모델 fine-tuning workflow
- **V2-05**: 자유로운 narrator personality와 감정 연기 스타일
- **V2-06**: 자동 speaker identity·관계 그래프·무제한 plot inference
- **V2-07**: 여러 호스트로 확장되는 외부 Redis/BullMQ 작업 큐

## Out of Scope

| Feature | Reason |
|---------|--------|
| 원음 대사 또는 동일한 한국어 자막의 TTS 낭독 | 서비스의 핵심 가치인 원음 중복 방지와 충돌한다. |
| 모든 장면을 빠짐없이 설명하는 frame-by-frame narration | 청취 피로와 원음 방해를 유발하므로 의미 있는 변화 중심으로 제한한다. |
| 화면에 없는 인물 신원·관계·감정·원인 추론 | 시각장애인 사용자가 검증하기 어려운 허위 정보를 만들 수 있다. |
| 처음부터 다중 서버 분산 인프라로 전환 | 현재 단일 서버·SQLite 기반에서 내구성과 품질을 먼저 검증한다. |
| 실시간 스트리밍·모바일 앱·오프라인 기능 | 이번 마일스톤의 웹 기반 생성 파이프라인 범위를 넘어선다. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| POLICY-01 | Phase 1 | Pending |
| POLICY-02 | Phase 1 | Pending |
| POLICY-03 | Phase 1 | Pending |
| POLICY-04 | Phase 1 | Pending |
| GENRE-01 | Phase 3 | Pending |
| GENRE-02 | Phase 3 | Pending |
| GENRE-03 | Phase 3 | Pending |
| GENRE-04 | Phase 3 | Pending |
| CHUNK-01 | Phase 4 | Pending |
| CHUNK-02 | Phase 4 | Pending |
| CHUNK-03 | Phase 4 | Pending |
| CHUNK-04 | Phase 4 | Pending |
| CHUNK-05 | Phase 4 | Pending |
| JOB-01 | Phase 2 | Pending |
| JOB-02 | Phase 2 | Pending |
| JOB-03 | Phase 2 | Pending |
| JOB-04 | Phase 2 | Pending |
| JOB-05 | Phase 2 | Pending |
| PLAY-01 | Phase 5 | Pending |
| PLAY-02 | Phase 5 | Pending |
| PLAY-03 | Phase 5 | Pending |
| PLAY-04 | Phase 5 | Pending |
| EVAL-01 | Phase 6 | Pending |
| EVAL-02 | Phase 6 | Pending |
| EVAL-03 | Phase 6 | Pending |
| EVAL-04 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0 ✅

---
*Requirements defined: 2026-08-24*
*Last updated: 2026-08-24 after roadmap creation*
