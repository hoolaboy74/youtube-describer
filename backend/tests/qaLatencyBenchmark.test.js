const assert = require('node:assert/strict');
const test = require('node:test');
const { ptsFromShowinfo, coverageHoles, summarize } = require('../../test_scripts/qa_latency_benchmark');
const sample = (id, status, timings = {}) => ({ schemaVersion: 1, requestId: id, status, timings,
    implementation: 'legacy', fixture: 'test', cacheState: 'cold', device: 'iphone', run: 'before',
    audioMode: 'mp3', historyTurns: 1, timestamp: 12 });

test('failed and autoplay-blocked samples remain in denominator; no fake zero latency', () => {
    const [group] = summarize([sample('1', 'played', { firstPlaying: 2500 }), sample('2', 'autoplay-blocked'), sample('3', 'timeout')]);
    assert.equal(group.samples, 3);
    assert.equal(group.unplayedSamples, 2);
    assert.deepEqual(group.firstPlayingMs, { p50: 2500, p95: 2500 });
    assert.deepEqual(summarize([sample('4', 'timeout')])[0].firstPlayingMs, { p50: null, p95: null });
});
test('text receipt never substitutes for real playback and dimensions stay separate', () => {
    const groups = summarize([sample('1', 'timeout', { firstText: 20 }), { ...sample('2', 'played', { firstPlaying: 0 }), cacheState: 'warm' }]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].playedSamples, 0);
    assert.equal(groups[1].firstPlayingMs.p50, 0);
});
test('rejects malformed timing and duplicated attempts', () => {
    assert.throws(() => summarize([sample('1', 'played')]));
    assert.throws(() => summarize([sample('1', 'played', { firstPlaying: -1 })]));
    assert.throws(() => summarize([sample('1', 'timeout'), sample('1', 'timeout')]));
});
test('extracts actual showinfo PTS with offsets, not frame indices', () => {
    const log = '[showinfo] n:   0 pts:  7000 pts_time:7 pos: 0\n[showinfo] n:   1 pts: 15000 pts_time:15 pos: 40\n';
    assert.deepEqual(ptsFromShowinfo(log), [7, 15]);
    assert.deepEqual(coverageHoles([7, 15], 7, 10), [9, 11, 13]);
});

const { createRecordParser } = require('../../test_scripts/qa_provider_probe');
test('probe parser releases only complete JSON records with newline boundaries', () => {
    const accepted = [];
    const parser = createRecordParser(r => accepted.push(r));
    const first = { seq: 0, text: '시험 문장입니다.', kind: 'explanation', evidenceIds: [] };
    const wire = JSON.stringify(first);
    for (const char of wire) parser.push(char);
    assert.equal(accepted.length, 0);
    parser.push('\n{"seq":1');
    assert.deepEqual(accepted, [first]);
    assert.deepEqual(parser.end(), { count: 1, unfinishedTail: true });
});
test('probe parser rejects malformed or oversized records', () => {
    assert.throws(() => createRecordParser(() => {}).push('not-json\n'));
    assert.throws(() => createRecordParser(() => {}).push('x'.repeat(16385)));
});
