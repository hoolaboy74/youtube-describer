# 실행과 의존성

main worktree의 test_scripts에서:

```bash
node compare_model.js -a
node compare_model.js -m gemini-3.8-flash -v zWXvDmO4cQ0 -p ./prompt_template_writer_v13.txt
node compare_model.js -m gpt-6-astra:medium -m gemini-3.1-pro-preview -v lnUHSWhQ-UI -p ./prompt_template_writer_v13.txt
node --test --test-concurrency=1 test_compare_model.js test_compare_model_review.js test_compare_model_video.js
```

- -a: Gemini/OpenAI의 계정별 모델 목록을 실시간 조회한다. 생성하지 않는다.
- -m: 반복 지정. 모델 존재 여부를 확인하고 같은 모델/level 설정은 중복 실행하지 않는다. level은 medium 등 지원 표기를 사용한다.
- -v: YouTube 영상 ID.
- -p: 현재 작업 디렉토리 기준 경로. 없으면 backend/.env의 PROMPT_FILE을 사용하고 둘 다 없으면 오류.
- 명시적 -p는 프롬프트 정책 마커 검사를 우회한다.
- 단일 호출: compare_model.js. 같은 모델 초안+검수 2회 호출: compare_model_review.js. Gemini 영상 파일 입력: compare_model_video.js (prompt_template_video_v13.txt 사용).
- 영상용 프롬프트는 별도 파생본이다. 현재 writer v13의 최신 변경이 자동 반영된 것은 아니다.

## backend 공유 유지

Phase 1 주요 코드가 현재 로컬 main에도 있다. 독립 패키지로 분리하지 않는다.

| 의존성 | 사용 |
|---|---|
| backend/node_modules | dotenv, Google SDK, googleapis 등 |
| backend/.env | API 키, PROMPT_FILE 등. 문서·결과에 키를 복사하지 않는다 |
| videoProcessor.js | extractKeyframesHybrid, parseVttToDialogueTrack, selectDialogueSubtitle |
| audioLanguageDetector.js | 원음 언어 판별 |
| promptPolicy.js | -p 미지정 경로의 프롬프트 검사 |
| database.js | 영상 길이 제한 설정 조회 |
| cookies, yt_dlp_plugins, yt-dlp, FFmpeg | 다운로드와 미디어 처리 |

다운로드는 compare_model.js 자체 구현이다. backend 다운로드 변경이 자동 반영되는 구조는 아니다. 공유 함수는 backend 변경을 반영하므로 실험 재현 시 backend 커밋도 기록하는 편이 좋다.

DB에 생성 결과를 게시하지는 않지만 database 모듈 로딩은 DB를 열고 WAL 설정을 수행한다. 단위 테스트·진단은 mktemp -d로 만든 임시 디렉토리의 test.db 절대 경로를 YOUTUBE_DESCRIBER_DB_PATH에 지정하고 --test-concurrency=1로 실행하여 서비스 DB 접촉과 병렬 초기화 충돌을 피한다. :memory:는 사용하지 않는다. backend가 path.resolve를 적용하므로 인메모리가 아니라 현재 경로의 파일로 해석된다.

## 결과와 캐시

result/VIDEO_ID/asset: 원본 MP4, 프레임, VTT, asset_manifest.json. 재사용 자산이며 임시 쓰레기가 아니다.

run-*/review-*/video-*: result.json, input_context.json, 실제 prompt.txt, 모델별 txt/error.txt. 검수 단계의 draft/stages와 영상 입력 메타데이터도 재현 자료로 보존한다.

캐시가 있어도 영상 메타데이터 API 조회는 한다. 새 프롬프트에는 -p를 명시한다. 과거 run의 prompt.txt가 해당 실행의 실제 지시문이며, 같은 v13 파일 이름만으로 동일 조건이라 판단하지 않는다.

## 보존

test_scripts/ 전체는 .gitignore로 제외한다. Git 백업이 아니므로 별도 로컬 백업이 필요하다. API 실패 기록에는 사용량·원인 정보가 있으므로 무조건 임시 파일로 삭제하지 않는다.
