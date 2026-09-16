export function createQaClient({ apiBase, token, fetchImpl = fetch }) {
    const json = async (path, body, signal) => {
        const response = await fetchImpl(apiBase + path, { method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
        if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.code || 'QA_NETWORK_FAILED'); }
        return response.status === 204 ? null : response.json();
    };
    return { config: signal => json('/api/qa/config', undefined, signal),
        openingSummaryEligibility: (videoId, timestamp, signal) => json('/api/qa/opening-summary-eligibility', { videoId, timestamp }, signal),
        submit: (body, signal) => json('/api/qa/requests', body, signal),
        cancel: id => json(`/api/qa/requests/${id}/cancel`, {}),
        presence: (sessionId, videoId, active) => json(`/api/qa/sessions/${sessionId}/presence`, { videoId, active }),
        audioTicket: (id, seq, signal) => json(`/api/qa/requests/${id}/audio`, { seq }, signal),
        async events(path, { signal, onEvent }) {
            let lastId = 0, terminal = false;
            for (let attempt = 0; attempt < 3 && !terminal; attempt++) {
                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
                try {
                    const response = await fetchImpl(apiBase + path, { signal, headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': String(lastId) } });
                    if (!response.ok || !response.body) throw new Error(response.status === 404 ? 'QA_REQUEST_MISSING' : 'QA_NETWORK_FAILED');
                    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
                    try {
                        while (!terminal) {
                            const { value, done } = await reader.read();
                            pending += decoder.decode(value || new Uint8Array(), { stream: !done });
                            if (pending.length > 65536) throw new Error('QA_EVENT_TOO_LARGE');
                            let boundary;
                            while ((boundary = pending.indexOf('\n\n')) >= 0) {
                                const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
                                const lines = block.split('\n'); const id = Number(lines.find(line => line.startsWith('id:'))?.slice(3));
                                const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
                                const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
                                if (!type || !data || !Number.isSafeInteger(id) || id <= lastId) continue;
                                if (id !== lastId + 1) throw new Error('QA_EVENT_GAP');
                                lastId = id;
                                try { onEvent({ id, type, data: JSON.parse(data) }); } catch (error) { error.qaEventHandler = true; throw error; }
                                terminal = ['audio_done', 'error', 'canceled'].includes(type);
                            }
                            if (done) break;
                        }
                    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
                    if (!terminal) throw new Error('QA_STREAM_INTERRUPTED');
                } catch (error) { if (signal.aborted || error.qaEventHandler || attempt === 2 || error.message === 'QA_REQUEST_MISSING') throw error; }
            }
        },
    };
}
