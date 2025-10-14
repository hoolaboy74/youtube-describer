require('dotenv').config();
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

// This file is for isolating and testing the Text-to-Speech API call.

async function testTTS() {
    console.log('--- TTS API Test Initializing ---');

    // 1. Check for the crucial environment variable
    console.log(`NODE_EXTRA_CA_CERTS environment variable is: ${process.env.NODE_EXTRA_CA_CERTS || 'NOT SET'}`);

    // 2. Instantiate the client
    let ttsClient;
    try {
        ttsClient = new TextToSpeechClient();
        console.log('TextToSpeechClient instantiated successfully.');
    } catch (e) {
        console.error('!!! FAILED to instantiate TextToSpeechClient:', e);
        return;
    }

    // 3. Define the request
    const request = {
        input: { text: '안녕하세요. TTS API 테스트입니다.' },
        voice: { languageCode: 'ko-KR', ssmlGender: 'FEMALE', name: 'ko-KR-Wavenet-A' },
        audioConfig: { audioEncoding: 'MP3' },
    };
    console.log('Sending request to TTS API:', JSON.stringify(request, null, 2));

    // 4. Make the API call
    try {
        const [response] = await ttsClient.synthesizeSpeech(request);
        console.log('\n--- SUCCESS! ---');
        console.log('TTS API call was successful.');
        console.log(`Received audio content size: ${response.audioContent.length} bytes.`);
    } catch (error) {
        console.error('\n--- !!! API CALL FAILED !!! ---');
        console.error('The synthesizeSpeech call failed. Full error details below:');
        console.error(error);
    }
}

testTTS();
