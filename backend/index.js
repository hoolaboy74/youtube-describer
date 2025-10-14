require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const apiRoutes = require('./routes');

// Initialize the database
db.init();

const app = express();
const port = 4000;

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
    console.log('Running cleanup of old audio files...');
    try {
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
                        console.log(`Deleting old TTS cache file: ${filePath}`);
                        await fs.promises.rm(filePath, { force: true });
                    }
                }
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') { // Ignore error if a directory doesn't exist
            console.error('Error during old file cleanup:', error);
        }
    }
}

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
// Serve static audio files from the nested TTS cache directory
app.use('/audio/tts_cache', express.static(ttsCacheDir));

// --- API ROUTES ---
app.use('/api', apiRoutes);

// --- SERVER START ---
app.listen(port, () => {
    console.log(`Backend server listening on http://localhost:${port}`);
    // Run cleanup on startup, then periodically
    cleanupOldFiles();
    setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000);
});