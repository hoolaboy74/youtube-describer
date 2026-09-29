# 실험 이력과 평가 기준

이 문서는 남아 있는 보고서·결과를 근거로 한 인계이며, 과거 대화 전체의 축어록은 아니다. 정확한 프롬프트·모델·usage는 run_inventory.json 및 각 실행 원본을 우선한다.

## 흐름

1. Gemini/OpenAI 비교 도구를 모델 목록 조회, 반복 -m, 영상 -v, 프롬프트 -p, reasoning level, 캐시 재사용 형태로 일반화했다.
2. 가족 관찰 영상 lnUHSWhQ-UI에서 구형 프롬프트, v2, writer v3~v13 및 모델 설정을 비교했다. 확인된 리후 이름, 표정·맥락·필요 OCR을 살리되 보이지 않는 거래·행동을 만들지 않는 것이 주요 쟁점이었다.
3. v10 비교에서는 Astra medium이 Sol high 및 Pro Preview 비교 결과보다 적합했다. 특정 영상·소수 실행의 판단이며 보편적 모델 순위는 아니다.
4. Astra v12는 관찰 나열과 txt 형식은 개선했지만 필요한 반응도 생략했다. 간결함만으로 품질 개선을 판단하지 않았다.
5. Flash v14~v22는 가족 영상과 항공 설명 yaWS2T8aKjY에서 실험했다. 일부 개선이 있어도 행동 추정·OCR 누락/조기 표시가 남아 v13을 대체할 일관된 개선을 확인하지 못했다.
6. 별도 모델 검수(compare_model_review.js)는 일부 잘못된 표현을 고쳤지만 새 환각도 추가했다. 검수 모델 통과가 품질 보증은 아니다.
7. 영상 업로드(compare_model_video.js)는 가족 영상에서 시험했다. 현재 저해상도 MP4·정적 1fps 조건에서는 프레임 방식 대비 우월성이 확인되지 않았다. 첫 실행은 시간 형식 오류, 두 번째는 시각적 환각이 남았다.
8. 외국어 설명 영상 zWXvDmO4cQ0에서 번역 누락을 확인했다. 입력에는 있으나 모델 출력에서 빠진 내용이었다. v13의 번역 우선·무누락 보강으로 trans 83→167, 시각 해설 148→23. 주요 논거·수치·질문이 복원됐다.
9. 마지막으로 v13에 맥락 중심 집필·검수 세 절을 추가했다. 기존 문장 전체 보존 검증을 통과했지만 이 상태의 실영상 생성은 아직 없다.

## 대표 결과

| 비교 | 경로(result 아래) |
|---|---|
| 초기 Sol/Luna | lnUHSWhQ-UI/run-6o0J77 |
| 초기 Pro/Flash | lnUHSWhQ-UI/run-vx2Zrj |
| 과거 프롬프트 | lnUHSWhQ-UI/run-p4iZPT |
| 새 writer 초기 | lnUHSWhQ-UI/run-0dbSwa |
| v10 Astra medium | lnUHSWhQ-UI/run-NS4o7i |
| v10 Sol high | lnUHSWhQ-UI/run-r8qXdQ |
| v10 Pro | lnUHSWhQ-UI/run-Jir4KC, run-kZDWFU |
| Astra v12 | lnUHSWhQ-UI/run-7ovDmg |
| Flash v13 기준 | lnUHSWhQ-UI/run-U7ZxAx |
| 별도 검수 | lnUHSWhQ-UI/review-uvLJIv, yaWS2T8aKjY/review-NQDTXK |
| 영상 입력 | lnUHSWhQ-UI/video-aZCrbm, video-gspTkC |
| 영어 기존/번역 보강 | zWXvDmO4cQ0/run-QkXuYs, run-WxsKn1 |

## 평가

- 원음·필수 번역·해설을 합쳤을 때 전체 흐름을 이해할 수 있는가?
- 설명되지 않은 대상·공간·변화·반응·결과를 보완하는가?
- 화면에서 확인되지 않는 실행 동작·신원·감정 원인을 만들지 않았는가?
- 한국어 대사 자막을 다시 읽지 않으면서 필요한 독립 OCR은 남겼는가?
- 확인된 외국어 발화를 요약하거나 빠뜨리지 않았는가?
- 표시 시각과 번역 시작 시각, 문장 완결성, 실제 TTS 부담이 적절한가?
- backend 검증으로 내용이 사라지거나 변형되는가?

각 조건 단일 실행이 많은 실험이다. 모델 변동성을 인정하며 문장 수·txt 수·토큰 수·accepted 수를 품질 점수로 쓰지 않는다. 원음 전체 청취와 시각장애인 사용자 평가는 미완료다.

## 참고 가이드

DCMP Description Key: https://dcmp.org/descriptionkey/print

Netflix Audio Description Style Guide: https://partnerhelp.netflixstudios.com/hc/en-us/articles/215510667-Audio-Description-Style-Guide-v2-5

맥락에서 세부로, 이해·감상에 중요한 정보 선별 원칙을 적용했다. 기존 번역·시간·출력·근거 규칙을 바꾸는 지침은 별도 승인 없이 가져오지 않는다. 세부 근거는 reports/v13_context_guidance_notes_20260909.md 참조.
