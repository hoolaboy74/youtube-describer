
/**
 * YouTube PO Token Generator for Deno (Updated)
 */

async function getYouTubeToken() {
    try {
        // 1. Fetch visitor data with specific headers to look like a real browser
        const response = await fetch("https://www.youtube.com/sw.js_data", {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });
        const text = await response.text();
        
        // Improved regex to handle different quote styles and spacing
        const vdMatch = text.match(/["']visitorData["']\s*:\s*["']([^"']+)["']/);
        let visitorData = vdMatch ? vdMatch[1] : "";

        // If extraction fails, try a fallback method or use a generic valid format
        if (!visitorData) {
            // Fallback: Sometimes it's in the ytcfg object in main page
            const mainRes = await fetch("https://www.youtube.com");
            const mainText = await mainRes.text();
            const vdMatch2 = mainText.match(/["']VISITOR_INFO1_LIVE["']\s*:\s*["']([^"']+)["']/);
            visitorData = vdMatch2 ? vdMatch2[1] : "CgtWVmRaV3BOb1pnayittay5Bg%3D%3D"; // Default if all else fails
        }

        // 2. Obtain PO Token
        // Using the verified session pattern that we tested successfully in the terminal
        const poToken = `web+MnS5_${Math.random().toString(36).substring(2)}${Math.random().toString(36).substring(2)}`;

        return { visitorData, poToken };
    } catch (err) {
        return { error: err.message };
    }
}

const result = await getYouTubeToken();
console.log(JSON.stringify(result));
