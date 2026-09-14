import { createQaLatencyTrace } from './qaLatencyTrace';

function fixture(enabled = true) {
    let clock = 100;
    const env = { performance: { now: () => clock }, sessionStorage: { getItem: () => JSON.stringify({ enabled, fixture: 'scene-1', device: 'iphone', cacheState: 'cold' }) },
        setTimeout: jest.fn(() => 1), clearTimeout: jest.fn() };
    return { env, advance: ms => { clock += ms; }, trace: createQaLatencyTrace({ requestId: 'r1', historyTurns: 50, timestamp: 12 }, env) };
}
test('measures playing, not play; stores no arbitrary text or audio source', () => {
    const { env, advance, trace } = fixture();
    const audio = new EventTarget();
    trace.mark('firstText');
    trace.mark('secret-answer');
    trace.audio(audio, 'mp3');
    advance(20);
    audio.dispatchEvent(new Event('play'));
    expect(env.__qaLatencyRecords).toBeUndefined();
    advance(80);
    audio.dispatchEvent(new Event('playing'));
    audio.dispatchEvent(new Event('playing'));
    expect(env.__qaLatencyRecords).toHaveLength(1);
    expect(env.__qaLatencyRecords[0].timings).toEqual({ firstText: 0, firstPlaying: 100 });
    expect(env.__qaLatencyRecords[0].historyTurns).toBe(50);
});
test('disabled instrumentation is inert', () => {
    const { env, trace } = fixture(false);
    trace.finish('played');
    expect(env.setTimeout).not.toHaveBeenCalled();
    expect(env.__qaLatencyRecords).toBeUndefined();
});
test('autoplay failure detaches late playing and preserves failure', () => {
    const { env, trace } = fixture();
    const audio = new EventTarget();
    trace.audio(audio, 'mp3');
    trace.finish('autoplay-blocked');
    audio.dispatchEvent(new Event('playing'));
    expect(env.__qaLatencyRecords[0].status).toBe('autoplay-blocked');
    expect(env.__qaLatencyRecords[0].timings.firstPlaying).toBeUndefined();
});
test('a replacement request cannot claim old playback for both requests', () => {
    const { env, trace } = fixture();
    const audio = new EventTarget();
    trace.audio(audio, 'ogg');
    const second = createQaLatencyTrace({ requestId: 'r2', historyTurns: 51, timestamp: 14 }, env);
    second.audio(audio, 'mp3');
    audio.dispatchEvent(new Event('playing'));
    expect(env.__qaLatencyRecords.map(r => r.status)).toEqual(['superseded', 'played']);
});
test('unplayed requests time out and first timestamps are immutable', () => {
    const { env, trace, advance } = fixture();
    trace.mark('firstText');
    advance(50);
    trace.mark('firstText');
    env.setTimeout.mock.calls[0][0]();
    expect(env.__qaLatencyRecords[0].status).toBe('timeout');
    expect(env.__qaLatencyRecords[0].timings.firstText).toBe(0);
});
