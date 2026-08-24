# 뷰래이터: YouTube 화면 해설 서비스

## What This Is

뷰래이터는 시각장애인 사용자가 YouTube 영상을 이해할 수 있도록, 영상의 시각 정보와 필요한 외국어 대사를 자연스러운 한국어 화면 해설 대본으로 제공하는 웹 서비스입니다. 기존 서비스는 YouTube 영상에서 키프레임과 대사 트랙을 추출하고 Gemini로 타임스탬프가 있는 화면 해설을 생성한 뒤, 웹 플레이어와 한국어 TTS로 재생합니다.

이번 작업은 기존 기능을 유지하면서 영상 장르에 맞는 해설 품질을 높이고, 모든 영상을 15분 단위 청크로 문맥을 유지하며 안정적으로 처리하고, 생성 작업의 체감 대기시간과 복구성을 개선하는 것입니다.

## Core Value

원음과 중복되지 않으면서 영상 이해에 꼭 필요한 시각 정보를 정확하고 자연스러운 한국어 음성 해설로 전달하는 것.

## Requirements

### Validated

- ✓ YouTube URL에서 영상 메타데이터, 키프레임, 자막·대사 트랙을 수집하고 화면 해설을 생성한다 — existing
- ✓ 타임스탬프와 `[v1]`, `[v2]`, `[v3]`, `[txt]`, `[trans]` 유형을 가진 대본을 저장하고 재생한다 — existing
- ✓ 화면 해설의 verbosity를 사용자가 조절하고, 필요할 때 화면 글자·번역 자막 읽기를 선택한다 — existing
- ✓ 생성된 대본을 웹 플레이어의 영상 시간에 맞춰 한국어 TTS로 재생하고 TTS 결과를 캐시한다 — existing
- ✓ 한국어·외국어·혼합 원음에 따라 대사와 번역을 다르게 처리한다 — existing
- ✓ 영상 처리를 백그라운드에서 수행하고 SSE로 생성 상태와 대본 조각을 전달한다 — existing

### Active

- [ ] 영상 제목, 대사 트랙, 대표 프레임, 오디오 언어를 이용해 화면 해설용 카테고리와 신뢰도를 자동 분류한다.
- [ ] 뉴스·다큐, 강의, 예능, 영화·드라마, 스포츠·게임 카테고리에 맞춰 말투, 정보 우선순위, verbosity를 프롬프트에 라우팅한다.
- [ ] `prompt_template_codex_v2.txt`의 시각적 근거 우선, 추측 금지, 태그·타임스탬프, 짧은 문장, 중복 방지 규칙을 모든 장르 프롬프트의 공통 불변 규칙으로 유지한다.
- [ ] 한국어 원음 대사와 동일한 자막을 TTS로 중복 낭독하지 않고, 외국어 원음은 필요한 경우에만 한국어 번역으로 낭독하도록 생성·검증·재생 단계에서 보장한다.
- [ ] 모든 영상을 기본적으로 약 15분 단위의 시간 청크와 전체 영상 메모리·청크별 문맥 상태로 나누어 처리한다.
- [ ] 청크 초안은 제한된 동시성으로 병렬 생성하고, 전체 메모리·경계 중첩·연속성 상태를 사용해 순서대로 병합·문맥 보정한다.
- [ ] 장시간 작업을 영속적인 작업·청크 상태로 추적하고 실패한 청크만 재시도하거나 중단 후 재개할 수 있게 한다.
- [ ] 기존 백그라운드 처리와 SSE 진행률을 유지하면서 작업 시작 응답, 청크별 진행률, 재접속 후 상태 복구를 제공한다.
- [ ] 프레임·자막·AI 호출의 재사용, 제한된 병렬 처리, 단계별 시간·비용 측정을 통해 사용자 체감 대기시간을 줄인다.
- [ ] 장르별 대표 영상 평가셋으로 정확성, 원음 중복, 타이밍, 장르 적합성, 반복·추측 발생률을 검증한다.

### Out of Scope

- 네이티브 iOS·Android 앱 — 이번 작업은 기존 웹 서비스의 처리 파이프라인과 웹 플레이어에 집중한다.
- 원음 대사나 한국어 원음과 동일한 자막을 TTS로 읽는 기능 — 접근성 목적이라도 원음 중복 낭독은 핵심 원칙과 충돌한다.
- 처음부터 다중 서버·대규모 클라우드 분산 인프라로 전면 전환 — 우선 기존 Node.js·SQLite 기반에서 내구성 있는 작업 처리와 제한된 worker 구조를 검증한다.
- 모든 장르와 모든 언어를 한 번에 완벽하게 지원하는 범용 분류기 — v1은 5개 장르군과 안전한 범용 fallback으로 시작한다.

