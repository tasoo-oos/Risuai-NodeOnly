'use strict';

const { completeJob, emitDelta, emitProviderWarning, emitToolCallFinished, emitToolCallStarted, setJobBatchId, transitionStatus, updateJobResult } = require('../jobs.cjs');
const { createLogger } = require('../logger.cjs');
const { fetchWithRetry, readJsonSafe, parseSSE, extractAnthropicText } = require('./common.cjs');
const { executeToolCall } = require('../toolRunner.cjs');

const log = createLogger('ProviderAnthropic');

async function runAnthropicTransport(job, transport) {
    if (transport.batching) {
        await runAnthropicBatchTransport(job, transport);
        return;
    }

    const response = await fetchWithRetry(job, transport, 'Anthropic');
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
    if (Array.isArray(json?.content) && json.content.some((part) => part?.type === 'tool_use')) {
        const followUpText = await resolveAnthropicToolCalls(job, transport, json);
        completeJob(job.id, followUpText);
        return;
    }
    const text = extractAnthropicText(json);
    if (!text) {
        emitProviderWarning(job.id, 'Anthropic response returned no text content');
    }
    completeJob(job.id, text);
}

async function resolveAnthropicToolCalls(job, transport, json) {
    const toolResults = [];
    for (const part of json.content || []) {
        if (part?.type !== 'tool_use') {
            continue;
        }
        emitToolCallStarted(job.id, part.name, part.input);
        const result = await executeToolCall(part.name, part.input || {});
        emitToolCallFinished(job.id, part.name, result);
        toolResults.push({
            type: 'tool_result',
            tool_use_id: part.id,
            content: result.map((item) => ({ type: 'text', text: item.text || '' })),
        });
    }

    const followUpTransport = {
        ...transport,
        body: {
            ...transport.body,
            stream: false,
            messages: [
                ...(transport.body.messages || []),
                {
                    role: 'assistant',
                    content: json.content,
                },
                {
                    role: 'user',
                    content: toolResults,
                },
            ],
        },
    };
    const followUpResponse = await fetchWithRetry(job, followUpTransport, 'Anthropic tool follow-up');
    if (!followUpResponse.ok) {
        throw new Error(`Anthropic tool follow-up failed (${followUpResponse.status}): ${await followUpResponse.text()}`);
    }
    const followUpJson = await readJsonSafe(followUpResponse);
    return extractAnthropicText(followUpJson);
}

async function runAnthropicBatchTransport(job, transport) {
    const batchUrl = transport.url.endsWith('/messages')
        ? `${transport.url}/batches`
        : `${transport.url.replace(/\/$/, '')}/batches`;

    const createResponse = await fetchWithRetry(job, {
        ...transport,
        url: batchUrl,
        body: {
            requests: [{
                custom_id: job.id,
                params: {
                    ...transport.body,
                    stream: undefined,
                },
            }],
        },
    }, 'Anthropic batch create');

    if (!createResponse.ok) {
        throw new Error(`Anthropic batch create failed (${createResponse.status}): ${await createResponse.text()}`);
    }

    const createJson = await createResponse.json();
    const batchId = createJson?.id;
    if (!batchId) {
        throw new Error('Anthropic batch create returned no batch id');
    }

    setJobBatchId(job.id, batchId);
    const statusUrl = `${batchUrl}/${batchId}`;
    const resultUrl = `${batchUrl}/${batchId}/results`;
    const cancelUrl = `${batchUrl}/${batchId}/cancel`;

    while (!job.abortController.signal.aborted) {
        await sleep(3000);
        const statusResponse = await fetchWithRetry(job, {
            ...transport,
            url: statusUrl,
            method: 'GET',
            body: undefined,
        }, 'Anthropic batch status', { maxAttempts: 2 });

        if (!statusResponse.ok) {
            throw new Error(`Anthropic batch status failed (${statusResponse.status})`);
        }

        const statusJson = await statusResponse.json();
        const processingStatus = statusJson?.processing_status || statusJson?.status || 'unknown';
        emitProviderWarning(job.id, `Anthropic batch status: ${processingStatus}`);

        if (processingStatus === 'ended' || processingStatus === 'completed') {
            transitionStatus(job.id, 'running');
            break;
        }

        if (processingStatus === 'failed' || processingStatus === 'canceled' || processingStatus === 'expired') {
            throw new Error(`Anthropic batch ended with status: ${processingStatus}`);
        }
    }

    if (job.abortController.signal.aborted) {
        await fetch(cancelUrl, {
            method: 'POST',
            headers: transport.headers,
        }).catch(() => {});
        return;
    }

    const resultResponse = await fetchWithRetry(job, {
        ...transport,
        url: resultUrl,
        method: 'GET',
        body: undefined,
    }, 'Anthropic batch result');

    if (!resultResponse.ok) {
        throw new Error(`Anthropic batch results failed (${resultResponse.status})`);
    }

    const text = await readBatchResultText(resultResponse);
    completeJob(job.id, text);
}

async function readBatchResultText(response) {
    let text = '';
    for await (const evt of parseSSE(response.body)) {
        let json;
        try {
            json = JSON.parse(evt.data);
        } catch {
            continue;
        }
        const blockText = json?.result?.message?.content
            ?.filter((part) => part?.type === 'text')
            ?.map((part) => part.text)
            ?.join('') || '';
        if (blockText) {
            text += blockText;
        }
    }
    return text;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    runAnthropicTransport,
};
