const SILENCE = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
export function createQaAudioController({ audio = new Audio(), fetchImpl = fetch, onPlaying = () => {}, onError = () => {}, onDone = () => {} } = {}) {
    let epoch = 0, queue = [], current = null, fetching = false, finished = false, started = false, deferredError = null;
    let abort = new AbortController(); const seen = new Set();
    const revoke = item => { if (item?.objectUrl) URL.revokeObjectURL(item.objectUrl); };
    function reset() {
        epoch++; abort.abort(); abort = new AbortController();
        audio.onended = null; audio.onplaying = null; audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load();
        revoke(current); current = null; queue = []; seen.clear(); fetching = false; finished = false; started = false; deferredError = null;
    }
    function checkDone() { if (finished && !current && !queue.length && !fetching) onDone(); }
    function play(version) {
        audio.play().catch(() => { if (version === epoch) onError('답변 음성을 재생하려면 음성 재생 버튼을 눌러 주세요.'); });
    }
    async function pump() {
        if (current || fetching || !queue.length) return checkDone();
        fetching = true; const version = epoch; const item = queue.shift();
        try {
            if (!item.stream) {
                const response = await fetchImpl(item.url, { signal: abort.signal });
                if (!response.ok) throw new Error('audio unavailable');
                const blob = await response.blob(); if (version !== epoch) return;
                if (blob.size > 1024 * 1024) throw new Error('audio too large');
                item.objectUrl = URL.createObjectURL(blob);
            }
            if (version !== epoch) return;
            current = item; audio.src = item.objectUrl || item.url;
            audio.onplaying = () => { if (version === epoch) { started = true; onPlaying(item.seq); } };
            audio.onended = () => { if (version !== epoch) return; revoke(current); current = null; pump(); };
            audio.onerror = () => {
                if (version !== epoch) return;
                const message = '답변 음성을 불러오지 못했습니다. 다시 듣기를 눌러 주세요.';
                if (item.stream && !started && !finished) deferredError = message; else onError(message);
            };
            play(version);
        } catch (error) { if (version === epoch) onError('답변 음성을 불러오지 못했습니다. 다시 듣기를 눌러 주세요.'); }
        finally { if (version === epoch) { fetching = false; checkDone(); } }
    }
    return {
        prepare(rate = 1) { reset(); audio.playbackRate = rate; audio.src = SILENCE; const version = epoch;
            audio.play().then(() => { if (version === epoch && !current) audio.pause(); }).catch(() => {}); },
        enqueue(seq, url, stream = false) { if (seen.has(seq)) return; seen.add(seq); queue.push({ seq, url, stream }); pump(); },
        complete() { finished = true; if (deferredError) onError(deferredError); checkDone(); },
        fallback() { if (started) return false; reset(); return true; },
        resume() { if (current) play(epoch); else pump(); }, cancel: reset,
        get started() { return started; },
    };
}

export function chooseQaAudioMode(env = window, { allowOgg = false } = {}) {
    const ua = env.navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) || (env.navigator.platform === 'MacIntel' && env.navigator.maxTouchPoints > 1);
    const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
    return allowOgg && !ios && !safari && env.document.createElement('audio').canPlayType('audio/ogg; codecs="opus"') ? 'ogg' : 'mp3';
}
