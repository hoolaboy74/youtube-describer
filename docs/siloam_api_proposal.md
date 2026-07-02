# [기술 규격서] 실로암시각장애인복지관 - blindmom.org 회원 자격 검증 API 연동 규격서

**발신:** blindmom.org 개발팀  
**수신:** 실로암시각장애인복지관 시스템 어드민 및 개발 부서  
**일자:** 2026년 6월 17일  

---

## 1. 개요 및 목적

본 규격서는 `blindmom.org`(유튜브 화면 해설 서비스) 이용자가 실제 시각장애인인지 여부를 **실로암시각장애인복지관**(이하 "실로암")의 회원 DB 조회를 통해 비대면으로 검증하기 위한 가벼운 API 연동 규격을 정의합니다.

실로암 측의 개발 공수를 최소화하고 즉각적인 도입이 가능하도록 **API Key 단일 인증 및 방화벽 IP 통제** 기반의 검증 모델로 확정하여 제안합니다.

---

## 2. 연동 아키텍처 (Server-to-Server)

본 연동 모델은 사용자 브라우저가 직접 실로암 DB에 접근하지 않고, `blindmom.org` 백엔드 서버가 실로암 백엔드 API를 HTTPS로 직접 호출하여 일치 여부 피드백만 받는 구조입니다.

```mermaid
sequenceDiagram
    autonumber
    actor User as 사용자 (시각장애인)
    participant Client as blindmom.org 프론트
    participant Server as blindmom.org 백엔드
    participant Siloam as 실로암 검증 API (신설)
    database DB as 실로암 DB

    User->>Client: 실로암 인증 정보 입력<br/>(이름, 생년월일)
    Client->>Server: 검증 요청 (HTTPS POST)
    Server->>Siloam: POST /api/v1/members/verify<br/>(Header: X-API-Key, X-Org / Body: 회원 정보 JSON)
    Siloam->>Siloam: API Key 및 호출 IP 검증
    Siloam->>DB: 일치 여부 및 시각장애 여부 조회 (SELECT)
    DB-->>Siloam: 결과 반환
    Siloam-->>Server: JSON 결과 응답 (isValid: true/false)
    Server->>Server: 회원 등급 전환 및 인증 세션 처리
    Server-->>Client: 최종 인증 완료 알림
```

---

## 3. 보안 통제 표준

개발 공수를 줄이면서도 연동 데이터의 안전성을 보장하기 위해 다음과 같은 기본 보안 계층을 수립합니다.

1.  **전송 구간 암호화 (HTTPS 필수):**
    *   SSL/TLS 1.2 이상 규격의 암호화 통신만 허용하여 전송 데이터의 가로채기를 방지합니다.
2.  **호출 IP 화이트리스팅 (방화벽 통제):**
    *   실로암 API 서버 방화벽 단에서 `blindmom.org` 백엔드 서버의 고정 IP만 요청을 허용하도록 화이트리스팅을 설정합니다.
3.  **API Key 및 기관 식별자 인증:**
    *   HTTP 헤더에 고유 API Key(`X-API-Key`)와 요청 기관 식별자(`X-Org`)를 함께 담아 전송합니다.
    *   실로암 측은 API Key의 일치 여부를 검증하고, 요청 기관명이 `blindmom`으로 유효한지 확인하여 접근 권한을 확인해야 합니다.

---

## 4. API 규격 명세 (Interface Specification)

### 4.1. 요청 정보 (Request)

*   **Method / URL:** `POST [실로암 측 지정 URL]`
    *   *참고: 실제 호출 대상 URL(도메인 및 엔드포인트 경로)은 실로암 측에서 최종 결정하여 blindmom.org 측에 제공 및 통보해주셔야 합니다.*
*   **Content-Type:** `application/json; charset=utf-8`
*   **HTTP Headers:**
    *   `X-API-Key`: 실로암 측에서 발급하여 blindmom.org 측에 통보한 고유 API Key
    *   `X-Org`: 요청 기관명 식별자 (`blindmom`으로 고정하여 전송)

