const fs = require('fs');
const path = require('path');

async function describeSegment(genAI, analysis, videoTitle, frames, subtitles, langCode) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    const promptPath = path.join(__dirname, '../prompts/stage2_describer.txt');
    let prompt = fs.readFileSync(promptPath, 'utf-8');
    
    // Inject Analysis Context
    const analysisJson = JSON.stringify(analysis, null, 2);
    prompt = prompt.replace('{{ANALYSIS_JSON}}', analysisJson);
    
    // Inject Subtitles and Language
    prompt = prompt.replace('{{SUBTITLES}}', subtitles.substring(0, 30000)); // Limit subtitle context if too long
    prompt = prompt.replace('{{SUBTITLE_LANGUAGE}}', langCode || 'unknown');

    const imageParts = [];
    for (const frame of frames) {
        if (fs.existsSync(frame.path)) {
            imageParts.push({
                inlineData: {
                    data: fs.readFileSync(frame.path).toString("base64"),
                    mimeType: 'image/jpeg'
                }
            });
            imageParts.push({ text: `[Time: ${Math.round(frame.timestamp)}s]` });
        }
    }

    console.log(`[Describer] Generating draft description with ${imageParts.length / 2} frames. Subtitle Lang: ${langCode}...`);

    try {
        const result = await model.generateContentStream([prompt, ...imageParts]);
        
        // Handling Stream
        let fullText = '';
        process.stdout.write('[Describer] Stream: ');
        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            process.stdout.write('.');
            fullText += chunkText;
        }
        console.log(' Done.');
        return fullText;

    } catch (e) {
        console.error("[Describer] Failed to generate description:", e.message);
        throw e;
    }
}

module.exports = { describeSegment };