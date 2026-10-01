---
name: analyze_system_stats
description: 운영 서버 mom의 읽기 전용 DB와 로그·캐시를 수집해 기능별 통계, 수집 범위와 측정 한계를 JSON/TXT로 작성합니다.
---
# 시스템 통계 분석 v2

소스는 test 브랜치의 `/Users/chacha/src/youtube-describer-test`에서 관리합니다. 운영 DB를 수정하거나 서버의 database.js를 import하지 않습니다.

## 실행

```bash
node /Users/chacha/src/youtube-describer-test/.agents/skills/analyze_system_stats/scripts/stats_collector.js 2026-08-01 2026-08-31 --output-dir /Users/chacha/src/youtube-describer/prod_report
```

출력은 `system_stats_report_YYYYMMDD_YYYYMMDD.json`과 `.txt`입니다. JSON이 후원 리포트의 입력이며, TXT는 같은 수집 결과를 사람이 검토하기 위한 문서입니다. 날짜는 실제 YYYY-MM-DD 달력 날짜로 검증하고 한국 시간의 시작일부터 종료일 다음날 00:00까지의 반개방 범위를 UTC로 변환합니다. 최초 가입일 이전 요청은 실제 가입 순간으로 보정합니다. 인자 생략 시 최초 가입부터 현재 한국 날짜까지 조회합니다.

TXT는 핵심 요약 → 해석 기준·수집 경고 → 기능별 상세 통계 → 수집 출처·테이블 부록 순서입니다. 한글 항목명, 천 단위 구분, 시간·비용·비율 단위와 정렬된 표를 사용합니다. 비정상 요청 방식의 긴 원문은 합계로 묶고 상세 원자료는 JSON에 보존합니다. 미측정 값을 0으로 바꾸지 않습니다.

기존 JSON으로 TXT의 형식만 다시 적용할 때는 아래 명령을 사용합니다. 원자료의 수집 시각·값과 HTML/PPTX는 바뀌지 않습니다.

```bash
node /Users/chacha/src/youtube-describer-test/.agents/skills/analyze_system_stats/scripts/stats_text.js /Users/chacha/src/youtube-describer/prod_report/system_stats_report_20260801_20260831.json
```

## 수집 범위

- 가입자, 현재 인증 상태, 인증 시도/결정, 등록 영상 상태·길이·일/요일/시간대·실패 분류.
- API 기능별·일별 요청과 고유 회원, 전체 API 및 핵심 기능 기준 DAU·달력 주 WAU·최근 7일 WAU·달력 월 MAU, 반복 이용 일수 분포, 주·월 재이용률, 신규 회원 첫 핵심 이용 지연·7일 재이용을 집계합니다. DB에는 method/status/latency가 없으므로 성공 행동 횟수로 해석하지 않습니다.
- 내부 통계의 상위 10명은 핵심 기능 요청 수 내림차순, 핵심 이용 일수 내림차순으로 선정합니다. 이름·이메일, 이용 일수, 기능별 요청, 기간 내 등록 영상 목록과 현재 완료·실패 상태를 JSON/TXT에 포함합니다. API 요청 수는 음성 조각·재시도에 영향을 받으므로 실제 청취 시간 순위가 아닙니다.
- 영상 ID가 경로에 있는 대본·영상·댓글·존재 확인 요청을 영상별로 집계합니다. `/tts`, `/process`의 요청 본문은 저장되지 않아 영상별 음성/생성 요청 수로 계산하지 않습니다.
- 설명/Q&A 상세 비용, 모델·토큰·thinking/cached/tool/search·가격 버전, Q&A 일별 요약과 대조 경고. 상세 원장과 요약 원장을 중복 합산하지 않습니다.
- Q&A 요청 영수증의 완료/실패/취소/사용량 불확실 상태, 현재 캐시 작업/lease/프레임/자막·참조 파일 상태.
- 대본 태그·정책·근거·TTS 적격성의 현재 전체 현황, 기간 내 검증 격리, 후원금 수입과 허용된 운영 설정.
- Nginx access/error 압축 로그, 일별 backend 로그의 QA-MEDIA/QA-GENERATION/QA-TTS/QA-COST 등 이벤트, 운영 서비스에 한정된 PM2 로그.
- 일반/Q&A TTS, Q&A 미디어, temp의 현재 디스크 및 파일 mtime 현황.

현재 20개 테이블의 처리 범위를 manifest로 기록합니다. 새 테이블, 누락 테이블/컬럼, 쿼리/파일 읽기 실패, 로그 미관측 날짜, 원장 불일치를 경고합니다. 상위 회원 식별에 필요한 이름·이메일만 내부 JSON/TXT에 포함합니다. IP·전화번호·생년월일·비밀번호·질문/답변 원문·오디오 티켓·민감한 settings 값은 출력하지 않습니다. 후원자용 HTML/PPTX에는 상위 회원 식별정보를 전달하지 않습니다.

## 해석 규칙

시청은 최근 20개 제한의 현재 보존 이력이며 반복 재생 시 갱신됩니다. 즐겨찾기는 현재 남아 있는 항목입니다. 실제 재생·클릭 횟수·완주율·실제 TTS HIT/MISS·합성 비용·브라우저 첫 음성 지연은 기록되지 않아 null/측정 불가로 표시합니다. 캐시 스냅샷을 월간 발생 횟수로 사용하지 않습니다. IP 방문과 인증 회원 수를 합산해 사람 수를 만들지 않습니다. 비용 기록 지연을 실제 빌드 완료 시간으로 표시하지 않습니다.

