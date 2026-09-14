'use strict';
const { once } = require('node:events');
const { PassThrough } = require('node:stream');
const { createMediaResourceLimiter } = require('./mediaResourceLimiter');
const qaProviderLimiter = createMediaResourceLimiter({ model: 2, tts: 2 });
const voice = { languageCode: 'ko-KR', name: 'ko-KR-Chirp3-HD-Sulafat' };
function createQaSpeech({ client, streamingClient, limiter = qaProviderLimiter }) {
    return {
        async mp3(text, signal) {
            const release = await limiter.acquire({ tts: 1 }, { signal });
            try {
                signal.throwIfAborted();
                // Unary SDK requests have a provider deadline; cancellation drops
                // their result but retains the permit until the RPC settles.
                const [result] = await client.synthesizeSpeech({ input: { text }, voice, audioConfig: { audioEncoding: 'MP3' } }, { timeout: 15000, retry: null });
                signal.throwIfAborted();
                const bytes = Buffer.from(result.audioContent || []);
                if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('QA_AUDIO_INVALID');
                return bytes;
            } finally { release(); }
        },
        async ogg(signal) {
            const release = await limiter.acquire({ tts: 1 }, { signal });
            let rpc;
            try { signal.throwIfAborted(); rpc = streamingClient.streamingSynthesize({ timeout: 120000, retry: null }); }
            catch (error) { release(); throw error; }
            const output = new PassThrough({ highWaterMark: 1024 * 1024 });
            output.on('error', () => {});
            let finished = false, totalBytes = 0;
            let firstResolve, firstReject;
            const firstByte = new Promise((a,b) => { firstResolve = a; firstReject = b; }); firstByte.catch(() => {});
            let resolve, reject;
            const done = new Promise((a,b) => { resolve = a; reject = b; }); done.catch(() => {});
            const stop = error => {
                if (finished) return; finished = true;
                signal.removeEventListener('abort', abort); clearTimeout(timer);
                rpc.destroy(); release();
                if (error) { firstReject(error); output.destroy(error); reject(error); } else { output.end(); resolve(); }
            };
            const abort = () => stop(new Error('QA_CANCELED'));
            const timer = setTimeout(() => stop(new Error('QA_TTS_TIMEOUT')), 120000); timer.unref?.();
            signal.addEventListener('abort', abort, { once: true });
            rpc.on('error', stop);
            rpc.on('end', () => stop(totalBytes ? null : new Error('QA_AUDIO_EMPTY')));
            rpc.on('data', value => {
                if (finished || !value.audioContent?.length) return;
                totalBytes += value.audioContent.length; firstResolve();
                if (output.readableLength + value.audioContent.length > 1024 * 1024) return stop(new Error('QA_SLOW_AUDIO_CONSUMER'));
                output.write(Buffer.from(value.audioContent));
            });
            rpc.write({ streamingConfig: { voice, streamingAudioConfig: { audioEncoding: 'OGG_OPUS' } } });
            return { output, done, firstByte, get bytes() { return totalBytes; },
                async write(text) { signal.throwIfAborted(); if (finished) throw new Error('QA_AUDIO_CLOSED'); if (!rpc.write({ input: { text } })) await once(rpc, 'drain', { signal }); },
                end() { if (!finished) rpc.end(); }, cancel: abort,
            };
        },
    };
}
module.exports = { createQaSpeech, qaProviderLimiter };
