'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function disposableDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-describer-canonical-'));
  return {
    directory,
    path: path.join(directory, 'cache.db')
  };
}

function runDatabaseScript(databasePath, source) {
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: __dirname,
    env: { ...process.env, YOUTUBE_DESCRIBER_DB_PATH: databasePath },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const marker = '__RESULT__';
  const line = result.stdout.trim().split('\n').reverse().find(value => value.startsWith(marker));
  assert.ok(line, `missing result marker in output: ${result.stdout}`);
  return JSON.parse(line.slice(marker.length));
}

test('canonical persistence migrates schema, stores accepted events, and quarantines the rest', () => {
  const database = disposableDatabase();
  try {
    const result = runDatabaseScript(database.path, `
      const Database = require('better-sqlite3');
      const db = require('./database');
      const { validateCandidate } = require('./modules/canonicalOutput');
      db.init();
      db.ensurePreliminaryRecord('video-1');
      const accepted = validateCandidate({
        timestamp: 12,
        tag: 'v2',
        text: '한 사람이 문 옆에 서 있습니다.',
        provenance: { kind: 'visual', frameEvidence: [{ id: 'frame-12', timestamp: 12 }] }
      }, { duration: 120, audioLanguage: 'korean' });
      const quarantined = validateCandidate({
        timestamp: 12,
        tag: 'v2',
        text: '대화 중인 장면입니다.',
        provenance: { kind: 'visual', frameEvidence: [{ id: 'frame-12b', timestamp: 12 }] }
      }, {
        duration: 120,
        audioLanguage: 'korean',
        dialogueTrack: [{ start: 10, end: 15, sourceLanguage: 'ko', sourceText: '안녕하세요', confirmed: true }]
      });
      const rejected = validateCandidate({
        timestamp: 20,
        tag: 'bad',
        text: '허용되지 않은 태그입니다.',
        provenance: { kind: 'visual', frameEvidence: [{ id: 'frame-20', timestamp: 20 }] }
      }, { duration: 120, audioLanguage: 'korean' });
      db.saveCanonicalScriptChunk({ videoId: 'video-1', events: [accepted, quarantined, rejected, accepted] });
      db.saveQuarantinedScriptEvents({ videoId: 'video-1', candidates: [quarantined, rejected] });
      const readDb = new Database(process.env.YOUTUBE_DESCRIBER_DB_PATH, { readonly: true });
      const columns = readDb.prepare('PRAGMA table_info(scripts)').all().map(row => row.name);
      const quarantineTable = readDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'script_quarantine'").get();
      const stored = readDb.prepare('SELECT id, tag, validation_status, tts_eligible, policy_version FROM scripts WHERE videoId = ?').all('video-1');
      const quarantine = readDb.prepare('SELECT reason_code FROM script_quarantine WHERE videoId = ? ORDER BY reason_code').all('video-1');
      console.log('__RESULT__' + JSON.stringify({
        columns,
        hasQuarantineTable: Boolean(quarantineTable),
        stored,
        quarantine,
        video: db.getVideo('video-1')
      }));
      readDb.close();
    `);

    assert.ok(result.columns.includes('tag'));
    assert.ok(result.columns.includes('provenance_json'));
    assert.ok(result.columns.includes('validation_status'));
    assert.ok(result.columns.includes('validation_reasons_json'));
    assert.ok(result.columns.includes('tts_eligible'));
    assert.ok(result.columns.includes('policy_version'));
    assert.equal(result.hasQuarantineTable, true);
    assert.equal(result.stored.length, 1);
    assert.equal(result.stored[0].tag, 'v2');
    assert.equal(result.stored[0].validation_status, 'accepted');
    assert.equal(result.stored[0].tts_eligible, 1);
    assert.equal(result.stored[0].policy_version, 'codex-v2');
    assert.deepEqual(result.quarantine.map(row => row.reason_code), ['DIALOGUE_OVERLAP', 'UNSUPPORTED_TAG']);
    assert.deepEqual(result.video.script[0], {
      id: result.stored[0].id,
      timestamp: 12,
      text: '한 사람이 문 옆에 서 있습니다.',
      verbosity: 'v2',
      tag: 'v2',
      provenance: { kind: 'visual', frameEvidence: [{ id: 'frame-12', timestamp: 12 }] },
      validationStatus: 'accepted',
      validationReasons: [],
      ttsEligible: true,
      policyVersion: 'codex-v2'
    });
  } finally {
    fs.rmSync(database.directory, { recursive: true, force: true });
  }
});

