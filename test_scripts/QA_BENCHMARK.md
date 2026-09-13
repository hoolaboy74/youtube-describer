# AI와 대화하기 01: 기준 측정 도구

애플리케이션의 첫 음성 개선 전 기준과 외부 기능을 측정한다. 기본 명령은 오프라인이며 운영 DB/캐시를 열거나 지우지 않는다. `qa_provider_probe.js --live`만 실제 유료 API를 호출한다. 결과 해석과 남은 검증은 [RESULTS.md](../.planning/features/ai-conversation/RESULTS.md)에 기록한다.

## 로컬 미디어와 환경

저장소 루트에서 실행한다.

```sh
node test_scripts/qa_latency_benchmark.js environment
node test_scripts/qa_latency_benchmark.js matrix
node test_scripts/qa_latency_benchmark.js media > /tmp/qa-media.json
node --test backend/tests/qaLatencyBenchmark.test.js
```

`media`는 OS 임시 디렉터리에 24초짜리 작은 합성 영상을 만들고 종료 시 해당 디렉터리만 삭제한다. 조밀 CFR, 성긴 CFR, VFR+7초 오프셋 3종에서 각 필터를 1회 실행한다. libx264가 있는 FFmpeg와 ffprobe가 필요하다. 각 명령은 최대 60초, 로그 최대 16MiB다. 실패는 results에 남으므로 exit code만으로 통과 여부를 판단하지 않는다.

`sourcePts`는 ffprobe 키프레임 기준이며 `outputPts`는 FFmpeg showinfo 결과다. `inventedPts`는 원본 키프레임에 없는 출력 시각이고, `coverageHoles`는 2초 격자 ±1초 내 근거가 없는 위치다. `source-pts`의 `exactSourceMatch`가 모두 true인지 확인한다. `fps`로 복제한 출력의 시각은 원본 근거로 사용할 수 없다. 이 시험은 null sink를 사용하므로 JPEG 저장 처리량이나 네트워크 성능 시험이 아니다.

## 실제 provider 기능 확인

```sh
node test_scripts/qa_provider_probe.js --live /tmp/qa-provider-run-01
```

출력 디렉터리는 존재하지 않아야 한다. `backend/.env`의 API 키, QA 모델과 TTS 인증 파일을 사용하며 상대 인증 경로는 backend 기준이다. 인증 값·모델 응답 원문·오류 메시지의 URL은 결과에 남기지 않는다. 기존 애플리케이션 DB에는 비용을 쓰지 않는 격리 시험이며 provider usage와 호출 예산을 JSON에 기록한다. 실패한 호출의 비용을 0으로 간주하지 않는다.

한 실행의 상한은 모델 2회(회당 출력 최대 512토큰), 검색 옵션 요청 1회, MP3 2회, OGG 1회, 총 합성 텍스트 52자다. 자동 재시도하지 않는다. MP3 호출당 15초, 모델 요청/OGG는 20초 제한이다. 비용의 달러 상한을 보장하는 도구는 아니므로 반복 실행은 이 호출 예산을 누적한다.

- JSONL은 완성된 줄만 파싱하고 미완성 꼬리를 별도 기록한다. 이 파서는 형식 시험 전용이며 서비스의 근거·언어·중복 validator가 아니다.
- 검색 옵션+JSON schema의 요청 수락을 확인한다. 실제 검색을 강제하지 않으므로 `searchQueries: 0`이면 검색 결과를 사용한 답변 검증은 미실시다.
- OGG는 첫 문장을 넣고 3초 뒤에 두 번째 문장을 넣는다. `firstByteBeforeSecondInput`으로 선행 오디오를 확인한다. 모델 출력을 직접 합성하지 않고 고정된 시험 안내 문장만 사용한다.
- MP3는 고정 문장별 독립 합성을 확인한다. 이 시험은 모델→정책 검증→TTS의 통합 경로나 실제 브라우저 청취를 검증하지 않는다.

## 실제 브라우저 계측

플레이어를 연 탭의 개발자 도구에서 명시적으로 켠다. fixture/device/run은 원문이나 개인정보를 포함하지 않는 영문·숫자·점·하이픈·밑줄 식별자(80자 이하)다.

```js
sessionStorage.setItem('qaLatencyBenchmark', JSON.stringify({
  enabled: true,
  fixture: 'video-5m-dense-subtitles',
  cacheState: 'cold',
  device: 'iphone-safari-voiceover',
  run: 'before-01'
}));
```

평소처럼 질문한다. `firstText`, `generationDone`, `ttsRequested`, `firstPlaying`은 같은 브라우저의 performance.now 기준 경과 ms다. `play()` 호출·응답 수신을 실제 재생으로 집계하지 않는다. 처음 `playing`이 발생하면 표본을 종료한다. 따라서 이후 끊김/문장 간 공백/완청 여부는 별도 청취 시험으로 기록해야 한다. 최초 응답 실패·음성 없음·자동재생 차단·오디오 오류·교체·125초 timeout도 보관한다. 기본 동작은 비활성이고, 활성 표본만 탭 메모리에 최대 500개 남긴다. 이는 대화 이력 제한과 무관하다.

완료 표본을 JSON으로 내보낸다(Chrome DevTools의 `copy`, 다른 브라우저는 JSON 문자열을 파일로 저장).