#### Request Body Schema
```json
{
  "name": "홍길동",                    // 실명 (UTF-8)
  "birthDate": "19900101"              // 생년월일 (YYYYMMDD 형식)
}
```

---

### 4.2. 응답 정보 (Response)

실로암 측 API 서버는 검증 결과를 표준 JSON 포맷으로 리턴합니다.

#### Case A: 자격 확인 성공 (HTTP Status 200 OK)
실로암 DB 내 정보가 일치하고, 시각장애인 분류가 유효하게 등록된 회원인 경우입니다.

```json
{
  "status": "success",
  "code": "SUCCESS_VERIFIED",
  "message": "인증에 성공했습니다.",
  "data": {
    "isValid": true,
    "verifiedAt": "2026-06-02T13:00:00Z"
  }
}
```

#### Case B: 자격 확인 실패 (HTTP Status 200 OK)
일치하는 정보가 존재하지 않거나, 실로암 회원은 맞으나 비장애인 회원인 경우입니다.

```json
{
  "status": "fail",
  "code": "AUTH_FAILED",
  "message": "일치하는 회원 정보가 없거나 인증을 처리할 수 없습니다.",
  "data": {
    "isValid": false
  }
}
```

#### Case C: 오류 처리 (HTTP Status 400 / 401 / 500)
요청 서식이 비정상적이거나, API Key가 누락/불일치하거나, 실로암 내부 시스템 에러가 발생한 경우입니다.

```json
{
  "status": "error",
  "code": "ERR_UNAUTHORIZED",
  "message": "유효하지 않은 API Key이거나 권한이 없습니다.",
  "data": null
}
```

---

## 5. 실로암 측 구현 기술 참조 (Node.js/Express 예시)

실로암 측의 쉬운 구현을 위해 작성한 가이드용 코드 스니펫입니다.

```javascript
const express = require('express');
const app = express();

app.use(express.json());

const ALLOWED_API_KEY = process.env.SILOAM_API_KEY; // 실로암에서 설정한 API Key값
const ALLOWED_IP = "xxx.xxx.xxx.xxx"; // blindmom.org 서버의 고정 IP

// 검증 미들웨어
function checkAccess(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const org = req.headers['x-org'];
  const clientIp = req.ip || req.connection.remoteAddress;

  // 1. IP 화이트리스트 검증 (프록시 환경 시 x-forwarded-for 등 고려 필요)
  if (clientIp !== ALLOWED_IP) {
    return res.status(403).json({ status: "error", code: "ERR_FORBIDDEN", message: "Forbidden IP access" });
  }

  // 2. API Key 검증
  if (!apiKey || apiKey !== ALLOWED_API_KEY) {
    return res.status(401).json({ status: "error", code: "ERR_UNAUTHORIZED", message: "Unauthorized API Key" });
  }

  // 3. 기관 식별자 검증
  if (!org || org !== 'blindmom') {
    return res.status(400).json({ status: "error", code: "ERR_BAD_REQUEST", message: "Invalid or missing X-Org header" });
  }

  next();
}

// 회원 검증 라우트
app.post('/api/v1/members/verify', checkAccess, async (req, res) => {
  const { name, birthDate } = req.body;

  try {
    // 실로암 내부 DB 조회 쿼리 실행
    // SELECT COUNT(*) as cnt FROM members WHERE name = ? AND birth_date = ? AND is_blind = 1
    const isBlindMember = await db.checkBlindMember(name, birthDate);

    if (isBlindMember) {
      return res.status(200).json({
        status: "success",
        code: "SUCCESS_VERIFIED",
        message: "인증에 성공했습니다.",
        data: { isValid: true, verifiedAt: new Date().toISOString() }
      });
    } else {
      return res.status(200).json({
        status: "fail",
        code: "AUTH_FAILED",
        message: "일치하는 회원 정보가 없거나 인증을 처리할 수 없습니다.",
        data: { isValid: false }
      });
    }
  } catch (error) {
    return res.status(500).json({
      status: "error",
      code: "ERR_INTERNAL_SERVER",
      message: "서버 내부 오류가 발생했습니다."
    });
  }
});
```
