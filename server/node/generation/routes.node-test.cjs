'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { setupGenerationRoutes, buildPersistedPayload, summarizeCompiledBody } = require('./routes.cjs');

test('generation route rejects transport and compiledTransport together', async () => {
    let createGenerationHandler;
    const app = {
        post(path, ...handlers) {
            if (path === '/api/generations') {
                createGenerationHandler = handlers.at(-1);
            }
        },
        get() {},
    };
    setupGenerationRoutes({
        app,
        authenticatedRouteLimiter: (_req, _res, next) => next(),
        checkAuth: async () => true,
        checkActiveSession: () => true,
    });
    const response = {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        },
    };

    await createGenerationHandler({
        body: {
            characterId: 'char1',
            chatId: 'chat1',
            mode: 'server',
            transport: { provider: 'openai', body: {} },
            compiledTransport: {
                provider: 'openai',
                endpointKind: 'chat-completions',
                model: 'gpt-4o-mini',
                body: { messages: [] },
                useStreaming: false,
            },
        },
        headers: {},
    }, response);

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.payload, {
        error: 'transport and compiledTransport are mutually exclusive',
    });
});

test('persisted compiled payload stores metadata instead of the full body', () => {
    const bigImage = 'A'.repeat(100000);
    const systemText = 'secret system prompt text';
    const userText = 'secret user prompt text';
    const request = {
        characterId: 'char1',
        chatId: 'chat1',
        mode: 'server',
        continue: true,
        useStreaming: false,
        compiledTransport: {
            provider: 'anthropic',
            endpointKind: 'anthropic-messages',
            model: 'claude-3-5-sonnet',
            body: {
                model: 'claude-3-5-sonnet',
                system: systemText,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: userText },
                            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigImage } },
                        ],
                    },
                ],
                max_tokens: 4096,
                temperature: 0.7,
                tools: [{ name: 'rollDice' }],
            },
            useStreaming: false,
        },
    };

    const persisted = buildPersistedPayload(request);

    assert.equal(persisted.compiledTransport.provider, 'anthropic');
    assert.equal(persisted.compiledTransport.endpointKind, 'anthropic-messages');
    assert.equal(persisted.compiledTransport.model, 'claude-3-5-sonnet');
    assert.equal(persisted.compiledTransport.useStreaming, false);
    assert.equal(persisted.compiledTransport.body, undefined);

    const summary = persisted.compiledTransport.bodySummary;
    assert.equal(summary.messageCount, 1);
    assert.equal(summary.imageCount, 1);
    assert.equal(summary.maxTokens, 4096);
    assert.equal(summary.temperature, 0.7);
    assert.deepEqual(summary.toolNames, ['rollDice']);
    assert.ok(summary.size > 0);
    assert.ok(summary.textChars >= systemText.length + userText.length);

    const serialized = JSON.stringify(persisted);
    assert.ok(!serialized.includes(bigImage));
    assert.ok(!serialized.includes(systemText));
    assert.ok(!serialized.includes(userText));

    assert.equal(persisted.continue, true);
    assert.equal(persisted.mode, 'server');
});

test('persisted compiled payload summarizes OpenAI-style bodies', () => {
    const request = {
        characterId: 'char1',
        chatId: 'chat1',
        mode: 'server',
        compiledTransport: {
            provider: 'openai',
            endpointKind: 'chat-completions',
            model: 'gpt-4o-mini',
            body: {
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'assistant', content: 'there' },
                ],
                max_tokens: 100,
                temperature: 0.5,
                tools: [{ type: 'function', function: { name: 'rollDice' } }],
            },
            useStreaming: true,
        },
    };

    const persisted = buildPersistedPayload(request);
    const summary = persisted.compiledTransport.bodySummary;

    assert.equal(summary.messageCount, 2);
    assert.equal(summary.imageCount, 0);
    assert.equal(summary.textChars, 7);
    assert.deepEqual(summary.toolNames, ['rollDice']);
    assert.equal(persisted.compiledTransport.useStreaming, true);
});

test('summarizeCompiledBody handles Google bodies and invalid input', () => {
    const googleSummary = summarizeCompiledBody('google', {
        contents: [
            {
                role: 'user',
                parts: [
                    { text: 'hello' },
                    { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
                ],
            },
        ],
        systemInstruction: { parts: [{ text: 'system' }] },
        tools: [{ functionDeclarations: [{ name: 'rollDice' }, { name: 'other' }] }],
        generation_config: { maxOutputTokens: 256 },
    });

    assert.equal(googleSummary.messageCount, 1);
    assert.equal(googleSummary.imageCount, 1);
    assert.equal(googleSummary.textChars, 11);
    assert.equal(googleSummary.toolCount, 2);

    assert.equal(summarizeCompiledBody('openai', null), null);
    assert.equal(summarizeCompiledBody('openai', 'string'), null);
    assert.equal(summarizeCompiledBody('openai', [1, 2]), null);
});

test('persisted transport payload keeps its existing sanitized shape', () => {
    const request = {
        characterId: 'char1',
        chatId: 'chat1',
        mode: 'transport',
        transport: {
            provider: 'openai',
            url: 'https://api.openai.com/v1/chat/completions',
            body: { messages: [{ role: 'user', content: 'hi' }] },
            headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
            method: 'POST',
            useStreaming: true,
        },
    };

    const persisted = buildPersistedPayload(request);

    assert.equal(persisted.transport.headers.Authorization, '***REDACTED***');
    assert.equal(persisted.transport.headers['Content-Type'], 'application/json');
    assert.deepEqual(persisted.transport.body, { messages: [{ role: 'user', content: 'hi' }] });
});

test('persisted payload sanitizes both transport fields defensively', () => {
    const secretPrompt = 'private compiled prompt';
    const request = {
        mode: 'server',
        transport: {
            provider: 'openai',
            url: 'https://api.openai.com/v1/chat/completions',
            body: {},
            headers: { Authorization: 'Bearer secret' },
        },
        compiledTransport: {
            provider: 'openai',
            endpointKind: 'chat-completions',
            model: 'gpt-4o-mini',
            body: { messages: [{ role: 'user', content: secretPrompt }] },
            useStreaming: false,
        },
    };

    const persisted = buildPersistedPayload(request);
    const serialized = JSON.stringify(persisted);

    assert.equal(persisted.transport.headers.Authorization, '***REDACTED***');
    assert.equal(persisted.compiledTransport.body, undefined);
    assert.equal(persisted.compiledTransport.bodySummary.messageCount, 1);
    assert.ok(!serialized.includes(secretPrompt));
});
