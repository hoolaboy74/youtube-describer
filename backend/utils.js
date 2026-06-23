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

// Function to convert VTT timestamps to seconds and cleanup content
function preprocessVtt(vttContent) {
    if (!vttContent) return '';

    return vttContent
        .replace(/WEBVTT\n/g, '') // Remove header
        .replace(/Kind:.*\n/g, '') // Remove Kind metadata
        .replace(/Language:.*\n/g, '') // Remove Language metadata
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})/g, (match, hh, mm, ss, ms, hh2, mm2, ss2, ms2) => {
            const toSec = (h, m, s, msec) => parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(msec, 10) / 1000;
            return `(${toSec(hh, mm, ss, ms).toFixed(1)}s) --> (${toSec(hh2, mm2, ss2, ms2).toFixed(1)}s)`;
        })
        .replace(/\n{2,}/g, '\n') // Remove multiple newlines
        .trim();
}


let isImpersonateAvailable = false;

function setIsImpersonateAvailable(val) {
    isImpersonateAvailable = !!val;
}

function getIsImpersonateAvailable() {
    return isImpersonateAvailable;
}

const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(watch\?v=|embed\/|v\/|live\/|shorts\/|)([\w-]+)([?&].*)?$/;function isValidYoutubeUrl(url) {
    return YOUTUBE_URL_REGEX.test(url);
}

module.exports = { formatTime, getYoutubeVideoId, preprocessVtt, isValidYoutubeUrl, setIsImpersonateAvailable, getIsImpersonateAvailable };