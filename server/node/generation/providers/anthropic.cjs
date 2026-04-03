'use strict';

const { completeJob, emitDelta, emitProviderWarning, updateJobResult } = require('../jobs.cjs');
const { createLogger } = require('../logger.cjs');
const { createFetchOptions, readJsonSafe, parseSSE, extractAnthropicText } = require('./common.cjs');

const log = createLogger('ProviderAnthropic');

async function runAnthropicTransport(job, transport) {
    const response = await fetch(transport.url, createFetchOptions(transport, job.abortController.signal));
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Anthropic transport failed (${response.status}): ${body}`);
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

            const delta = json?.delta?.text || json?.text_delta || json?.content_block?.text || '';
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
    const text = extractAnthropicText(json);
    if (!text) {
        emitProviderWarning(job.id, 'Anthropic response returned no text content');
    }
    completeJob(job.id, text);
}

module.exports = {
    runAnthropicTransport,
};
