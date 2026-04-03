'use strict';

const { emitProviderRetry } = require('../jobs.cjs');

function sanitizeHeaders(headers) {
    const safe = { ...(headers || {}) };
    for (const key of Object.keys(safe)) {
        const lower = key.toLowerCase();
        if (lower === 'authorization' || lower === 'x-api-key' || lower.includes('token') || lower.includes('secret')) {
            safe[key] = '***REDACTED***';
        }
    }
    return safe;
}

function createFetchOptions(transport, signal) {
    return {
        method: transport.method || 'POST',
        headers: transport.headers || {},
        body: transport.body !== undefined
            ? (typeof transport.body === 'string' ? transport.body : JSON.stringify(transport.body))
            : undefined,
        signal,
    };
}

async function fetchWithRetry(job, transport, label, options = {}) {
    const maxAttempts = options.maxAttempts || 3;
    const retryStatuses = new Set(options.retryStatuses || [429, 500, 502, 503, 504]);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await fetch(transport.url, createFetchOptions(transport, job.abortController.signal));
            if (!retryStatuses.has(response.status) || attempt === maxAttempts) {
                return response;
            }
            emitProviderRetry(job.id, `${label} returned ${response.status}`, attempt);
        } catch (error) {
            lastError = error;
            if (attempt === maxAttempts || job.abortController.signal.aborted) {
                throw error;
            }
            emitProviderRetry(job.id, `${label} network error: ${error.message}`, attempt);
        }
        await sleep(500 * attempt);
    }

    if (lastError) {
        throw lastError;
    }
    throw new Error(`${label} retry loop exited unexpectedly`);
}

async function readJsonSafe(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return { _rawText: text };
    }
}

async function* parseSSE(readable) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of readable) {
        buffer += decoder.decode(chunk, { stream: true });
        while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary === -1) {
                break;
            }
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = rawEvent.split(/\r?\n/);
            let data = '';
            let event = '';
            for (const line of lines) {
                if (line.startsWith('event:')) {
                    event = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                    data += line.slice(5).trim();
                }
            }
            if (data) {
                yield { event, data };
            }
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
        const lines = buffer.split(/\r?\n/);
        let data = '';
        let event = '';
        for (const line of lines) {
            if (line.startsWith('event:')) {
                event = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                data += line.slice(5).trim();
            }
        }
        if (data) {
            yield { event, data };
        }
    }
}

function extractOpenAIText(json) {
    if (json?.choices?.[0]?.message?.content) {
        return typeof json.choices[0].message.content === 'string'
            ? json.choices[0].message.content
            : '';
    }
    if (Array.isArray(json?.output)) {
        return json.output
            .flatMap((item) => item?.content || [])
            .map((part) => part?.text || '')
            .join('');
    }
    if (typeof json?._rawText === 'string') {
        return json._rawText;
    }
    return '';
}

function extractAnthropicText(json) {
    if (Array.isArray(json?.content)) {
        return json.content
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('');
    }
    if (typeof json?._rawText === 'string') {
        return json._rawText;
    }
    return '';
}

function extractGoogleText(json) {
    const candidates = json?.candidates || [];
    return candidates
        .flatMap((candidate) => candidate?.content?.parts || [])
        .filter((part) => typeof part?.text === 'string')
        .map((part) => part.text)
        .join('');
}

module.exports = {
    sanitizeHeaders,
    createFetchOptions,
    fetchWithRetry,
    readJsonSafe,
    parseSSE,
    extractOpenAIText,
    extractAnthropicText,
    extractGoogleText,
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
