import { act, renderHook, waitFor } from '@testing-library/react';
import { useQaConversation } from './useQaConversation';
import { createQaClient } from '../services/qaClient';
import { createQaAudioController, chooseQaAudioMode } from '../services/qaAudioController';
jest.mock('../services/qaClient');
jest.mock('../services/qaAudioController');
let client, callbacks, audio, events, submitted;
beforeEach(() => {
    let sequence = 0; Object.defineProperty(window, 'crypto', { configurable: true, value: { randomUUID: () => `request-${++sequence}` } }); events = undefined;
    chooseQaAudioMode.mockReturnValue('mp3');
    audio = { setPlaybackRate: jest.fn(), prepare: jest.fn(), cancel: jest.fn(), enqueue: jest.fn(), complete: jest.fn(), resume: jest.fn() };
    createQaAudioController.mockImplementation(options => { callbacks = options; return audio; });
    client = { config: jest.fn(async () => ({ incrementalSpeech: true })), presence: jest.fn(async () => {}), cancel: jest.fn(async () => {}),
        submit: jest.fn(async payload => { submitted = payload; return { eventsPath: '/events' }; }),
        events: jest.fn(async (path, options) => { events = options; await new Promise(() => {}); }) };
    createQaClient.mockReturnValue(client);
});
test('preserves canceled partial history and ignores callbacks after close', async () => {
    const announceError = jest.fn(); const { result, unmount } = renderHook(() => useQaConversation({ apiBase: '', token: 'token', videoId: 'abcdefghijk', announceError }));
    await waitFor(() => expect(result.current.enabled).toBe(true));
    act(() => { result.current.ask({ question: '첫 질문', timestamp: 50, playbackRate: 1.2 }); });
    await waitFor(() => expect(events).toBeDefined());
    act(() => events.onEvent({ type: 'sentence', data: { seq: 0, text: '부분 답변입니다.' } }));
    const oldEvents = events, oldCallbacks = callbacks;
    act(() => result.current.cancel());
    act(() => { oldEvents.onEvent({ type: 'sentence', data: { seq: 1, text: '늦은 답변입니다.' } }); oldCallbacks.onError('late'); });
    expect(result.current.turns[0].answer).toBe('부분 답변입니다.'); expect(result.current.turns[0].status).toBe('canceled'); expect(announceError).not.toHaveBeenCalled();
    act(() => { result.current.ask({ question: '뒤로 이동한 질문', timestamp: 12, playbackRate: 1.2 }); });
    await waitFor(() => expect(client.submit).toHaveBeenCalledTimes(2));
    expect(submitted.history).toEqual([{ requestId: result.current.turns[0].id, question: '첫 질문', timestamp: 50, answer: '부분 답변입니다.', status: 'canceled' }]);
    unmount(); expect(audio.cancel).toHaveBeenCalled();
});
test('does not announce normal sentence or generation progress and waits for audio ended', async () => {
    const announceError = jest.fn(); const { result } = renderHook(() => useQaConversation({ apiBase: '', token: 'token', videoId: 'abcdefghijk', announceError }));
    await waitFor(() => expect(result.current.enabled).toBe(true));
    act(() => { result.current.ask({ question: '질문', timestamp: 12 }); result.current.ask({ question: '중복', timestamp: 12 }); });
    await waitFor(() => expect(events).toBeDefined()); expect(client.submit).toHaveBeenCalledTimes(1);
    act(() => { events.onEvent({ type: 'sentence', data: { seq: 0, text: '답변입니다.' } }); events.onEvent({ type: 'generation_done', data: {} }); events.onEvent({ type: 'audio_done', data: {} }); });
    expect(result.current.busy).toBe(true); expect(announceError).not.toHaveBeenCalled();
    act(() => callbacks.onDone()); expect(result.current.busy).toBe(false);
});

test('uses the player rate for initial speech, live changes and replay without resetting history', async () => {
    client.audioTicket = jest.fn(async () => ({ path: '/audio' }));
    const { result, rerender } = renderHook(({ playbackRate }) => useQaConversation({ apiBase: '', token: 'token', videoId: 'abcdefghijk', announceError: jest.fn(), playbackRate }), { initialProps: { playbackRate: 1.5 } });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    act(() => { result.current.ask({ question: '질문', timestamp: 12 }); });
    await waitFor(() => expect(events).toBeDefined()); expect(audio.prepare).toHaveBeenLastCalledWith(1.5);
    act(() => { events.onEvent({ type: 'sentence', data: { seq: 0, text: '답변입니다.' } }); });
    rerender({ playbackRate: 2.5 }); expect(audio.setPlaybackRate).toHaveBeenLastCalledWith(2.5);
    expect(result.current.turns[0].answer).toBe('답변입니다.'); expect(client.cancel).not.toHaveBeenCalled();
    await act(async () => { await result.current.replay(result.current.turns[0].id); });
    expect(audio.prepare).toHaveBeenLastCalledWith(2.5); expect(client.audioTicket).toHaveBeenCalledTimes(1);
});
test('validation failures announce a response-validation problem once without claiming missing video evidence', async () => {
    const announceError = jest.fn();
    client.events.mockImplementation(async (path, options) => options.onEvent({ type: 'error', data: { code: 'QA_ANSWER_FORMAT_INVALID' } }));
    const { result } = renderHook(() => useQaConversation({ apiBase: '', token: 'token', videoId: 'abcdefghijk', announceError }));
    await waitFor(() => expect(result.current.enabled).toBe(true));
    await act(async () => { await result.current.ask({ question: '현재 화면을 설명해 주세요.', timestamp: 23.479 }); });
    expect(announceError).toHaveBeenCalledTimes(1); expect(announceError).toHaveBeenCalledWith('답변 형식을 읽지 못했습니다. 다시 질문해 주세요.');
    expect(result.current.turns[0].answer).toBe(''); expect(result.current.turns[0].status).toBe('failed');
});
test('search sources arriving after speech do not replace or truncate the model answer', async () => {
    const { result } = renderHook(() => useQaConversation({ apiBase: '', token: 'token', videoId: 'abcdefghijk', announceError: jest.fn() }));
    await waitFor(() => expect(result.current.enabled).toBe(true));
    act(() => { result.current.ask({ question: '학력을 검색해', timestamp: 12 }); });
    await waitFor(() => expect(events).toBeDefined());
    const text = '학력: 학교 이름, 학부 이름'; const sources = [{ url: 'https://example.com/profile', title: '프로필' }];
    act(() => { events.onEvent({ type: 'sentence', data: { seq: 0, text } }); events.onEvent({ type: 'generation_done', data: { sources } }); });
    expect(result.current.turns[0].answer).toBe(text); expect(result.current.turns[0].sources).toEqual(sources);
});
