const db = require('./database');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function to ask questions
function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  console.log('데이터베이스에서 삭제할 영상을 선택합니다.');
  console.log('-----------------------------------------');

  const videos = db.listVideos();

  if (videos.length === 0) {
    console.log('데이터베이스에 저장된 영상이 없습니다.');
    rl.close();
    return;
  }

  // 1. List all videos with a number
  console.log('삭제 가능한 영상 목록:');
  videos.forEach((video, index) => {
    console.log(`${index + 1}: ${video.title} (ID: ${video.videoId})`);
  });
  console.log('-----------------------------------------');

  // 2. Ask for the number to delete
  let videoToDelete = null;
  while (videoToDelete === null) {
    const answer = await askQuestion('삭제할 영상의 번호를 입력하고 Enter 키를 누르세요 (취소하려면 "c" 입력): ');

    if (answer.toLowerCase() === 'c') {
      console.log('작업을 취소했습니다.');
      rl.close();
      return;
    }

    const index = parseInt(answer, 10) - 1;
    if (index >= 0 && index < videos.length) {
      videoToDelete = videos[index];
    } else {
      console.log('잘못된 번호입니다. 목록에 있는 번호를 입력해주세요.');
    }
  }

  // 3. Ask for y/n confirmation
  let confirmed = false;
  while (!confirmed) {
    const confirmAnswer = await askQuestion(`정말로 "${videoToDelete.title}" 영상을 삭제하시겠습니까? (y/n): `);
    const answer = confirmAnswer.toLowerCase();

    if (answer === 'y') {
      confirmed = true;
    } else if (answer === 'n') {
      console.log('삭제를 취소했습니다.');
      rl.close();
      return;
    } else {
      console.log("'y' 또는 'n'을 입력해주세요.");
    }
  }

  // 4. Perform deletion
  try {
    const success = db.deleteVideo(videoToDelete.videoId);
    if (success) {
      console.log(`"${videoToDelete.title}" 영상이 데이터베이스에서 성공적으로 삭제되었습니다.`);
    } else {
      console.log('오류: 영상을 삭제하지 못했습니다. 해당 영상이 DB에 존재하는지 확인하세요.');
    }
  } catch (error) {
    console.error('삭제 중 오류가 발생했습니다:', error);
  } finally {
    rl.close();
  }
}

main();
