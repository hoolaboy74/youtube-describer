# 주간 서버 운영 보고서 작성 가이드 (Weekly Report Writing Guide)

본 문서는 `youtube-describer` 운영 서버의 주간 지표를 수집하고 보고서를 작성하는 표준 절차를 정의합니다.

## 1. 보고서 기본 정보
- 운영 서버는 `ssh chacha@mom` 명령으로 접속 한다.
- **에이전트 노트:** Gemini CLI 에이전트는 `run_shell_command`를 통해 `ssh chacha@mom`에 직접 접속할 수 있는 권한이 있습니다. 보고서 작성 시 추측하지 말고 항상 서버에 접속하여 실측 데이터를 수집하십시오.

*   **작성 주기:** 매주 월요일 (전주 토요일 ~ 금요일 데이터 대상)
*   **대상 서버:** `chacha@mom` (운영 서버)
*   **로그 위치:**
    *   **백엔드:** `/app/youtube-describer/backend/logs/YYYY-MM-DD.log`
    *   **Nginx:** `/var/log/nginx/access.log*` (로테이션 파일 포함)
*   **데이터베이스:** `/app/youtube-describer/backend/db/cache.db`

## 2. 데이터 수집 단계 (Step-by-Step)

### 2.1 백엔드 로그 수집 및 병합
대상 기간의 로그를 하나로 합쳐 분석 효율을 높입니다.
```bash
# 예: 3월 7일 ~ 13일 로그 병합
ssh chacha@mom "cat /app/youtube-describer/backend/logs/2026-03-{07,08,09,10,11,12,13}.log" > combined_logs.txt
```

### 2.2 주요 지표 추출 (Grep Patterns)
`combined_logs.txt` 파일에서 다음 명령어로 통계를 산출합니다.

*   **총 생성 시도:** `grep -c "Starting processing for" combined_logs.txt`
*   **성공 횟수:** `grep -c "Full AI Process Time:" combined_logs.txt`
*   **실패 횟수 (DB 상태 기준):** `grep -c "Updated status for .* to failed" combined_logs.txt`
*   **실패 원인별 집계:**
    *   **Prohibited Content:** `grep -c "PROHIBITED_CONTENT" combined_logs.txt`
    *   **시간 초과:** `grep -c "duration_exceeded" combined_logs.txt`
    *   **임베드 불가:** `grep -c "cannot be embedded" combined_logs.txt`
    *   **yt-dlp 오류:** `grep -c "yt-dlp download failed" combined_logs.txt`
    *   **검색 오류:** `grep -c "reading 'browseId'" combined_logs.txt`
*   **Gemini API 총 비용 (USD):**
    ```bash
    grep "Logged API cost:" combined_logs.txt | awk '{sum += $8} END {print sum}'
    ```

### 2.3 Nginx 로그 분석 (Traffic & TTS)
로테이션된 로그 파일(`.gz`)을 포함하여 `zgrep`으로 분석합니다. 날짜 패턴은 `DD/Mon/YYYY` 형식을 사용합니다.

*   **주간 고유 방문자 (Unique IP):**
    실제 사용자와 관계없는 검색엔진 봇, 크롤러, 보안 스캐너 등의 트래픽을 제외하고 집계합니다.
    ```bash
    # bot, spider, crawler, slurp 등 주요 봇 키워드 제외 필터링 적용
    ssh chacha@mom "zgrep -E '07/Mar/2026|...|13/Mar/2026' /var/log/nginx/access.log* | grep -vEi 'bot|spider|crawler|slurp|facebookexternalhit|search|scanner' | awk '{print \$1}' | awk -F: '{print \$NF}' | sort -u | wc -l"
    ```
*   **총 요청 수:**
    ```bash
    ssh chacha@mom "zgrep -cE '07/Mar/2026|...|13/Mar/2026' /var/log/nginx/access.log*"
    ```
*   **TTS 호출 건수 (POST):**
    ```bash
    ssh chacha@mom "zgrep 'POST /api/tts' /var/log/nginx/access.log* | grep -E '07/Mar/2026|...|13/Mar/2026' | wc -l"
    ```

### 2.4 재정 데이터 확인 (SQLite)
*   **적용 환율 확인:** `SELECT value FROM settings WHERE key = 'exchangeRate';`
*   **주간 후원금 합산:**
    ```sql
    SELECT SUM(amount) FROM donations WHERE donation_date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD';
    ```

## 3. 보고서 작성 양식
기존 보고서(`docs/weekly_server_operation_report_*.md`)를 복사하여 다음 항목을 채웁니다.

1.  **운영 요약:** 주요 지표(성공률, 비용, 방문자 수)와 전주 대비 증감율 표시.
2.  **상세 운영 지표:** 트래픽 패턴 분석 및 실패 원인 TOP 3 분석.
3.  **시스템 오류 및 대응:** 특이 오류(SSL, 파싱 등) 발생 시 현황 기술.
4.  **종합 의견 및 제안:** 운영 중 발견된 문제점에 대한 개선 제안.

## 4. 주의 사항
*   **날짜 필터링:** Nginx 로그 검색 시 날짜 범위를 정확히 지정해야 중복 또는 누락을 방지할 수 있습니다.
*   **성공률 산출:** `(성공 횟수 / 총 시도 횟수) * 100`으로 계산합니다.
*   **로그 로테이션:** 오래된 로그는 `.gz` 파일에 있으므로 항상 `zgrep` 사용을 권장합니다.
