'use strict';

const { completeJob, emitDelta, emitProviderWarning, emitToolCallFinished, emitToolCallStarted, updateJobResult } = require('../jobs.cjs');
const { createLogger } = require('../logger.cjs');
const { fetchWithRetry, readJsonSafe, parseSSE, extractOpenAIText } = require('./common.cjs');
const { executeToolCall } = require('../toolRunner.cjs');

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
    if (json?.choices?.[0]?.message?.tool_calls?.length) {
        const followUpText = await resolveOpenAIToolCalls(job, transport, json);
        completeJob(job.id, followUpText);
        return;
    }
    const text = extractOpenAIText(json);
    if (!text) {
        emitProviderWarning(job.id, 'OpenAI response returned no text content');
    }
    completeJob(job.id, text);
}

async function resolveOpenAIToolCalls(job, transport, json) {
    const assistantMessage = json.choices[0].message;
    const toolCalls = assistantMessage.tool_calls || [];
    const toolMessages = [];
    for (const call of toolCalls) {
        const toolName = call?.function?.name;
        const rawArguments = call?.function?.arguments || '{}';
        const args = safeParseJson(rawArguments);
        emitToolCallStarted(job.id, toolName, args);
        const toolResult = await executeToolCall(toolName, args);
        emitToolCallFinished(job.id, toolName, toolResult);
        toolMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResult.map((item) => item.text || '').join('\n'),
        });
    }

    const followUpTransport = {
        ...transport,
        body: {
            ...transport.body,
            stream: false,
            messages: [
                ...(transport.body.messages || []),
                assistantMessage,
                ...toolMessages,
            ],
        },
    };
    const followUpResponse = await fetchWithRetry(job, followUpTransport, 'OpenAI tool follow-up');
    if (!followUpResponse.ok) {
        throw new Error(`OpenAI tool follow-up failed (${followUpResponse.status}): ${await followUpResponse.text()}`);
    }
    const followUpJson = await readJsonSafe(followUpResponse);
    return extractOpenAIText(followUpJson);
}

function safeParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

module.exports = {
    runOpenAITransport,
};
