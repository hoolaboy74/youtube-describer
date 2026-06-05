# 사용자 자격 수동 승인/반려 처리를 위한 어드민 UI 연동 및 DB 개선 계획

## User Review Required

> [!NOTE]
> 보안 정책상 시각장애인 복지카드 원본 이미지는 서버 디스크에 저장되지 않고 판독 즉시 휘발됩니다.
> 따라서 관리자는 Gemini 2.5 Flash가 판독한 OCR 상세 정보(이름/생년월일 일치 여부, 시각장애 표기 유무, 판독 신뢰도 점수)를 바탕으로 수동 검증을 수행합니다.

## Proposed Changes

### 백엔드 (Backend)

#### [MODIFY] [database.js](file:///Users/chacha/gem_agent/scr_desc/youtube-screen-describer/backend/database.js)
- `listPendingUsers` 개선: `user_verifications` 테이블과 LEFT JOIN하여 가입 요청 시 사용된 인증 수단 및 Gemini OCR 상세 판독 결과(`details`)를 함께 제공하도록 쿼리 수정.
- `updateUserBlindStatus` 개선: 트랜잭션을 적용하여 `users` 테이블 상태 업데이트와 동시에 `user_verifications` 테이블의 `status` 및 `verifiedAt` 필드를 자동으로 변경하도록 비즈니스 로직 보강.

---

### 프론트엔드 (Frontend)

#### [MODIFY] [Admin.js](file:///Users/chacha/gem_agent/scr_desc/youtube-screen-describer/frontend/src/screens/Admin.js)
- **탭 추가**: 기존 5개 탭 옆에 `사용자 관리` 탭을 새로 추가.
- **데이터 패칭**: `activeTab === 'users'` 진입 시 `GET /admin/pending-users` 호출 및 페이징/검색(필요 시 기본 목록화) 처리.
- **수동 승인/반려 액션**:
  - `POST /admin/users/:userId/approve` 및 `POST /admin/users/:userId/reject` 연동.
  - 처리 완료 시 성공 메시지 노출 및 목록 갱신(Refetch).
- **OCR 상세 판독 파서**:
  - `details` 필드의 JSON 파싱 예외 처리 추가.
  - 신뢰도(`confidenceScore`), 이름 일치 여부(`nameMatched`), 생년월일 일치 여부(`birthDateMatched`), 시각장애인 확인 여부(`isVisualImpairment`)를 한눈에 식별 가능한 배지(Badge) 형태로 렌더링.
- **접근성(Accessibility)**: 스크린리더를 고려한 표(Table) 헤더 구조 지키기 및 각 승인/반려 버튼에 사용자 식별 텍스트가 포함된 `aria-label` 적용.

#### [MODIFY] [Admin.css](file:///Users/chacha/gem_agent/scr_desc/youtube-screen-describer/frontend/src/screens/Admin.css)
- 사용자 관리 표 레이아웃 스타일 정의.
- 승인(Approve) / 반려(Reject) 버튼의 호버 및 액티브 액션 테마 추가 (기존 HSL 테마에 부합하는 프리미엄 글래스모피즘 계열 적용).
- OCR 일치 여부에 따른 Badge 컬러링 스타일 추가.

---

## Verification Plan

### Automated Tests / Manual Verification
1. **Mock 가입 및 인증 대기 상태 생성**:
   - `card_ocr` 방식을 선택하여 임의 정보로 가입. 판독 결과가 임계치(0.85) 미만이 되도록 설정하거나 임의로 `is_blind = 9` 레코드를 생성.
2. **관리자 로그인 및 사용자 관리 탭 진입**:
   - `/admin` 경로로 접속하여 어드민 패스워드로 로그인.
   - `사용자 관리` 탭 클릭 시 대기 상태 유저 정보 및 Gemini OCR 판독 스코어가 표로 정상 노출되는지 확인.
3. **수동 승인 작동 검증**:
   - 특정 유저의 "승인" 버튼 클릭 후 확인 창 승인.
   - 해당 유저가 목록에서 사라지는지 확인하고, SQLite DB 상에서 `users.is_blind = 1` 및 `user_verifications.status = 'approved'`로 변경되었는지 쿼리로 대조 확인.
4. **수동 반려 작동 검증**:
   - 다른 유저의 "반려" 버튼 클릭 후 확인 창 승인.
   - 해당 유저가 목록에서 사라지는지 확인하고, SQLite DB 상에서 `users.is_blind = 2` 및 `user_verifications.status = 'rejected'`로 변경되었는지 쿼리로 대조 확인.
