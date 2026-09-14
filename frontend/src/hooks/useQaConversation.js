import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createQaClient } from '../services/qaClient';
import { createQaAudioController, chooseQaAudioMode } from '../services/qaAudioController';
import { createQaLatencyTrace } from '../services/qaLatencyTrace';
const uuid = () => window.crypto?.randomUUID?.() || `qa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export function useQaConversation({ apiBase, token, videoId, announceError, playbackRate = 1.2 }) {
    const [enabled, setEnabled] = useState(false), [turns, setTurns] = useState([]), [busy, setBusy] = useState(false), [audioError, setAudioError] = useState('');
    const client = useMemo(() => createQaClient({ apiBase, token }), [apiBase, token]);
    const history = useRef([]), active = useRef(null), session = useRef(null), audio = useRef(null), mounted = useRef(true);
    const allowOgg = useRef(false);
    const rate = useRef(playbackRate); rate.current = playbackRate;
    useEffect(() => { audio.current?.setPlaybackRate(playbackRate); }, [playbackRate]);
    const announce = useRef(announceError); announce.current = announceError;
    const waitingSpeech = useRef(null);
    const stopWaitingSpeech = useCallback(() => {
        if (!waitingSpeech.current) return;
        window.speechSynthesis?.cancel?.();
        waitingSpeech.current = null;
    }, []);
    const speakWaiting = useCallback(() => {
        if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') return;
        stopWaitingSpeech();
        const utterance = new window.SpeechSynthesisUtterance('잠시만요. 화면을 확인하고 있어요.');
        utterance.lang = 'ko-KR';
        utterance.rate = Math.max(0.8, Math.min(2, playbackRate));
        waitingSpeech.current = utterance;
        utterance.onend = () => { if (waitingSpeech.current === utterance) waitingSpeech.current = null; };
        utterance.onerror = () => { if (waitingSpeech.current === utterance) waitingSpeech.current = null; };
        window.speechSynthesis.speak(utterance);
    }, [playbackRate, stopWaitingSpeech]);
    const update = useCallback((id, patch) => {
        history.current = history.current.map(turn => turn.id === id ? { ...turn, ...patch } : turn);
        if (mounted.current) setTurns([...history.current]);
    }, []);
    const cancel = useCallback(() => {
        const request = active.current; active.current = null; audio.current?.cancel(); stopWaitingSpeech();
        if (request) { request.controller.abort(); request.trace?.finish('canceled'); if (!request.replay) client.cancel(request.id).catch(() => {});
            const turn = history.current.find(item => item.id === request.id);
            if (turn?.isGenerating) update(request.id, { isGenerating: false, status: 'canceled' }); }
        if (mounted.current) setBusy(false);
    }, [client, stopWaitingSpeech, update]);
    useEffect(() => {
        mounted.current = true; const controller = new AbortController(); session.current = uuid(); history.current = []; setTurns([]); setEnabled(false); setBusy(false);
        let heartbeat; const sessionId = session.current;
        if (token) client.config(controller.signal).then(config => {
            if (controller.signal.aborted) return; setEnabled(config.incrementalSpeech); allowOgg.current = config.oggStreaming === true;
            if (config.incrementalSpeech) { client.presence(sessionId, videoId, true).catch(() => {});
                heartbeat = setInterval(() => client.presence(sessionId, videoId, true).catch(() => {}), 60000); }
        }).catch(() => {});
        return () => { mounted.current = false; controller.abort(); clearInterval(heartbeat); cancel(); client.presence(sessionId, videoId, false).catch(() => {}); };
    }, [client, videoId, cancel, token]);
    const ask = useCallback(async ({ question, timestamp }) => {
        if (active.current || !question.trim()) return;
        const id = uuid(), controller = new AbortController();
        const audioMode = chooseQaAudioMode(window, { allowOgg: allowOgg.current }); let usingOgg = audioMode === 'ogg';
        const payloadHistory = history.current.map(turn => ({ requestId: turn.id, timestamp: turn.timestamp, question: turn.question, answer: turn.answer, status: turn.status }));
        const request = { id, controller }; active.current = request; setBusy(true); setAudioError('');
        speakWaiting();
        const trace = createQaLatencyTrace({ requestId: id, timestamp, historyTurns: payloadHistory.length, implementation: 'incremental' });
        request.trace = trace;
        let errorAnnounced = false;
        const onError = message => { if (active.current !== request) return; setAudioError(message); if (!errorAnnounced) { errorAnnounced = true; announce.current(message); } };
        audio.current = createQaAudioController({ onPlaying: () => { stopWaitingSpeech(); trace.playing(usingOgg ? 'ogg' : 'mp3'); }, onError,
            onDone: () => { if (active.current === request) { active.current = null; setBusy(false); } } });
        audio.current.prepare(rate.current);
        history.current = [...history.current, { id, timestamp, question, answer: '', status: 'partial', isGenerating: true, seqs: [] }]; setTurns([...history.current]);
        try {
            const accepted = await client.submit({ requestId: id, sessionId: session.current, videoId, timestamp, question,
                history: payloadHistory, audioMode }, controller.signal);
            if (active.current !== request) return;
            if (accepted.audioPath) audio.current.enqueue(-1, apiBase + accepted.audioPath, true);
            await client.events(accepted.eventsPath, { signal: controller.signal, onEvent: event => {
                if (active.current !== request) return;
                const turn = history.current.find(value => value.id === id);
                if (event.type === 'sentence' && !turn.seqs.includes(event.data.seq)) {
                    trace.mark('firstText'); update(id, { answer: [turn.answer, event.data.text].filter(Boolean).join(' '), seqs: [...turn.seqs, event.data.seq], sources: [...new Map([...(turn.sources || []), ...(event.data.sources || [])].map(source => [source.url, source])).values()] });
                }
                if (event.type === 'sentence_audio') {
                    if (usingOgg) { if (!audio.current.fallback()) throw new Error('QA_PARTIAL_STREAM_INTERRUPTED'); usingOgg = false; }
                    audio.current.enqueue(event.data.seq, apiBase + event.data.path);
                }
                if (event.type === 'generation_done') { trace.mark('generationDone'); update(id, { sources: event.data.sources || turn.sources || [], ...(event.data.searchSuggestions ? { searchSuggestions: event.data.searchSuggestions } : {}) }); }
                if (event.type === 'audio_done') { stopWaitingSpeech(); update(id, { isGenerating: false, status: 'completed' }); audio.current.complete(); }
                if (event.type === 'error') throw new Error(event.data.code);
                if (event.type === 'canceled') cancel();
            } });
        } catch (error) {
            if (active.current !== request || controller.signal.aborted) return;
            trace.finish('failed');
            update(id, { isGenerating: false, status: history.current.find(turn => turn.id === id)?.answer ? 'partial' : 'failed' });
            onError(error.message === 'QA_ANSWER_FORMAT_INVALID' ? '답변 형식을 읽지 못했습니다. 다시 질문해 주세요.' : error.message === 'QA_EMPTY_MODEL_RESPONSE' ? 'AI가 답변을 반환하지 않았습니다. 다시 질문해 주세요.' : '답변이 중단되었습니다. 남아 있는 답변을 확인하거나 새 질문을 보내 주세요.');
            audio.current.cancel(); stopWaitingSpeech(); active.current = null; setBusy(false); client.cancel(id).catch(() => {});
        }
    }, [apiBase, client, playbackRate, speakWaiting, stopWaitingSpeech, videoId, update, cancel]);
    const replay = useCallback(async id => {
        cancel(); const turn = history.current.find(item => item.id === id); if (!turn) return;
        const controller = new AbortController(), request = { id, controller, replay: true }; active.current = request; setBusy(true); setAudioError('');
        audio.current = createQaAudioController({ onError: message => { if (active.current === request) { setAudioError(message); announce.current(message); } },
            onDone: () => { if (active.current === request) { active.current = null; setBusy(false); } } }); audio.current.prepare(rate.current);
        try { for (const seq of turn.seqs) { const grant = await client.audioTicket(id, seq, controller.signal); if (active.current !== request) return; audio.current.enqueue(seq, apiBase + grant.path); }
            audio.current.complete();
        } catch { if (active.current === request) { cancel(); setAudioError('다시 듣기 시간이 만료되었습니다. 새 질문을 보내 주세요.'); announce.current('다시 듣기 시간이 만료되었습니다. 새 질문을 보내 주세요.'); } }
    }, [apiBase, client, cancel]);
    return { enabled, turns, busy, audioError, ask, cancel, replay, resume: () => audio.current?.resume() };
}
