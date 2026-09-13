// Opt-in, tab-local benchmark. Never retain questions, answers, URLs or tickets.
const activeAudio = new WeakMap();
const noop = { mark() {}, audio() {}, playing() {}, finish() {} };
const stages = new Set(['firstText', 'generationDone', 'ttsRequested']);

export function createQaLatencyTrace({ requestId, historyTurns, timestamp, implementation = 'legacy' }, env = window) {
    let config;
    try { config = JSON.parse(env.sessionStorage.getItem('qaLatencyBenchmark')); } catch { return noop; }
    if (!config || config.enabled !== true) return noop;
    const now = () => env.performance.now();
    const started = now();
    const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : 'unspecified';
    const record = {
        schemaVersion: 1, requestId, implementation,
        fixture: label(config.fixture), cacheState: ['cold', 'warming', 'warm'].includes(config.cacheState) ? config.cacheState : 'unknown',
        device: label(config.device), run: label(config.run),
        historyTurns, timestamp, audioMode: 'none', status: 'pending', timings: {},
    };
    let finished = false;
    let detach = () => {};
    const finish = (status) => {
        if (finished) return;
        finished = true;
        env.clearTimeout(timer);
        detach();
        record.status = status;
        record.elapsedMs = now() - started;
        const records = Array.isArray(env.__qaLatencyRecords) ? env.__qaLatencyRecords : [];
        // This cap affects diagnostic samples only, never conversation history.
        env.__qaLatencyRecords = [...records.slice(-499), record];
    };
    const timer = env.setTimeout(() => finish('timeout'), 125000);
    return {
        mark(stage) {
            if (!finished && stages.has(stage) && record.timings[stage] === undefined) record.timings[stage] = now() - started;
        },
        playing(mode) {
            if (finished) return;
            record.audioMode = mode; record.timings.firstPlaying = now() - started; finish('played');
        },
        audio(element, mode) {
            if (finished) return;
            detach();
            activeAudio.get(element)?.();
            record.audioMode = mode;
            const playing = () => {
                record.timings.firstPlaying = now() - started;
                finish('played');
            };
            const supersede = () => finish('superseded');
            activeAudio.set(element, supersede);
            element.addEventListener('playing', playing);
            detach = () => {
                element.removeEventListener('playing', playing);
                if (activeAudio.get(element) === supersede) activeAudio.delete(element);
            };
        },
        finish,
    };
}
