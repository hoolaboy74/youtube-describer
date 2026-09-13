import { createQaAudioController } from './qaAudioController';
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup(fetchImpl = jest.fn(async () => ({ ok: true, blob: async () => new Blob(['audio']) }))) {
    const audio = { play: jest.fn(() => Promise.resolve()), pause: jest.fn(), removeAttribute: jest.fn(), load: jest.fn() };
    const onPlaying = jest.fn(), onDone = jest.fn(), onError = jest.fn();
    return { audio, fetchImpl, onPlaying, onDone, onError, controller: createQaAudioController({ audio, fetchImpl, onPlaying, onDone, onError }) };
}
beforeEach(() => { URL.createObjectURL = jest.fn(() => 'blob:fixture'); URL.revokeObjectURL = jest.fn(); });
test('plays the first sentence before generation ends and skips duplicate sequences', async () => {
    const { controller, audio, fetchImpl, onDone, onPlaying } = setup(); controller.prepare(1.2);
    controller.enqueue(0, '/first'); controller.enqueue(0, '/duplicate'); await flush();
    expect(audio.src).toBe('blob:fixture'); expect(fetchImpl).toHaveBeenCalledTimes(1); expect(onPlaying).not.toHaveBeenCalled();
    audio.onplaying(); expect(onPlaying).toHaveBeenCalledWith(0); expect(onDone).not.toHaveBeenCalled();
    controller.enqueue(1, '/second'); controller.complete(); audio.onended(); await flush(); expect(fetchImpl).toHaveBeenCalledTimes(2);
    audio.onended(); expect(onDone).toHaveBeenCalledTimes(1); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});
test('cancel invalidates a pending download and late playing/ended callbacks', async () => {
    let resolve; const gate = new Promise(r => { resolve = r; }); const { controller, audio, onPlaying, onDone } = setup(async () => gate);
    controller.prepare(); controller.enqueue(0, '/late'); controller.cancel(); resolve({ ok: true, blob: async () => new Blob(['audio']) }); await flush();
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(onPlaying).not.toHaveBeenCalled(); expect(onDone).not.toHaveBeenCalled(); expect(audio.onplaying).toBeNull();
});
test('autoplay rejection is not recorded as actual playback', async () => {
    const { controller, audio, onPlaying, onError } = setup(); audio.play.mockRejectedValue(new Error('NotAllowedError'));
    controller.enqueue(0, '/first'); await flush(); expect(onPlaying).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledTimes(1);
    audio.play.mockResolvedValue(); controller.resume(); audio.onplaying(); expect(onPlaying).toHaveBeenCalledTimes(1);
});
test('an unplayed OGG can switch to MP3, but a partially played stream cannot restart automatically', async () => {
    const { controller, audio, onError } = setup(); controller.prepare(); controller.enqueue(-1, '/stream', true); await flush();
    audio.onerror(); expect(onError).not.toHaveBeenCalled(); expect(controller.fallback()).toBe(true);
    controller.enqueue(0, '/mp3'); await flush(); audio.onplaying(); expect(controller.fallback()).toBe(false);
});
