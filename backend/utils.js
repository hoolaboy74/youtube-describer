const crypto = require('crypto');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require('./logger');

// --- Existing Time/YouTube Utilities ---

function formatTime(seconds) {
    return new Date(seconds * 1000).toISOString().substr(11, 8);
}

function getYoutubeVideoId(url) {
    try {
        const urlObj = new URL(url);
        if (urlObj.hostname === 'youtu.be') return urlObj.pathname.substring(1);
        if (urlObj.hostname.includes('youtube.com')) {
            const v = urlObj.searchParams.get('v');
            if (v) return v;

            const pathParts = urlObj.pathname.split('/');
            if (['live', 'shorts', 'v', 'embed'].includes(pathParts[1])) {
                return pathParts[2];
            }
        }
    } catch (e) { /* Ignore parsing errors */ }
    return null;
}

function preprocessVtt(vttContent) {
    if (!vttContent) return '';

    return vttContent
        .replace(/WEBVTT\n/g, '')
        .replace(/Kind:.*\n/g, '')
        .replace(/Language:.*\n/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})/g, (match, hh, mm, ss, ms, hh2, mm2, ss2, ms2) => {
            const toSec = (h, m, s, msec) => parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(msec, 10) / 1000;
            return `(${toSec(hh, mm, ss, ms).toFixed(1)}s) --> (${toSec(hh2, mm2, ss2, ms2).toFixed(1)}s)`;
        })
        .replace(/\n{2,}/g, '\n')
        .trim();
}

const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(watch\?v=|embed\/|v\/|live\/|shorts\/|)([\w-]+)([?&].*)?$/;
function isValidYoutubeUrl(url) {
    return YOUTUBE_URL_REGEX.test(url);
}

// --- New Authentication & Verification Utilities ---

/**
 * PBKDF2 기반 비밀번호 해싱
 */
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

/**
 * 비밀번호 검증
 */
function verifyPassword(password, storedPassword) {
    if (!storedPassword || !storedPassword.includes(':')) return false;
    const [salt, hash] = storedPassword.split(':');
    const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return hash === verifyHash;
}

/**
 * 실로암 API를 통한 회원 자격 조회 (1안: API Key + IP 통제)
 */
async function verifySiloamMember({ name, birthDate, phoneNo }) {
    logger.info(`[Siloam Verification] SILOAM_MOCK raw value: '${process.env.SILOAM_MOCK}' (length: ${process.env.SILOAM_MOCK ? process.env.SILOAM_MOCK.length : 0})`);
    if (process.env.SILOAM_MOCK?.trim().toLowerCase() === 'true') {
        logger.info(`[Siloam Mock API] Verifying - Name: ${name}, Phone: ${phoneNo}`);
        // 가상 테스트 데이터: 전화번호 뒷자리가 1234이면 합격
        if (phoneNo && phoneNo.endsWith('1234')) {
            return { isValid: true, verifiedAt: new Date().toISOString() };
        }
        return { isValid: false };
    }

    const url = process.env.SILOAM_API_URL;
    const apiKey = process.env.SILOAM_API_KEY;

    if (!url || !apiKey) {
        logger.warn('Siloam API configuration missing. Defaulting to verification fail.');
        return { isValid: false };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5초 타임아웃

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'X-API-Key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, birthDate, phoneNo }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.status === 200) {
            const result = await response.json();
            if (result.status === 'success') {
                return {
                    isValid: result.data?.isValid === true,
                    verifiedAt: result.data?.verifiedAt
                };
            }
        }
        return { isValid: false };
    } catch (error) {
        clearTimeout(timeoutId);
        logger.error('Siloam API HTTP call failed:', error.message);
        return { isValid: false };
    }
}

/**
 * Gemini 비전 멀티모달 API를 통한 복지카드 자격 판독 (Structured Output)
 */
async function verifyCardOCR(imageBuffer, mimeType, userName, birthDate) {
    const geminiApiKey = process.env.GOOGLE_API_KEY;
    if (!geminiApiKey) {
        logger.error('GOOGLE_API_KEY is not defined. OCR verification bypassed.');
        return { isValidCard: false, confidenceScore: 0.0 };
    }

    try {
        const genAI = new GoogleGenerativeAI(geminiApiKey);
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: { 
                responseMimeType: "application/json",
                responseSchema: {
                    type: "object",
                    properties: {
                        isValidCard: { type: "boolean" },
                        nameMatched: { type: "boolean" },
                        birthDateMatched: { type: "boolean" },
                        isVisualImpairment: { type: "boolean" },
                        confidenceScore: { type: "number" }
                    },
                    required: ["isValidCard", "nameMatched", "birthDateMatched", "isVisualImpairment", "confidenceScore"]
                }
            }
        });

        const imagePart = {
            inlineData: {
                data: imageBuffer.toString("base64"),
                mimeType
            }
        };

        const prompt = `
당신은 대한민국 시각장애인등록증(복지카드)을 판독하는 인공지능 보안 시스템입니다.
전송받은 복지카드 이미지를 정밀 분석하여 다음 정보를 JSON 객체로 출력하십시오.

요청 조건:
1. 이름: 성명 영역의 텍스트와 가입 요청자 성명인 "${userName}"이 일치하는지 여부.
2. 생년월일: 주민등록번호 앞자리 또는 생년월일 텍스트가 "${birthDate}"(YYYY-MM-DD 형식, 예: 1990-01-01 -> 900101)와 일치(앞 6자리 일치)하는지 여부.
3. 장애 유형: 반드시 "시각장애"라는 명확한 표기가 카드상에 명시되어 있는지 여부.
4. 신뢰도(confidenceScore): 판독 정밀도 및 신뢰성에 대한 0.0 ~ 1.0 사이의 실수값.
5. 주민등록번호 뒷자리: 어떠한 경우에도 주민등록번호 뒷자리(성별구분 숫자 포함)를 응답 텍스트나 로그에 포함하지 마십시오.

출력 JSON 스키마 규격:
{
  "isValidCard": boolean, // 시각장애인 복지카드가 확실한가? (위 조건 3가지가 모두 일치하고 훼손되지 않은 신분증 이미지인 경우에만 true)
  "nameMatched": boolean,
  "birthDateMatched": boolean,
  "isVisualImpairment": boolean,
  "confidenceScore": number
}
        `;

        const result = await model.generateContent([prompt, imagePart]);
        const responseText = result.response.text();
        return JSON.parse(responseText);
    } catch (error) {
        logger.error('Gemini OCR verification failed:', error.message);
        return {
            isValidCard: false,
            nameMatched: false,
            birthDateMatched: false,
            isVisualImpairment: false,
            confidenceScore: 0.0
        };
    }
}

module.exports = {
    formatTime,
    getYoutubeVideoId,
    preprocessVtt,
    isValidYoutubeUrl,
    hashPassword,
    verifyPassword,
    verifySiloamMember,
    verifyCardOCR
};