test('existing legacy scripts gain additive canonical columns without data loss', () => {
  const database = disposableDatabase();
  try {
    const result = runDatabaseScript(database.path, `
      const Database = require('better-sqlite3');
      const legacy = new Database(process.env.YOUTUBE_DESCRIBER_DB_PATH);
      legacy.exec(\`CREATE TABLE videos (videoId TEXT PRIMARY KEY, title TEXT NOT NULL, duration INTEGER DEFAULT 0, filesize INTEGER DEFAULT 0, status TEXT DEFAULT 'completed' NOT NULL, audio_language TEXT);\`);
      legacy.exec(\`CREATE TABLE scripts (id TEXT PRIMARY KEY, videoId TEXT NOT NULL, timestamp INTEGER NOT NULL, text TEXT NOT NULL, verbosity TEXT NOT NULL);\`);
      legacy.prepare('INSERT INTO videos (videoId, title) VALUES (?, ?)').run('legacy-video', 'Legacy');
      legacy.prepare('INSERT INTO scripts (id, videoId, timestamp, text, verbosity) VALUES (?, ?, ?, ?, ?)').run('legacy-event', 'legacy-video', 3, '기존 대본', 'v1');
      legacy.close();
      const db = require('./database');
      db.init();
      const migrated = new Database(process.env.YOUTUBE_DESCRIBER_DB_PATH, { readonly: true });
      console.log('__RESULT__' + JSON.stringify({
        event: migrated.prepare('SELECT id, text, validation_status, tts_eligible FROM scripts').get(),
        columns: migrated.prepare('PRAGMA table_info(scripts)').all().map(row => row.name)
      }));
      migrated.close();
    `);
    assert.deepEqual(result.event, {
      id: 'legacy-event',
      text: '기존 대본',
      validation_status: 'accepted',
      tts_eligible: 1
    });
    assert.ok(result.columns.includes('script_quarantine') === false);
    assert.ok(result.columns.includes('tag'));
  } finally {
    fs.rmSync(database.directory, { recursive: true, force: true });
  }
});

test('interactive-style and batch-style canonical publication have identical accepted output', () => {
  const database = disposableDatabase();
  try {
    const result = runDatabaseScript(database.path, `
      process.env.GOOGLE_API_KEY = 'test-key';
      const Database = require('better-sqlite3');
      const db = require('./database');
      const { canonicalizeModelOutput, publishCanonicalOutput } = require('./videoProcessor');
      db.init();
      db.ensurePreliminaryRecord('parity-video');
      const raw = [
        '[12][v2] 한 사람이 문 옆에 서 있습니다.',
        '[14][v2] 한 사람이 문 옆에 서 있습니다.',
        '[20][trans] 문을 열어 주세요.',
        '[22][txt] 안녕하세요.',
        '[99][v1] 영상 밖의 문장입니다.'
      ].join('\\n');
      const context = {
        duration: 30,
        audioLanguage: 'foreign',
        frameEvidence: [{ id: 'frame-12', timestamp: 12 }, { id: 'frame-14', timestamp: 14 }, { id: 'frame-22', timestamp: 22 }],
        dialogueTrack: [
          { start: 20, end: 24, sourceLanguage: 'en', sourceText: 'Please open the door.', confirmed: true, foreign: true },
          { start: 22, end: 25, sourceLanguage: 'ko', sourceText: '안녕하세요.', confirmed: true, foreign: true }
        ]
      };
      const interactive = canonicalizeModelOutput(raw, context);
      const batch = canonicalizeModelOutput(raw, context);
      publishCanonicalOutput({
        videoId: 'parity-video',
        canonical: interactive,
        sseHandler: (name, payload) => console.log('__SSE__' + JSON.stringify({ name, payload })),
        requestHash: 'test'
      });
      const readDb = new Database(process.env.YOUTUBE_DESCRIBER_DB_PATH, { readonly: true });
      console.log('__RESULT__' + JSON.stringify({
        same: JSON.stringify(interactive) === JSON.stringify(batch),
        acceptedIds: interactive.accepted.map(event => event.id),
        acceptedLegacy: interactive.accepted.map(event => ({ id: event.id, timestamp: event.timestamp, text: event.text, verbosity: event.legacyVerbosity })),
        stored: readDb.prepare('SELECT id, validation_status FROM scripts WHERE videoId = ? ORDER BY timestamp').all('parity-video'),
        quarantine: readDb.prepare('SELECT reason_code FROM script_quarantine WHERE videoId = ? ORDER BY reason_code').all('parity-video'),
        status: db.getVideo('parity-video').status
      }));
      readDb.close();
    `);
    assert.equal(result.same, true);
    assert.equal(result.acceptedIds.length, 2);
    assert.deepEqual(result.stored, result.acceptedIds.map(id => ({ id, validation_status: 'accepted' })));
    assert.deepEqual(result.acceptedLegacy.map(event => event.verbosity), ['v2', 'translation']);
    assert.ok(result.quarantine.some(row => row.reason_code === 'DUPLICATE_EVENT'));
    assert.ok(result.quarantine.some(row => row.reason_code === 'DIALOGUE_DUPLICATE'));
    assert.ok(result.quarantine.some(row => row.reason_code === 'TIMESTAMP_OUT_OF_RANGE'));
    assert.equal(result.status, 'completed');
  } finally {
    fs.rmSync(database.directory, { recursive: true, force: true });
  }
});
