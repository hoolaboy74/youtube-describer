const assert = require('node:assert/strict');
const test = require('node:test');

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const routes = require('../routes');

test('Q&A stream releases only completed sentence text and retains an unfinished tail', () => {
    const result = routes.takeCompletedQaSentences('첫 문장입니다. 다음 문장은 아직 끝나지 않았습니다');
    assert.equal(result.completed, '첫 문장입니다. ');
    assert.equal(result.remaining, '다음 문장은 아직 끝나지 않았습니다');
});

test('Q&A stream uses the same plain-text cleanup as the completed answer', () => {
    const answer = routes.cleanQaAnswer('**[안내](https://example.test)** [1] 화면에 표지판이 보입니다.');
    assert.equal(answer, '안내 화면에 표지판이 보입니다.');
});

test('Q&A stream events use a complete SSE event frame', () => {
    let written = '';
    routes.writeQaStreamEvent({
        writableEnded: false,
        write(value) { written += value; }
    }, 'delta', { text: '화면에 문이 보입니다.' });

    assert.equal(written, 'event: delta\ndata: {"text":"화면에 문이 보입니다."}\n\n');
});
