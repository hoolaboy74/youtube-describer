#!/bin/bash
set -e

[ $# -eq 1 ] || exit 1

MSG=$1
SSH_HOST="chacha@mom"

# Git 프록시 시작
/Users/chacha/src/git-proxy.sh start

echo "1. Git 로컬 커밋 중 (feature/video-qa)..."
git add .
git commit -m"$MSG" || echo "   -> 변경 사항이 없습니다."

echo "2. GitHub으로 푸시 중 (feature/video-qa)..."
git push origin feature/video-qa

# Git 프록시 종료
/Users/chacha/src/git-proxy.sh stop

echo "----------------------------------------------------"
echo "GitHub 푸시 완료. 원격 QA 배포 트리거 중..."
ssh $SSH_HOST "bash /home/chacha/deploy-qa-app.sh"
echo "QA 환경 배포 완료."
