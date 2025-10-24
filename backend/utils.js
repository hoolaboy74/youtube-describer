function formatTime(seconds) {
    return new Date(seconds * 1000).toISOString().substr(11, 8);
}

function getYoutubeVideoId(url) {
    try {
        const urlObj = new URL(url);
        if (urlObj.hostname === 'youtu.be') return urlObj.pathname.substring(1);
        if (urlObj.hostname.includes('youtube.com')) return urlObj.searchParams.get('v');
    } catch (e) { /* Ignore parsing errors */ }
    return null;
}

// Function to convert VTT timestamps to seconds
function preprocessVtt(vttContent) {
    if (!vttContent) return '';

    // This regex captures HH:MM:SS.mmm format and converts it to seconds
    return vttContent.replace(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g, (match, hh, mm, ss, ms) => {
        const hours = parseInt(hh, 10);
        const minutes = parseInt(mm, 10);
        const seconds = parseInt(ss, 10);
        const milliseconds = parseInt(ms, 10);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
        return `(${totalSeconds.toFixed(1)}s)`; // Returns (123.5s) format
    });
}


module.exports = { formatTime, getYoutubeVideoId, preprocessVtt };