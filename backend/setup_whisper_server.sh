#!/bin/bash
set -e

echo "=== whisper.cpp 빌드 및 다운로드 시작 ==="

WHISPER_DIR="/home/chacha/whisper.cpp"

if [ ! -d "$WHISPER_DIR" ]; then
    echo "1. GitHub에서 whisper.cpp 클론 중..."
    git clone https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
else
    echo "1. 이미 whisper.cpp 폴더가 존재합니다. Pull 수행..."
    cd "$WHISPER_DIR" && git pull
fi

cd "$WHISPER_DIR"

echo "2. whisper-cli 빌드 중 (CPU 전용)..."
# build/bin 디렉토리 미리 준비
mkdir -p build/bin

# make 빌드 수행
make -j$(nproc)

echo "3. ggml-base.bin 모델 다운로드 중..."
bash ./models/download-ggml-model.sh base

echo "4. 빌드 확인 및 바이너리 배치..."
if [ -f "./build/bin/whisper-cli" ]; then
    echo "-> 빌드 성공: ./build/bin/whisper-cli가 존재합니다."
elif [ -f "./main" ]; then
    echo "-> 빌드 성공: ./main 바이너리 복사 중..."
    cp ./main ./build/bin/whisper-cli
else
    echo "-> 빌드 실패: 바이너리를 찾을 수 없습니다."
    exit 1
fi

echo "5. 정상 구동 테스트..."
./build/bin/whisper-cli --help | head -n 5

echo "=== whisper.cpp 구축 완료 ==="
