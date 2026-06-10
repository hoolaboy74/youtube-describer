#!/bin/bash
set -e

[ $# -eq 1 ] || exit 1

MSG=$1
SSH_HOST="chacha@mom"

# Git 프록시 시작
/Users/chacha/src/git-proxy.sh start

echo "1. Git 로컬 커밋 중 (test)..."
git add .
git commit -m"$MSG" || echo "   -> 변경 사항이 없습니다."

echo "2. GitHub으로 푸시 중 (test)..."
git push origin test

# Git 프록시 종료
/Users/chacha/src/git-proxy.sh stop

echo "----------------------------------------------------"
echo "GitHub 푸시 완료. 원격 테스트 배포 트리거 중..."
ssh $SSH_HOST "bash /home/chacha/deploy-test-app.sh"
echo "테스트 환경 배포 완료."
