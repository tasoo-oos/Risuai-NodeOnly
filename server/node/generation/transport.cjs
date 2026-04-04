'use strict';

const { runOpenAITransport } = require('./providers/openai.cjs');
const { runAnthropicTransport } = require('./providers/anthropic.cjs');
const { runGoogleTransport } = require('./providers/google.cjs');
const { sanitizeHeaders } = require('./providers/common.cjs');

function sanitizeTransportForPersistence(transport) {
    if (!transport || typeof transport !== 'object') {
        return null;
    }
    return {
        provider: transport.provider || null,
        url: transport.url || null,
        headers: sanitizeHeaders(transport.headers),
        useStreaming: Boolean(transport.useStreaming),
        method: transport.method || 'POST',
        body: transport.body,
    };
}

async function runTransport(job, transport) {
    switch (transport?.provider) {
        case 'openai':
            return runOpenAITransport(job, transport);
        case 'anthropic':
            return runAnthropicTransport(job, transport);
        case 'google':
            return runGoogleTransport(job, transport);
        default:
            throw new Error(`Unsupported transport provider: ${transport?.provider || 'unknown'}`);
    }
}

module.exports = {
    sanitizeTransportForPersistence,
    runTransport,
};