API 활성은 기록된 회원 ID의 고유 수이며 관리자·인증·조회도 포함합니다. 핵심 기능 활성은 해설 생성·대본 조회·해설 음성·Q&A 질문/음성 요청입니다. 검색·댓글 조회·상태 확인·Q&A 이벤트 연결/취소/접속 유지는 제외합니다. 두 기준 모두 실패 요청을 제거할 응답 상태가 없고 자동 요청을 완전히 구분하지 못합니다.

날짜는 한국 시간입니다. DAU에는 요청 없는 날짜도 0으로 포함하며 관측 범위를 별도로 표시합니다. 달력 주(월~일)·월의 조회 기간 밖 부분은 제외하고 부분 구간으로 표시합니다. 최근 7일 WAU는 조회 시작일 이전 6일도 포함합니다. 이전 달까지의 API 자료를 읽어 재이용률을 대조하되 최초 보존 로그 이후부터 수집 시각까지의 두 주/월 전체가 확보될 때만 비율을 계산합니다. 이 플래그는 삭제/누락 로그가 전혀 없음을 보장하지 않습니다. 신규 회원 7일 재이용률은 첫 핵심 이용 이후 7일을 끝까지 관측한 회원만 분모에 넣습니다.

## 후원 리포트

```bash
bash /Users/chacha/src/youtube-describer-test/.agents/skills/analyze_system_stats/scripts/run_monthly_report.sh 2026-08-01 2026-08-31
```

후원자용 본문은 기술 용어·후원 요청 문구 없이 현황을 간결하게 전달합니다. 승인된 구성은 영상 등록·해설 완료 → 가입·인증 → 이용 현황·익명 사례 → AI와 대화하기 활용도 → 기록된 비용 → 확인된 개발 사항 또는 다음 달 계획입니다. 전체 회원 수는 수집 시점 날짜를 명시하고, 인증 경로는 신규/전체 중 실제 집계한 범위를 표시합니다. 수집 시점 영상 상태를 월 내 완료 이벤트로 표현하지 않습니다. 확인되지 않은 향후 계획을 만들지 않습니다.

위 `run_monthly_report.sh`와 버전 관리 중인 builder는 과거 8장 구성을 출력하므로 그대로 최종본으로 전달하지 않습니다. 승인된 간결한 생성기는 `/Users/chacha/src/youtube-describer/prod_report/sponsor_report_20260901_20260930_builder/`에 보존되어 있습니다. 이 생성기와 Q&A 추가 집계 스크립트의 날짜·입력 파일은 9월 전용이므로 다른 달에는 조정합니다. 보고서 형식만 바꾸는 요청은 기존 JSON/TXT를 재사용합니다. 신규 기간의 통계를 요청하면 새로 수집합니다.

### AI와 대화하기 활용도

별도 슬라이드에 질문한 고유 회원 수, 접수된 질문 수, 답변 완료 수, 서로 다른 날에 재질문한 회원 수, 질문이 있었던 날짜 수를 표시합니다.

- 질문은 `data.activity.functions`의 `qa.request`·`qa.question.legacy` 기준입니다. 두 경로가 함께 있으면 회원 ID 합집합으로 고유 회원 수를 계산합니다. 접속 유지·설정·이벤트 연결·음성 조각·취소 호출을 질문으로 세지 않습니다.
- 답변 완료는 `data.qaReceipts.states`의 `status=completed` 합계입니다. 비용 호출 수·일별 비용 요약을 완료 답변 수로 대체하지 않고 실제 청취 완료라고 표현하지 않습니다.
- 최초 이용일·재질문 회원·질문 일별 자료가 부족하면 운영 DB를 읽기 전용으로 추가 조회합니다. 한국 시간 월 경계와 숫자 epoch 밀리초/SQL·ISO 시각을 정확히 처리합니다. 보충 결과는 식별정보 없는 `qa_activity_YYYYMMDD_YYYYMMDD.json`으로 저장하고 manifest `supportingSources`에 해시를 기록합니다. 기존 수집 JSON/TXT는 보존합니다.
- 시작일은 기존·신규 질문 경로의 가장 이른 운영 요청과 영수증·로그·배포 기록을 대조합니다. 코드 작성일·설정 조회일·영수증 테이블 도입일을 출시일로 단정하지 않습니다. 공식 배포 기록이 없으면 “최초 이용 확인”으로 표기합니다.
- 9월 확인 사례: 첫 질문 2026-09-14 21:56:55 한국 시간, 질문 회원 20명, 질문 460건, 답변 완료 425건, 재질문 회원 9명, 질문 이용일 17일. 다음 달에 이 수치를 재사용하지 않습니다.

회원 식별정보·질문/답변 원문을 후원자 산출물에 포함하지 않습니다. 비용 상세/일별 기록의 차이가 있으면 범위와 차이를 간결하게 명시합니다. 입력 JSON·보충 자료·생성기의 SHA-256을 manifest에 기록하고 슬라이드 수·페이지 번호·PPTX 관계·모바일·키보드 접근을 검증합니다. 서버 배포는 별도 요청이 있어야 합니다.

## 검증

```bash
cd /Users/chacha/src/youtube-describer-test
node --test .agents/skills/analyze_system_stats/scripts/stats_collector.test.js
python3 -m unittest discover -s .agents/skills/analyze_system_stats/scripts -p 'test_build_monthly_report.py'
```

`--local --db PATH --sqlite-module PATH`와 로그/캐시 경로 옵션으로 격리 fixture를 검사할 수 있습니다. 실제 API/AI 호출은 하지 않습니다.
