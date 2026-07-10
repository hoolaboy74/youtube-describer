---
name: analyze_system_stats
description: 운영 서버(mom)의 SQLite DB 및 Nginx access.log를 SSH 연계 수집하여, 회원 가입 시점 이후의 영상 해설 생성 현황, 사용자 요청 랭킹, 플랫폼 접속 환경(모바일 vs PC) 통계를 분석하고 일반 텍스트 보고서로 작성하는 스킬입니다.
---
# 시스템 통계 분석 스킬 (analyze_system_stats)

이 스킬은 유튜브 영상 해설 서비스의 운영 지표 분석, 플랫폼 유입 분석, 회원/비회원 활동 및 커뮤니티 성과 지표 가공을 완전히 자동화합니다.

## 구성 요소

- **scripts/stats_collector.js**: 원격 운영 서버(`mom`)의 DB 및 Nginx 로그 파일을 조회하여 기기 및 API 데이터, 사용자 활동량(댓글, 게시글, 트래픽), 그리고 **실제 활성 사용자(Actual Active Users)의 회원/비회원별 진입 분포와 전환율**을 수집하고 `prod_report/system_stats_report_[시작일]_[종료일].txt` 일반 텍스트 파일로 작성하는 Node.js 유틸리티입니다.

## 작동 방식

1. 로컬 환경에서 `stats_collector.js`를 실행하면 SSH 커넥션을 이용해 원격 서버 `mom`으로 내장 통계 쿼리를 표준 입력으로 보냅니다.
2. 원격 서버에서 데이터를 집계(SQLite cache.db 조회 및 `/var/log/nginx/access.log*` 파싱)한 뒤 JSON 문자열로 로컬에 리턴합니다.
3. 로컬에서 수신된 데이터를 바탕으로 플랫폼 분포, 일별 추이, API 사용 비용, 에러 로그와 **회원/비회원의 소통 및 소비 활동 비율, 실제 재생 화면에 도달한 고유 IP(Actual Active Users) 방문자 수 및 전환율** 등의 통합 일반 텍스트 리포트(`.txt`)를 `prod_report/` 디렉토리에 자동 생성합니다.
4. 모든 조사는 사용자가 날짜 인자를 어떻게 입력하든 관계없이 무조건 **최초 회원가입 시점(2026-07-02 02:27:51)** 이후의 데이터만을 강제 한계선(하한선)으로 설정하여 필터링합니다. (그 이전의 개발/테스트 데이터는 제외됨)

## 실행 방법

### 1. 기본 실행 (전체 기간 조회)
최초 회원 가입 시점부터 현재 시점까지의 전체 데이터를 수집합니다.
```bash
node .agents/skills/analyze_system_stats/scripts/stats_collector.js
```

### 2. 특정 기간 조회
명령행 파라미터로 시작일과 종료일을 입력하여 조회 범위를 동적으로 지정할 수 있습니다.
- 인자 형식: `node stats_collector.js [YYYY-MM-DD] [YYYY-MM-DD]`
- 시작일이 최초 회원가입 이전일 경우, 강제로 최초 회원가입일(`2026-07-02 02:27:51`)부터 데이터가 집계됩니다.
- 입력하지 않은 값에 대해서는 시작일의 경우 `최초 회원 가입일`, 종료일의 경우 `현재 시각`이 기본 적용됩니다.

예시 1: 7월 한 달간 조회 (7월 1일부터 7월 31일까지)
```bash
node .agents/skills/analyze_system_stats/scripts/stats_collector.js 2026-07-01 2026-07-31
```
(이 경우 시작일 7월 1일은 최초 가입일 이전이므로 7월 2일 02:27:51부터 자동으로 보정되어 수집됩니다.)

예시 2: 7월 2일부터 7월 4일까지 조회
```bash
node .agents/skills/analyze_system_stats/scripts/stats_collector.js 2026-07-02 2026-07-04
```
생성되는 리포트는 날짜가 표시되어 다른 기간 파일들과 구분되어 `prod_report/` 디렉토리에 저장됩니다 (예: `prod_report/system_stats_report_20260702_20260704.txt`).
