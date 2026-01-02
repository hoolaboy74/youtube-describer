require('dotenv').config();
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const fs = require('fs');
const path = require('path');

// 프론트엔드 public 폴더에 저장하여 바로 접근 가능하게 함
const outputDir = path.join(__dirname, '../frontend/public/voice_samples');

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// 로컬 개발 환경(인증서) 대응
const ttsClientOptions = process.env.NODE_EXTRA_CA_CERTS ? { fallback: 'rest' } : {};
const client = new TextToSpeechClient(ttsClientOptions);

const voices = [
    { name: 'ko-KR-Wavenet-A', gender: '여성', type: 'Wavenet (현재 사용 중)' },
    { name: 'ko-KR-Wavenet-B', gender: '여성', type: 'Wavenet (차분함)' },
    { name: 'ko-KR-Wavenet-C', gender: '남성', type: 'Wavenet (굵은 톤)' },
    { name: 'ko-KR-Wavenet-D', gender: '남성', type: 'Wavenet (부드러움)' },
    { name: 'ko-KR-Neural2-A', gender: '여성', type: 'Neural2 (자연스러움)' },
    { name: 'ko-KR-Neural2-B', gender: '여성', type: 'Neural2 (뉴스 톤)' },
    { name: 'ko-KR-Neural2-C', gender: '남성', type: 'Neural2 (차분함)' },
];

async function generateSamples() {
    console.log(`Generating ${voices.length} voice samples...`);

    for (const voice of voices) {
        const text = `안녕하세요. 뷰레이터입니다. 지금 듣고 계신 목소리는 ${voice.type}, ${voice.gender}, ${voice.name}입니다.`;
        
        const request = {
            input: { text: text },
            voice: { languageCode: 'ko-KR', name: voice.name },
            audioConfig: { audioEncoding: 'MP3' },
        };

        try {
            const [response] = await client.synthesizeSpeech(request);
            const fileName = `${voice.name}.mp3`;
            const filePath = path.join(outputDir, fileName);
            
            await fs.promises.writeFile(filePath, response.audioContent, 'binary');
            console.log(`✅ Created: ${fileName}`);
        } catch (error) {
            console.error(`❌ Failed: ${voice.name}`, error);
        }
    }
    console.log('All samples generated in frontend/public/voice_samples');
}

generateSamples();
