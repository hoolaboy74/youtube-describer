require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

const YOUTUBE_EMAIL = process.env.YOUTUBE_EMAIL;
const YOUTUBE_PASSWORD = process.env.YOUTUBE_PASSWORD;
const COOKIES_FILE_PATH = __dirname + '/cookies.txt';

if (!YOUTUBE_EMAIL || !YOUTUBE_PASSWORD) {
  console.error('오류: .env 파일에 YOUTUBE_EMAIL과 YOUTUBE_PASSWORD를 설정해주세요.');
  process.exit(1);
}

/**
 * Puppeteer 쿠키 객체를 Netscape 형식으로 변환합니다.
 * yt-dlp는 이 형식을 사용합니다.
 * @param {Array<object>} cookies Puppeteer에서 가져온 쿠키 배열
 * @returns {string} Netscape 형식의 쿠키 문자열
 */
function formatCookies(cookies) {
  return cookies.map(cookie => {
    const { domain, path, secure, expires, name, value } = cookie;
    // httpOnly 플래그는 Netscape 형식에서 사용되지 않지만, yt-dlp 호환성을 위해 포함할 수 있습니다.
    const httpOnly = cookie.httpOnly ? 'TRUE' : 'FALSE';
    // expires가 -1이면 세션 쿠키이므로, 유효 기간을 0으로 설정합니다.
    const expiration = expires === -1 ? 0 : Math.floor(expires);
    return [domain, 'TRUE', path, secure ? 'TRUE' : 'FALSE', expiration, name, value].join('\t');
  }).join('\n');
}

async function run() {
  console.log('Puppeteer를 실행하여 자동 로그인을 시작합니다...');
  const browser = await puppeteer.launch({
    headless: true, // false로 설정하면 로그인 과정을 직접 볼 수 있습니다. 디버깅에 유용합니다.
    args: ['--lang=ko-KR,ko'] // 브라우저 언어를 한국어로 설정
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
  });

  try {
    console.log('구글 로그인 페이지로 이동합니다...');
    await page.goto('https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin');

    // 이메일 입력
    console.log(`[1/4] 이메일(${YOUTUBE_EMAIL})을 입력합니다...`);
    await page.waitForSelector('input[type="email"]');
    await page.type('input[type="email"]', YOUTUBE_EMAIL, { delay: 100 });
    await page.keyboard.press('Enter');

    // 비밀번호 입력 대기 및 입력
    console.log('[2/4] 비밀번호를 입력합니다...');
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 });
    await page.type('input[type="password"]', YOUTUBE_PASSWORD, { delay: 100 });
    await page.keyboard.press('Enter');

    // 2단계 인증 처리 대기
    console.log('[3/4] 로그인을 완료하고 있습니다. 2단계 인증(2FA)이 필요하면 90초 안에 기기에서 확인해주세요...');
    // 로그인 후 페이지 전환을 기다립니다. Google은 로그인 후 여러 리디렉션을 거칩니다.
    // My Account 페이지 로딩을 기준으로 성공 여부를 판단합니다.
    await page.waitForNavigation({ timeout: 90000 });
    
    const currentUrl = page.url();
    if (currentUrl.includes('myaccount.google.com')) {
        console.log('로그인에 성공했습니다!');
    } else {
        console.log('로그인 후 예상치 못한 페이지로 이동했습니다. URL:', currentUrl);
        console.log('유튜브로 직접 이동하여 쿠키를 가져옵니다.');
    }

    // 유튜브로 이동하여 쿠키 생성 보장
    console.log('유튜브로 이동하여 쿠키를 가져옵니다...');
    await page.goto('https://www.youtube.com', { waitUntil: 'networkidle2' });

    // 쿠키 추출 및 저장
    console.log(`[4/4] 쿠키를 추출하여 '${COOKIES_FILE_PATH}' 파일에 저장합니다...`);
    const cookies = await page.cookies();
    const formattedCookies = formatCookies(cookies);
    fs.writeFileSync(COOKIES_FILE_PATH, formattedCookies);

    console.log('✅ 성공! 쿠키가 성공적으로 업데이트되었습니다.');

  } catch (error) {
    console.error('❌ 오류가 발생했습니다:', error.message);
    console.error('스크린샷을 "error_screenshot.png" 파일로 저장합니다. 오류 원인을 확인하세요.');
    await page.screenshot({ path: 'error_screenshot.png' });
    console.error('팁: 로그인 과정에서 CAPTCHA나 예상치 못한 인증 단계가 나타났을 수 있습니다. headless: true 옵션을 false로 변경하여 과정을 직접 확인해보세요.');
  } finally {
    await browser.close();
    console.log('브라우저를 닫았습니다.');
  }
}

run();
