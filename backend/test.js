
    // .env 파일에서 환경 변수를 로드합니다.
    require('dotenv').config();

    const { GoogleGenerativeAI } = require("@google/generative-ai");

    // 환경 변수에서 API 키를 가져옵니다.
    // GOOGLE_API_KEY가 설정되어 있지 않으면 GEMINI_API_KEY를 시도합니다.
    const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

    if (!API_KEY) {
      console.error("오류: GOOGLE_API_KEY 또는 GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.");
      console.error(".env 파일 또는 시스템 환경 변수를 확인해주세요.");
      process.exit(1);
    }

    // GoogleGenerativeAI 클라이언트를 초기화합니다.
    const genAI = new GoogleGenerativeAI(API_KEY);

    async function run() {
      try {
        // 사용할 Gemini 모델을 가져옵니다. 여기서는 'gemini-pro'를 사용합니다.
        // Vision 모델을 사용하려면 'gemini-pro-vision'으로 변경하세요.
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

        const prompt = "안녕하세요, 제미니! 당신은 어떤 언어 모델인가요?";

        console.log("Gemini API 호출 중...");
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        console.log("\n--- Gemini 응답 ---");
        console.log(text);
        console.log("-------------------\n");

      } catch (error) {
        console.error("Gemini API 호출 중 오류 발생:", error);
        if (error.message.includes("invalid API key")) {
          console.error("API 키가 유효하지 않은 것 같습니다. .env 파일의 GOOGLE_API_KEY를 다시 확인해주세요.");
        }
      }
    }

    // 함수 실행
    run();

