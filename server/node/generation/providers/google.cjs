'use strict';

const { completeJob, emitDelta, emitProviderWarning, emitToolCallFinished, emitToolCallStarted, updateJobResult } = require('../jobs.cjs');
const { createLogger } = require('../logger.cjs');
const { fetchWithRetry, readJsonSafe, parseSSE, extractGoogleText } = require('./common.cjs');
const { executeToolCall } = require('../toolRunner.cjs');

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
    if (hasGoogleFunctionCall(json)) {
        const followUpText = await resolveGoogleToolCalls(job, transport, json);
        completeJob(job.id, followUpText);
        return;
    }
    const text = extractGoogleText(json);
    if (!text) {
        emitProviderWarning(job.id, 'Google response returned no text content');
    }
    completeJob(job.id, text);
}

function hasGoogleFunctionCall(json) {
    return Boolean(json?.candidates?.some((candidate) =>
        (candidate?.content?.parts || []).some((part) => part?.functionCall)
    ));
}

async function resolveGoogleToolCalls(job, transport, json) {
    const functionCallMessages = [];
    const functionResponses = [];
    for (const candidate of json.candidates || []) {
        const functionCallParts = [];
        for (const part of candidate?.content?.parts || []) {
            if (!part?.functionCall) {
                continue;
            }
            functionCallParts.push(part);
            emitToolCallStarted(job.id, part.functionCall.name, part.functionCall.args);
            const result = await executeToolCall(part.functionCall.name, part.functionCall.args || {});
            emitToolCallFinished(job.id, part.functionCall.name, result);
            functionResponses.push({
                role: 'function',
                parts: [{
                    functionResponse: {
                        name: part.functionCall.name,
                        response: {
                            data: result.map((item) => item.text || '').join('\n'),
                        },
                    },
                }],
            });
        }
        if (functionCallParts.length > 0) {
            functionCallMessages.push({
                role: 'model',
                parts: functionCallParts,
            });
        }
    }

    const followUpTransport = {
        ...transport,
        body: {
            ...transport.body,
            contents: [
                ...(transport.body.contents || []),
                ...functionCallMessages,
                ...functionResponses,
            ],
        },
    };
    const followUpResponse = await fetchWithRetry(job, followUpTransport, 'Google tool follow-up');
    if (!followUpResponse.ok) {
        throw new Error(`Google tool follow-up failed (${followUpResponse.status}): ${await followUpResponse.text()}`);
    }
    const followUpJson = await readJsonSafe(followUpResponse);
    return extractGoogleText(followUpJson);
}

module.exports = {
    runGoogleTransport,
};
