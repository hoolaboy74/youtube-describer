require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function testGemini3ProPreview() {
    const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

    if (!API_KEY) {
        console.error("오류: GOOGLE_API_KEY 또는 GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.");
        return;
    }

    const genAI = new GoogleGenerativeAI(API_KEY);

    try {
        console.log("gemini-3-pro-preview 모델 로드 시도...");
        const model = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });
        console.log("gemini-3-pro-preview 모델 로드 성공.");

        console.log("간단한 텍스트 생성 요청...");
        const prompt = "오늘 날씨 어때?";
        const result = await model.generateContent(prompt);
        const response = result.response;
        const text = response.text();

        console.log("\n--- Gemini 3 Pro Preview 응답 ---");
        console.log(text);

    } catch (error) {
        console.error("\n--- Gemini 3 Pro Preview 테스트 중 오류 발생 ---");
        console.error("오류 메시지:", error.message);
        console.error("자세한 오류:", error);
    }
}

testGemini3ProPreview();
