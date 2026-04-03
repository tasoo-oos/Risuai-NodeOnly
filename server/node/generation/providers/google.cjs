'use strict';

const { completeJob, emitDelta, emitProviderWarning, updateJobResult } = require('../jobs.cjs');
const { createLogger } = require('../logger.cjs');
const { fetchWithRetry, readJsonSafe, parseSSE, extractGoogleText } = require('./common.cjs');

const log = createLogger('ProviderGoogle');

async function runGoogleTransport(job, transport) {
    const response = await fetchWithRetry(job, transport, 'Google');
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Google transport failed (${response.status}): ${body}`);
    }

    if (transport.useStreaming) {
        let acc = '';
        for await (const evt of parseSSE(response.body)) {
            let json;
            try {
                json = JSON.parse(evt.data);
            } catch {
                continue;
            }

            const delta = json?.candidates?.[0]?.content?.parts
                ?.filter((part) => typeof part?.text === 'string')
                ?.map((part) => part.text)
                ?.join('') || '';

            if (delta) {
                acc += delta;
                emitDelta(job.id, delta);
                updateJobResult(job.id, acc);
            }
        }
        completeJob(job.id, acc);
        return;
    }

    const json = await readJsonSafe(response);
    const text = extractGoogleText(json);
    if (!text) {
        emitProviderWarning(job.id, 'Google response returned no text content');
    }
    completeJob(job.id, text);
}

module.exports = {
    runGoogleTransport,
};
