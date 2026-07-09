const fs = require('fs');
const path = require('path');

async function synchronizeScript(genAI, rawDraft, originalSubtitles) {
    // Stage 3 uses text-only processing, so it's much cheaper.
    // We can use Gemini 1.5 Flash for speed and cost, or Pro for precision.
    // Let's use Pro for better JSON adherence.
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview", generationConfig: { responseMimeType: "application/json" } });
    
    const promptPath = path.join(__dirname, '../prompts/stage3_synchronizer.txt');
    let prompt = fs.readFileSync(promptPath, 'utf-8');
    
    prompt = prompt.replace('{{RAW_DRAFT}}', rawDraft);
    // Limit subtitles to avoid token overflow if necessary, but usually text fits well.
    prompt = prompt.replace('{{ORIGINAL_SUBTITLES}}', originalSubtitles);

    console.log(`[Synchronizer] syncing script with original subtitles...`);

    try {
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        // Ensure it's valid JSON
        let finalJson = [];
        try {
            finalJson = JSON.parse(responseText);
        } catch (parseError) {
            // Try to extract JSON from markdown block
            const match = responseText.match(/```json([\s\S]*?)```/);
            if (match) {
                finalJson = JSON.parse(match[1]);
            } else {
                 throw new Error("Failed to parse JSON response");
            }
        }

        console.log(`[Synchronizer] Synchronization complete. ${finalJson.length} items produced.`);
        return finalJson;
    } catch (e) {
        console.error("[Synchronizer] Failed to synchronize:", e.message);
        throw e;
    }
}

module.exports = { synchronizeScript };
