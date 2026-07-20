---
name: trace_user_activity
description: 특정 사용자 ID를 입력받아 운영 서버(mom)의 DB 이력, Nginx access.log, 백엔드 처리 로그를 통합 조회하고 정밀 추적 리포트를 작성하는 스킬입니다.
---
# 사용자 정밀 추적 스킬 (trace_user_activity)

이 스킬은 특정 사용자의 식별 정보(ID 또는 이메일)를 기준으로 서비스 내 가입 내역, 활성 상태, 요청 및 시청 이력과 함께 접속에 사용된 모든 IP 주소, 기기 환경, 상세 서비스 이용 타임라인을 자동으로 수집 및 통합 보고서로 가공합니다.

## 구성 요소

- **scripts/trace_user.js**: 원격 운영 서버(`mom`)의 DB(`/app/youtube-describer/backend/db/cache.db`) 및 Nginx 로그, 백엔드 애플리케이션 로그를 추적하여 `user_audit/user_trace_report_[사용자이메일].txt` 텍스트 보고서를 자동 생성하는 Node.js 유틸리티입니다.

## 작동 방식

1. 로컬 환경에서 사용자 ID 또는 이메일 주소를 파라미터로 주어 `trace_user.js`를 실행합니다.
2. SSH 연결을 통해 원격 서버에서 정밀 통합 쿼리 및 로그 파일 검색 스크립트를 즉석 실행합니다.
3. 원격 데이터베이스의 사용자 상세 프로필, 시각장애인 인증 기록, 비디오 생성 요청 내역, API 비용 소모 내역, 시청/좋아요 기록, 커뮤니티 활동(글/댓글)을 취합합니다.
4. 사용자 가입 시점과 로그인 시점의 Nginx access.log를 대조하여 사용된 다중 IP 대역(가입 IP, 로그인 IP 등)을 추출하고, 해당 IP의 접속 경로와 User-Agent 및 TTS 오디오 호출 시퀀스를 타임라인으로 파싱합니다.
5. 유저가 생성 요청한 비디오 ID를 기반으로 백엔드 빌드 트랜잭션의 성공/실패 타임라인을 애플리케이션 로그에서 별도 병합합니다.
6. 로컬 프로젝트의 `user_audit/` 디렉토리에 통합 정밀 보고서 파일(`.txt`)을 **사용자의 로그인 이메일 주소명**으로 자동 적재하고 콘솔로 한글 리포트를 요약 출력합니다.

## 실행 방법

### 사용자 ID 또는 이메일을 이용한 추적
```bash
node .agents/skills/trace_user_activity/scripts/trace_user.js [사용자_ID_또는_이메일]
```

예시 1:
```bash
node .agents/skills/trace_user_activity/scripts/trace_user.js hoolaboy@gmail.com
```

보고서는 `user_audit/user_trace_report_hoolaboy@gmail.com.txt` 경로에 저장됩니다.

예시 2:
```bash
node .agents/skills/trace_user_activity/scripts/trace_user.js b26f6431-0474-4f16-81b1-1d1667541392
```

보고서는 `user_audit/user_trace_report_spiderman790536@gmail.com.txt` 경로에 저장됩니다. (UUID를 인자로 전달하더라도 내부적으로 이메일을 식별하여 이메일 이름의 파일이 생성됩니다.)
