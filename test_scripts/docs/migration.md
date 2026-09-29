# main worktree 인계 — 2026-09-09

- 원본: /Users/chacha/src/youtube-describer-test/test_scripts
- 목적지: /Users/chacha/src/youtube-describer/test_scripts
- 브랜치 merge/revert 없이 로컬 폴더를 복사한다. 이후 실험은 목적지에서 한다.
- 원본은 인계 시점 보존본으로 남긴다. backend와 .planning 문서는 변경하지 않는다.
- main의 .gitignore에 /test_scripts/를 추가한다. 폴더는 로컬 전용이며 Git 백업 대상이 아니다.
- docs/reports에는 기존 보고서 사본을 모았다. 기존 위치의 보고서도 과거 링크 호환을 위해 보존한다.
- 과거 결과 JSON·보고서의 절대 경로는 실행 당시 기록이다. 파일 내용을 일괄 수정하지 않고 현재 test_scripts 기준 상대 경로로 찾는다.

## 이전 전 정리

실행 중인 compare_model 프로세스가 없는 것을 확인한 후, 결과가 없는 미완료 폴더 result/lnUHSWhQ-UI/run-QfisMl의 prompt.txt와 input_context.json 및 빈 폴더를 삭제했다. 약 193KB의 준비 자료이며 대본·result.json은 없었다. 이 삭제 파일은 Git 미추적이므로 Git으로 복원되지 않는다.

성공 결과, 오류 결과, 검수 초안/최종본, API usage, 실제 요청 프롬프트와 입력 문맥은 보존했다. result/*/asset의 MP4·프레임·VTT는 재사용 캐시이므로 삭제하지 않았다. 이번 정리 범위 밖의 시스템 임시 디렉토리와 backend/temp는 건드리지 않았다.

## 검증 방식

복사 후 전체 상대 파일 목록·SHA256을 원본과 비교한다. main 환경에서 YOUTUBE_DESCRIBER_DB_PATH를 별도 임시 DB 절대 경로로 지정하고 --test-concurrency=1로 결정적 테스트를 실행한다. 이 테스트는 유료 생성이나 다운로드 호환성의 실측을 대신하지 않는다. main 환경의 API 키·모델 설정·외부 도구는 다음 실영상 실행 시 별도 확인한다.

최초 원본 테스트는 :memory:가 path.resolve로 실제 파일이 되고 병렬 WAL 초기화가 충돌해 실패했다. 그때 생성된 4KB 파일은 제거하고, 별도 임시 DB 및 직렬 테스트로 다시 확인한다. 서비스 cache.db를 사용한 실행은 아니다.

## 완료 결과

- main으로 복사 완료. 1,485개 파일, 158,116,997바이트에 대해 전체 파일 목록·SHA256 동일성을 확인했다(이 완료 문단 추가 전 기준).
- main .gitignore의 /test_scripts/ 제외를 git check-ignore로 확인했다. main의 추적 파일 변경은 .gitignore만 남았다. 커밋·브랜치 병합은 하지 않았다.
- 원본과 main 모두 결정적 테스트 25/25 통과. main 최초 실행은 로그 쓰기 sandbox 경고가 있었고, 권한 승인 후 재실행으로 확인했다.
- 새로운 모델 생성·다운로드·유료 API 호출은 하지 않았다. 서비스 DB 대신 /private/tmp/description-migration-tests.bNntQG의 별도 DB를 사용했다.
- 이후 작업 시작 문서: /Users/chacha/src/youtube-describer/test_scripts/docs/README.md
