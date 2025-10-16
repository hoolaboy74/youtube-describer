const logger = require('./logger');

const getYoutubeVideoId = (url) => {
    try {
        const urlObj = new URL(url);
        if (urlObj.hostname === 'youtu.be') {
            return urlObj.pathname.slice(1);
        }
        if (urlObj.hostname.includes('youtube.com')) {
            return urlObj.searchParams.get('v');
        }
        return null;
    } catch (e) {
        logger.error('Invalid URL for video ID extraction:', url);
        return null;
    }
};

const invertSpeechTimestamps = (speechTimestamps, totalDuration) => {
    const nonSpeechIntervals = [];
    let lastEndTime = 0;

    speechTimestamps.forEach(segment => {
        const start = segment.start / 1000;
        const end = segment.end / 1000;
        if (start > lastEndTime + 0.5) { // Minimum silence gap of 0.5s
            nonSpeechIntervals.push({ start: lastEndTime, end: start });
        }
        lastEndTime = end;
    });

    if (totalDuration > lastEndTime) {
        nonSpeechIntervals.push({ start: lastEndTime, end: totalDuration });
    }
    return nonSpeechIntervals;
};

const formatTime = (seconds) => {
    return new Date(seconds * 1000).toISOString().substr(11, 8);
};

module.exports = {
    getYoutubeVideoId,
    invertSpeechTimestamps,
    formatTime,
};