```js
copy(JSON.stringify(window.__qaLatencyRecords || [], null, 2));
sessionStorage.removeItem('qaLatencyBenchmark');
```

```sh
node test_scripts/qa_latency_benchmark.js summarize /tmp/qa-browser-records.json
```

cold/warming/warm, 기기, 음성 형식, 영상 식별자, 시점, 전체 이력 수를 섞지 않고 nearest-rank P50/P95를 계산한다. 재생되지 않은 표본은 지연 0으로 만들지 않고 실패 개수로 남긴다. cacheState는 **시험자가 설정한 라벨이며 자동 검증된 캐시 상태가 아니다**. 서버의 `fromCache`만으로 VTT와 전체 캐시 준비를 확정하지 않는다. 측정 전 격리된 시험 서버에서 실제 자산 상태를 확인한다. 운영 캐시를 지우지 않는다.

## 저장된 오디오로 계측 연결 확인

```sh
node test_scripts/qa_browser_audio_probe.js /tmp/qa-provider-run-01 > /tmp/qa-browser-probe.json
```

설치된 Puppeteer Chromium으로 로컬 전용 시험 페이지를 열고 키보드 Enter로 MP3/OGG를 재생한다. 페이지에서 같은 계측 모듈의 실제 `playing`을 확인한다. 저장된 파일을 읽으므로 **실시간 provider 스트림, 제품 end-to-end 지연, 휴대폰, 스크린리더, 실제 소리 검증은 아니다**. HTTP 서버는 127.0.0.1의 임의 포트이며 완료 후 닫힌다.

## 남은 실기 실행

`backend/tests/fixtures/qa/benchmark.json`의 endToEndMatrix는 실행 조건표다. 실제 5/15/30분 영상 목록이나 실행 완료 기록이 아니다. 대표 영상 선정 후 초반/중간/끝, 자막 있음/없음/일시 오류, 1/10/50턴, cold/warming/warm을 같은 조건에서 전후 비교한다. 이력은 실제 직전 대화 원문을 유지하며 임의 생성·축약하지 않는다. 시험별 영상 식별자, timestamp, 도구/OS/브라우저 버전, 반복 수, 실패와 기기 청취 결과를 기록한다.

구간 다운로드는 해당 프로토콜/쿠키/프록시 환경에서 전체 다운로드와 비교한다. 다운로드 파일 크기를 실제 전송 바이트로 간주하지 않는다. 실제 전송량과 중복량을 측정하기 전 비용 절감이나 속도 개선을 주장하지 않는다.

회귀 테스트가 기존 routes.js를 import하면 SQLite를 열므로 `YOUTUBE_DESCRIBER_DB_PATH`를 새 임시 경로로 설정한다. 여러 테스트 파일이 같은 DB 경로를 쓰는 실행은 `--test-concurrency=1`로 직렬화한다. `backend/npm test`는 실제 테스트 suite가 아니다.

## 전체·구간 다운로드 실측 (2026-09-14 추가)

```sh
node test_scripts/qa_download_benchmark.js --live OT0wMk7yIEo 120 /tmp/qa-download-new-run
```

출력 디렉터리는 새 경로여야 한다. 전체 1회와 `[T-4,T+2]` 구간 1회를 순서대로 받으며 쿠키·기존 yt-dlp 설정·운영 캐시를 사용하지 않는다. 두 요청 모두 video-only, 최대 480p MP4 선택식이다. 명령당 60초, 알려진 파일 크기 100MiB, 시험 디렉터리 실제 사용량 예약 200MiB를 적용한다. 디스크 가용 공간은 여유분 2GiB 이상이어야 한다. 사용량은 실행 중 1초 간격 및 종료 시 검사하므로 외부 프로세스가 그 사이에 잠시 한도를 넘길 수 있다.

로컬 wrapper가 오래된 Python을 선택할 때만 해당 실행의 PATH를 지정한다. 전역 Python 설정은 변경하지 않는다.

```sh
QA_BENCHMARK_PATH="/opt/homebrew/bin:$PATH" node test_scripts/qa_download_benchmark.js --live OT0wMk7yIEo 120 /tmp/qa-download-new-run
```

localhost CONNECT proxy가 **실제 수신 TLS 바이트**를 googlevideo 미디어와 나머지 메타데이터로 나누어 센다. TLS/HTTP 오버헤드를 포함하며 암호화된 URL·쿠키·본문은 기록하지 않는다. `fileBytes`는 파일 크기이고 `mediaInboundBytes`와 다르다. 추가 구간 요청의 미디어 수신량은 관찰할 수 있지만, 암호화된 원본 바이트 범위의 정확한 중복량은 측정하지 않는다. proxy 사용 자체의 오버헤드와 전체→구간 실행 순서 효과가 있으므로 1회 결과를 일반화하지 않는다.

두 파일의 formatId가 같으면 FFmpeg framemd5로 구간 프레임을 원본 프레임의 PTS에 대응시킨다. 반복 정지 화면으로 후보 PTS가 여러 개이면 모호성을 그대로 남긴다. 구간의 0초를 원본 T-4초와 무조건 같다고 가정하지 않는다. 비교 중 `-copyts`와 종료 시각은 같은 기준을 사용하며, 비교 프레임 0개를 성공으로 처리하지 않는다.
