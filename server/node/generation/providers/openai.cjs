'use strict';

const { completeJob, emitDelta, emitProviderWarning, updateJobResult } = require('../jobs.cjs');
const { createLogger } = require('../logger.cjs');
const { fetchWithRetry, readJsonSafe, parseSSE, extractOpenAIText } = require('./common.cjs');

const log = createLogger('ProviderOpenAI');

async function runOpenAITransport(job, transport) {
    const response = await fetchWithRetry(job, transport, 'OpenAI');
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI transport failed (${response.status}): ${body}`);
    }

    if (transport.useStreaming) {
        let acc = '';
        for await (const evt of parseSSE(response.body)) {
            if (evt.data === '[DONE]') {
                break;
            }
            let json;
            try {
                json = JSON.parse(evt.data);
            } catch {
                continue;
            }

            const delta = json?.choices?.[0]?.delta?.content
                || json?.choices?.[0]?.text
                || '';
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
    const text = extractOpenAIText(json);
    if (!text) {
        emitProviderWarning(job.id, 'OpenAI response returned no text content');
    }
    completeJob(job.id, text);
}

module.exports = {
    runOpenAITransport,
};
