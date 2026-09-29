#!/bin/bash
set -e

[ $# -eq 1 ] || exit 1

MSG=$1

# Git 프록시 시작
/Users/chacha/src/git-proxy.sh start

echo "1. Git 로컬 커밋 중..."
git add .
git commit -m"$MSG" || echo "   -> 변경 사항이 없습니다."

echo "2. GitHub으로 푸시 중 (main)..."
git push --follow-tags

# Git 프록시 종료
/Users/chacha/src/git-proxy.sh stop

echo "----------------------------------------------------"
echo "운영 배포 준비(Push)가 완료되었습니다."
echo "원격 운영서버에 접속하여 'bash /home/chacha/deploy-app.sh'를 실행하십시오."
