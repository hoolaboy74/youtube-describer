# 초안 생성 + 독립 검수 비교

test_scripts에서 실행:

```bash
node compare_model_review.js -m gemini-3.8-flash -v lnUHSWhQ-UI -p ./prompt_template_writer_v13.txt
node compare_model_review.js -m gpt-6-astra:medium -v lnUHSWhQ-UI -p ./prompt_template_writer_v13.txt
node compare_model_review.js -a
```

기존 compare_model.js와 옵션·provider·모델 검증·중복 제거·캐시 구현을 공유한다. 기존 스크립트의 단일 호출 동작은 유지한다. 새 스크립트는 선택한 각 모델/level로 초안을 생성한 뒤 같은 모델/level의 별도 호출에서 검수한다. 검수자는 동일한 전체 프레임, 기존 정책·제목·대사, 생성 초안을 받는다. 모델별로 성공 시 2회 호출하므로 비용이 추가된다. 모델 간 결과를 취합하는 기능은 아니다.

- -m MODEL[:LEVEL]: 반복 지정 가능. 동일 설정 중복은 한 번만 실행. 서로 다른 level은 다른 실행.
- -a: 계정에서 사용 가능한 Gemini/OpenAI 모델을 실시간 조회. 생성하지 않는다.
- -v: 영상 ID. result/VIDEO_ID/asset 캐시 공유.
- -p: 현재 작업 디렉토리 기준의 집필 프롬프트. 없으면 backend/.env에서 로드한 PROMPT_FILE 사용. 둘 다 없으면 오류. 기존과 같이 명시적 -p는 정책 마커 검증을 우회한다.
- 검수 규칙은 이 스크립트 옆 review_prompt.txt. -p의 집필 정책도 검수에 전달하며, 검수 시 사실 근거·원음 중복 금지·직접 txt 읽기를 별도로 요구한다.

결과는 result/VIDEO_ID/review-XXXXXX에 저장한다.

| 파일 | 내용 |
|---|---|
| MODEL.draft.txt | 수정하지 않은 초안 |
| MODEL.txt | 검수 모델의 최종 출력 |
| MODEL.review-prompt.txt | 초안을 포함한 실제 검수 요청 텍스트 |
| MODEL.stages.json | 단계별 상태·원문·시간·usage·오류 |
| result.json | 최종 결과, 초안/검수별 usage와 단계 결과 |
| prompt.txt / input_context.json | 집필 요청과 입력 정보·프레임 체크섬·설정 |

usage.draft와 usage.review는 provider 원래 필드를 보존한다. durationMs는 두 API 호출 시간의 합이다. 검수 실패 시 초안과 이미 소모된 usage는 보존하되 MODEL.txt로 초안을 대신 저장하지 않고 오류와 종료 코드 1을 반환한다. 초안 또는 검수 결과가 비어 있어도 실패로 취급한다. 자동 재시도·실패 단계 재개 기능은 없다.

생성 결과는 연구용 원본이며 DB·플레이어에 게시하지 않는다. 검수 모델을 통과했다는 사실만으로 시각적 정확성이나 재생 적격성을 보장하지 않는다.

## 2026-09-08 실측

Flash + v13, 캐시 재사용. 두 영상에서 총 4회 API 호출 성공.

| 영상 | 결과 폴더 | 초안→검수 항목 | 초안 / 검수 초 |
|---|---|---:|---:|
| 가족 관찰 lnUHSWhQ-UI | review-uvLJIv | 38 → 41 | 25.476 / 19.869 |
| 항공 설명 yaWS2T8aKjY | review-NQDTXK | 49 → 49 | 35.357 / 31.354 |

가족 영상: 126초의 '자신만만하게'와 194초의 '아빠의 말에'를 제거하고, 500초 '비밀번호를 누릅니다'를 '공동현관 문 앞에 도착합니다'로 바꾸었다. 572초의 현관문/엘리베이터 혼동도 수정했다. 그러나 424초 아이스크림 전달과 470초 아직 가게 안인데 나서는 묘사는 남았으며, 534초에는 보이지 않는 층수 표시기를 새로 추가했다. 610초의 '엄마' 지칭도 별도 근거 확인이 필요하다. 일부 수정은 유효하지만 전체 사실성 개선을 보장하지 못했다.

항공 영상: 254초 교신과 446초 계획 설명의 생략된 표현을 보충한 두 줄 외에는 초안과 같았다. 필요한 글자 누락을 폭넓게 복구하는 효과는 확인하지 못했다. 교신 글자의 txt/trans 분류는 원음 청취 없이 확정하지 않았다.

비교 스크립트·검수 단계 결정적 테스트 20/20 통과. 두 영상의 초안/최종본 모두 현재 canonical 검사에서 전부 accepted였지만, 이 검사는 위의 이미지 의미 오류까지 입증하지 않는다. 실제 원음·TTS 및 시각장애인 청취 평가는 하지 않았다. OpenAI 경로는 기존 구현을 공유하며 동일 설정 전달을 모의 테스트했지만 이번 유료 실측은 Gemini만 수행했다.
