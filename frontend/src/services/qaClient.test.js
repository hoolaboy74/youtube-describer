import { TextDecoder, TextEncoder } from 'util';
import { createQaClient } from './qaClient';
function response(text) {
    const bytes = new TextEncoder().encode(text); let index = 0;
    return { ok: true, body: { getReader: () => ({ read: async () => index < bytes.length ? { value: bytes.slice(index, ++index), done: false } : { done: true }, cancel: async () => {}, releaseLock() {} }) } };
}
beforeAll(() => { global.TextDecoder = TextDecoder; });
test('reconnect sends its cursor, handles split UTF-8 and does not repeat prior events', async () => {
    const first = 'id: 1\nevent: sentence\ndata: {"seq":0,"text":"첫 문장입니다."}\n\n';
    const second = 'id: 2\nevent: audio_done\ndata: {}\n\n';
    const fetchImpl = jest.fn().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(first + second)); const seen = [];
    await createQaClient({ apiBase: '', token: 'owner', fetchImpl }).events('/events', { signal: new AbortController().signal, onEvent: e => seen.push(e) });
    expect(seen.map(e => e.id)).toEqual([1, 2]); expect(seen[0].data.text).toBe('첫 문장입니다.'); expect(fetchImpl.mock.calls[1][1].headers['Last-Event-ID']).toBe('1');
});
test('a server terminal error does not cause replay or a new submission', async () => {
    const fetchImpl = jest.fn(async () => response('id: 1\nevent: error\ndata: {"code":"QA_TTS_FAILED"}\n\n'));
    await expect(createQaClient({ apiBase: '', token: 'owner', fetchImpl }).events('/events', { signal: new AbortController().signal, onEvent: () => { throw new Error('terminal'); } })).rejects.toThrow('terminal');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
});
