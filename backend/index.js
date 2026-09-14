require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const apiRoutes = require('./routes');
const logger = require('./logger');
const checkDiskSpace = require('check-disk-space').default;
const { spawn } = require('child_process');
const utils = require('./utils');

// Initialize the database
db.init();

const app = express();
app.set('trust proxy', true);
const port = process.env.PORT || 4000;

// --- DIRECTORY SETUP ---
const publicDir = path.join(__dirname, 'public');
const audioCacheDir = path.join(publicDir, 'audio');
const ttsCacheDir = path.join(audioCacheDir, 'tts_cache');

// Ensure directories exist
(async () => {
    await fs.promises.mkdir(ttsCacheDir, { recursive: true });
})();

// --- CLEANUP LOGIC ---
const CACHE_MAX_AGE_DAYS = 30;

async function cleanupOldFiles() {
    logger.info('Checking disk usage before cleaning old audio files...');
    try {
        const diskSpace = await checkDiskSpace(__dirname); // Check disk space of the current partition
        const usagePercent = ((diskSpace.size - diskSpace.free) / diskSpace.size) * 100;

        logger.info(`Current disk usage: ${usagePercent.toFixed(2)}%`);

        if (usagePercent < 70) {
            logger.info(`Disk usage is below the 70% threshold. Skipping cleanup.`);
            return;
        }

        logger.info('Disk usage is above 70%. Proceeding with cleanup of old audio files...');
        
        // This targets the nested directories inside tts_cache
        const firstLevelDirs = await fs.promises.readdir(ttsCacheDir);
        for (const dir1 of firstLevelDirs) {
            const dir1Path = path.join(ttsCacheDir, dir1);
            const secondLevelDirs = await fs.promises.readdir(dir1Path);
            for (const dir2 of secondLevelDirs) {
                const dir2Path = path.join(dir1Path, dir2);
                const files = await fs.promises.readdir(dir2Path);
                for (const file of files) {
                    const filePath = path.join(dir2Path, file);
                    const stats = await fs.promises.stat(filePath);
                    const ageInDays = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
                    if (ageInDays > CACHE_MAX_AGE_DAYS) {
                        logger.info(`Deleting old TTS cache file: ${filePath}`);
                        await fs.promises.rm(filePath, { force: true });
                    }
                }
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') { // Ignore error if a directory doesn't exist
            logger.error('Error during old file cleanup:', error);
        }
    }
}

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Serve static audio files from the nested TTS cache directory
app.use('/audio/tts_cache', express.static(ttsCacheDir));

// --- API ROUTES ---
app.use('/api', apiRoutes);

// --- SERVER START ---
const checkImpersonateSupport = () => {
    return new Promise((resolve) => {
        const testProcess = spawn('yt-dlp', ['--list-impersonate-targets']);
        let stdout = '';
        let stderr = '';
        testProcess.stdout.on('data', (data) => { stdout += data.toString(); });
        testProcess.stderr.on('data', (data) => { stderr += data.toString(); });
        
        testProcess.on('close', (code) => {
            let available = false;
            if (code === 0) {
                const lines = stdout.split('\n');
                const safariLine = lines.find(line => line.includes('Safari'));
                if (safariLine && !safariLine.includes('unavailable')) {
                    available = true;
                }
            }
            logger.info(`[System] Checked yt-dlp impersonation support: ${available ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
            utils.setIsImpersonateAvailable(available);
            resolve(available);
        });
        testProcess.on('error', () => {
            logger.info(`[System] Checked yt-dlp impersonation support: NOT AVAILABLE (Failed to spawn)`);
            utils.setIsImpersonateAvailable(false);
            resolve(false);
        });
    });
};

(async () => {
    await checkImpersonateSupport();
    app.listen(port, () => {
        logger.info(`Backend server listening on http://localhost:${port}`);
        // Run cleanup on startup, then periodically
        cleanupOldFiles();
        setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000);
    });
})();