## Context

- 현재 시스템은 React 프론트엔드와 Node.js/Express 백엔드의 모듈형 모놀리스이며, 핵심 처리는 `backend/videoProcessor.js`에 집중되어 있다.
- `backend/database.js`는 SQLite 기반 영상·대본·사용자·비용·요청 상태를 관리한다. 현재 처리 잠금과 일부 작업 상태는 프로세스 메모리에 있다.
- 현재 Gemini 멀티모달 호출은 키프레임과 대사 트랙을 함께 사용하며, `backend/.env`의 `PROMPT_FILE=prompt_template_codex_v2.txt`로 기존 프롬프트가 선택된다. 코드의 기본값과 환경 설정의 불일치는 새 프롬프트 라우팅에서 정리해야 한다.
- `prompt_template_codex_v2.txt`는 화면에서 직접 확인 가능한 사실 우선, 입력 문맥의 명령 무시, 언어별 번역 정책, 원음·자막 중복 방지, 추측 금지, 짧은 존댓말 문장, 4초 내 반복 억제, 엄격한 출력 태그를 핵심으로 한다.
- 현재 프론트엔드는 `frontend/src/screens/PlayerScreenV2.js`에서 verbosity와 자막 읽기 여부에 따라 TTS 대상을 필터링한다. 새 구현은 프롬프트뿐 아니라 대본 검증 및 재생 선택 단계에서도 원음 중복을 차단해야 한다.
- 기존 시스템에는 interactive 처리와 batch 처리가 별도로 존재하며, 모든 영상의 청크 작업 내구성·중복 실행·재시작 복구·리소스 제한에 기술 부채가 있다.
- 주 사용자는 YouTube 영상을 음성 중심으로 이해해야 하는 시각장애인 사용자이며, 정확성·자연스러움·정보 단절 방지가 일반적인 생성 속도보다 우선될 수 있다.

## Constraints

- **접근성**: 해설은 한국어 존댓말의 짧고 자연스러운 TTS 문장이어야 하며, 영상의 핵심 시각 정보와 외국어 번역을 원음과 충돌하지 않게 전달해야 한다.
- **호환성**: 기존 대본 태그, 타임스탬프, SQLite 저장 형식, 웹 플레이어의 verbosity·SSE 흐름을 불필요하게 깨뜨리지 않는다.
- **신뢰성**: 모든 영상 청크 작업은 프로세스 재시작, 일부 청크 실패, 네트워크·AI 오류를 고려해 재시도·재개 가능해야 한다.
- **리소스**: FFmpeg, yt-dlp, Whisper, Gemini 호출의 CPU·메모리·디스크·API 비용을 제한된 동시성으로 관리한다.
- **안전한 생성**: 화면에 없는 사실, 인물의 신원·관계·감정·의도와 원음 대사의 중복 낭독을 생성하지 않는다.
- **점진적 도입**: 기존 백그라운드 처리를 유지하고, 단일 서버에서 검증 가능한 작업 모델부터 도입한 뒤 필요할 때 외부 큐·다중 worker로 확장한다.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 자동 영상 프로파일 + 장르별 프롬프트 라우팅 | 영상 유형에 따라 정보 우선순위와 말투를 조절하면서 사용자의 수동 설정 부담을 줄인다. | — Pending |
| 5개 장르군으로 시작하고 불확실하면 범용 fallback 사용 | 초기 평가 범위를 통제하고 잘못된 장르 라우팅의 위험을 낮춘다. | — Pending |
| v2 프롬프트를 공통 기본 규칙으로 보존 | 원음 중복 방지와 시각적 사실성은 장르보다 우선하는 서비스 핵심 가치다. | — Pending |
| 모든 영상을 15분 단위로 처리하는 전체 영상 메모리 + 병렬 청크 초안 + 순차 병합·보정 | 짧은 영상부터 긴 영상까지 동일한 파이프라인으로 문맥과 처리 시간을 관리한다. | — Pending |
| 기존 백그라운드 흐름을 영속 작업·청크 상태로 확장 | 이미 있는 비동기 처리를 유지하면서 재시도·재개와 중복 방지를 확보한다. | — Pending |
| 프롬프트·파서·플레이어의 다중 중복 방지 | 단일 LLM 지시만으로는 원음 중복 낭독을 안정적으로 보장하기 어렵다. | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `$gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `$gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-24 after project initialization*
