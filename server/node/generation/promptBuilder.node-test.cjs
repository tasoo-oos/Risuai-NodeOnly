'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildTransportFromCompiledRequest,
    validateCompiledTransport,
} = require('./promptBuilder.cjs');

test('compiled OpenAI transport preserves the body and uses server credentials', () => {
    const db = {
        aiModel: 'gpt-4o-mini',
        openAIKey: 'server-secret',
    };
    const context = {
        provider: 'openai',
        endpointKind: 'chat-completions',
        model: 'gpt-4o-mini',
        messages: [],
        temperature: 1,
        maxTokens: 512,
        tools: [],
        useStreaming: true,
    };
    const compiled = {
        provider: 'openai',
        endpointKind: 'chat-completions',
        model: 'gpt-4o-mini',
        body: {
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: 'compiled lore and memory' }],
            custom_parameter: 'preserved',
            stream: false,
        },
        useStreaming: true,
        url: 'http://attacker.invalid',
        headers: { authorization: 'attacker-secret' },
    };

    const transport = buildTransportFromCompiledRequest(db, context, compiled);

    assert.equal(transport.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(transport.headers.Authorization, 'Bearer server-secret');
    assert.deepEqual(transport.body.messages, compiled.body.messages);
    assert.equal(transport.body.custom_parameter, 'preserved');
    assert.equal(transport.body.stream, true);
    assert.equal(transport.body.tools, undefined);
});

test('compiled transport replaces client tools with the server-safe selection', () => {
    const db = { aiModel: 'gpt-4o-mini', openAIKey: 'key' };
    const safeTool = {
        name: 'rollDice',
        description: 'Roll dice',
        inputSchema: { type: 'object' },
    };
    const context = {
        provider: 'openai',
        endpointKind: 'chat-completions',
        model: 'gpt-4o-mini',
        messages: [],
        temperature: 1,
        maxTokens: 512,
        tools: [safeTool],
        unsupportedTools: ['unsafePluginTool'],
        useStreaming: false,
    };
    const compiled = {
        provider: 'openai',
        endpointKind: 'chat-completions',
        model: 'gpt-4o-mini',
        body: {
            messages: [],
            tools: [{ type: 'function', function: { name: 'unsafePluginTool' } }],
            tool_choice: { type: 'function', function: { name: 'unsafePluginTool' } },
            parallel_tool_calls: true,
        },
        useStreaming: true,
    };

    const transport = buildTransportFromCompiledRequest(db, context, compiled);

    assert.deepEqual(transport.body.tools, [{
        type: 'function',
        function: {
            name: 'rollDice',
            description: 'Roll dice',
            parameters: { type: 'object' },
        },
    }]);
    assert.equal(transport.body.stream, false);
    assert.equal(transport.body.tool_choice, undefined);
    assert.equal(transport.body.parallel_tool_calls, undefined);
});

test('compiled Google transport derives its endpoint and key from server state', () => {
    const db = {
        google: { accessToken: 'server-google-key' },
    };
    const context = {
        provider: 'google',
        endpointKind: 'google-generate',
        model: 'gemini-2.0-flash',
        messages: [],
        temperature: 1,
        maxTokens: 512,
        tools: [],
        useStreaming: false,
    };
    const compiled = {
        provider: 'google',
        endpointKind: 'google-generate',
        model: 'gemini-2.0-flash',
        body: {
            contents: [{ role: 'user', parts: [{ text: 'compiled prompt' }] }],
        },
        useStreaming: false,
        url: 'http://attacker.invalid/?key=attacker-key',
    };

    const transport = buildTransportFromCompiledRequest(db, context, compiled);

    assert.equal(
        transport.url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=server-google-key',
    );
    assert.deepEqual(transport.body.contents, compiled.body.contents);
});

test('compiled transport validation rejects mismatched and oversized payloads', () => {
    assert.match(validateCompiledTransport({
        provider: 'google',
        endpointKind: 'chat-completions',
        model: 'gemini-2.0-flash',
        body: {},
        useStreaming: false,
    }), /do not match/);

    assert.match(validateCompiledTransport({
        provider: 'openai',
        endpointKind: 'chat-completions',
        model: 'gpt-4o-mini',
        body: { content: 'x'.repeat(8 * 1024 * 1024) },
        useStreaming: false,
    }), /8 MB/);

    assert.match(validateCompiledTransport({
        provider: undefined,
        endpointKind: 'unknown',
        model: 'gpt-4o-mini',
        body: {},
        useStreaming: false,
    }), /do not match/);
});
