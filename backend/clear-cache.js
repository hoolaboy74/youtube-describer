const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

console.log('Starting cache clearing process...');

// Define Paths
const backendDir = __dirname;
const ttsCacheDir = path.join(backendDir, 'public', 'audio', 'tts_cache');
const tempDir = path.join(backendDir, 'temp');
const dbPath = path.join(backendDir, 'db', 'cache.db');
const videoAudioDir = path.join(backendDir, 'public', 'audio');
const framesCacheDir = path.join(backendDir, 'public', 'frames');

// 1. Clear File System Caches
console.log('Clearing file system caches...');
if (fs.existsSync(ttsCacheDir)) {
    fs.rmSync(ttsCacheDir, { recursive: true, force: true });
    console.log('  - Deleted TTS cache directory.');
}
if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('  - Deleted temp directory.');
}
if (fs.existsSync(framesCacheDir)) {
    fs.rmSync(framesCacheDir, { recursive: true, force: true });
    console.log('  - Deleted frames cache directory.');
}
if(fs.existsSync(videoAudioDir)) {
    const videoDirs = fs.readdirSync(videoAudioDir);
    for (const dir of videoDirs) {
        const fullPath = path.join(videoAudioDir, dir);
        if (fs.statSync(fullPath).isDirectory() && dir !== 'tts_cache') {
            fs.rmSync(fullPath, { recursive: true, force: true });
            console.log(`  - Deleted old video cache: ${dir}`);
        }
    }
}
console.log('File system caches cleared.');

// 2. Clear Database Tables
console.log('Clearing database tables...');
try {
    if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath);
        db.exec('DELETE FROM scripts;');
        db.exec('DELETE FROM videos;');
        db.exec('VACUUM;');
        db.close();
        console.log('Database tables cleared and vacuumed.');
    } else {
        console.log('Database file not found, skipping.');
    }
} catch (error) {
    console.error('Error clearing database:', error.message);
}

console.log('Cache clearing process finished successfully!');