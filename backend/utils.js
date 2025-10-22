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



const formatTime = (seconds) => {
    return new Date(seconds * 1000).toISOString().substr(11, 8);
};

module.exports = {
    getYoutubeVideoId,
    formatTime,
};
