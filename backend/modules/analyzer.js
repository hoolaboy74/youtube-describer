const fs = require('fs');
const path = require('path');

async function analyzeVideo(genAI, videoTitle, sampleFrames) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    const promptPath = path.join(__dirname, '../prompts/stage1_analyzer.txt');
    let prompt = fs.readFileSync(promptPath, 'utf-8');
    
    prompt = prompt.replace('{{VIDEO_TITLE}}', videoTitle);

    // Prepare Image Parts (Limit to 20 frames for analysis to save tokens)
    const imageParts = [];
    const step = Math.max(1, Math.floor(sampleFrames.length / 20));
    
    for (let i = 0; i < sampleFrames.length; i += step) {
        const frame = sampleFrames[i];
        if (fs.existsSync(frame.path)) {
             imageParts.push({
                inlineData: {
                    data: fs.readFileSync(frame.path).toString("base64"),
                    mimeType: 'image/jpeg'
                }
            });
        }
    }

    console.log(`[Analyzer] Analyzing video style with ${imageParts.length} sample frames...`);

    try {
        const result = await model.generateContent([prompt, ...imageParts]);
        const responseText = result.response.text();
        
        // Clean JSON formatting (remove markdown code blocks if present)
        const jsonStr = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const analysis = JSON.parse(jsonStr);
        
        console.log(`[Analyzer] Genre detected: ${analysis.genre}`);
        return analysis;
    } catch (e) {
        console.error("[Analyzer] Failed to analyze video:", e.message);
        // Fallback default
        return {
            genre: "General",
            visual_style: "Standard",
            key_characters: [],
            atmosphere: "Neutral",
            narration_strategy: "Describe clearly"
        };
    }
}

module.exports = { analyzeVideo };
