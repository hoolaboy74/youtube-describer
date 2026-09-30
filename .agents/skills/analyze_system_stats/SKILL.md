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
- API 기능별 요청·고유 인증 회원·일별 이용. DB에는 method/status/latency가 없으므로 성공 행동 횟수로 해석하지 않습니다.
- 설명/Q&A 상세 비용, 모델·토큰·thinking/cached/tool/search·가격 버전, Q&A 일별 요약과 대조 경고. 상세 원장과 요약 원장을 중복 합산하지 않습니다.
- Q&A 요청 영수증의 완료/실패/취소/사용량 불확실 상태, 현재 캐시 작업/lease/프레임/자막·참조 파일 상태.
- 대본 태그·정책·근거·TTS 적격성의 현재 전체 현황, 기간 내 검증 격리, 후원금 수입과 허용된 운영 설정.
- Nginx access/error 압축 로그, 일별 backend 로그의 QA-MEDIA/QA-GENERATION/QA-TTS/QA-COST 등 이벤트, 운영 서비스에 한정된 PM2 로그.
- 일반/Q&A TTS, Q&A 미디어, temp의 현재 디스크 및 파일 mtime 현황.

현재 20개 테이블의 처리 범위를 manifest로 기록합니다. 새 테이블, 누락 테이블/컬럼, 쿼리/파일 읽기 실패, 로그 미관측 날짜, 원장 불일치를 경고합니다. 개인정보·IP·질문/답변 원문·오디오 티켓·민감한 settings 값은 출력하지 않습니다.

## 해석 규칙

시청은 최근 20개 제한의 현재 보존 이력이며 반복 재생 시 갱신됩니다. 즐겨찾기는 현재 남아 있는 항목입니다. 실제 재생·클릭 횟수·완주율·실제 TTS HIT/MISS·합성 비용·브라우저 첫 음성 지연은 기록되지 않아 null/측정 불가로 표시합니다. 캐시 스냅샷을 월간 발생 횟수로 사용하지 않습니다. IP 방문과 인증 회원 수를 합산해 사람 수를 만들지 않습니다. 비용 기록 지연을 실제 빌드 완료 시간으로 표시하지 않습니다.

## 후원 리포트

```bash
bash /Users/chacha/src/youtube-describer-test/.agents/skills/analyze_system_stats/scripts/run_monthly_report.sh 2026-08-01 2026-08-31
```

항상 새로 수집한 v2 JSON으로 같은 디자인의 HTML/PPTX와 입력 SHA-256 manifest를 생성합니다. 서버 배포는 별도 요청이 있어야 합니다.

## 검증

```bash
cd /Users/chacha/src/youtube-describer-test
node --test .agents/skills/analyze_system_stats/scripts/stats_collector.test.js
python3 -m unittest discover -s .agents/skills/analyze_system_stats/scripts -p 'test_build_monthly_report.py'
```

`--local --db PATH --sqlite-module PATH`와 로그/캐시 경로 옵션으로 격리 fixture를 검사할 수 있습니다. 실제 API/AI 호출은 하지 않습니다.
