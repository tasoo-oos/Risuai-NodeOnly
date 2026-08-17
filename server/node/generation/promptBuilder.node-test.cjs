'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildTransportFromCompiledRequest,
    buildTransportFromContext,
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

test('compiled Google transport emits tools as a GenerateContent array', () => {
    const db = {
        google: { accessToken: 'server-google-key' },
    };
    const safeTool = {
        name: 'rollDice',
        description: 'Roll dice',
        inputSchema: { type: 'object' },
    };
    const context = {
        provider: 'google',
        endpointKind: 'google-generate',
        model: 'gemini-2.0-flash',
        messages: [],
        temperature: 1,
        maxTokens: 512,
        tools: [safeTool],
        useStreaming: false,
    };
    const compiled = {
        provider: 'google',
        endpointKind: 'google-generate',
        model: 'gemini-2.0-flash',
        body: {
            contents: [{ role: 'user', parts: [{ text: 'compiled prompt' }] }],
            tools: { functionDeclarations: [{ name: 'unsafePluginTool' }] },
        },
        useStreaming: false,
    };

    const transport = buildTransportFromCompiledRequest(db, context, compiled);

    assert.deepEqual(transport.body.tools, [{
        functionDeclarations: [{
            name: 'rollDice',
            description: 'Roll dice',
            parameters: { type: 'object' },
        }],
    }]);
});

test('compiled Anthropic transport reconstructs required beta headers from trusted state', () => {
    const db = {
        aiModel: 'claude-3-5-sonnet',
        claudeAPIKey: 'server-claude-key',
        claude1HourCaching: true,
    };
    const context = {
        provider: 'anthropic',
        endpointKind: 'anthropic-messages',
        model: 'claude-3-5-sonnet',
        messages: [],
        temperature: 1,
        maxTokens: 16384,
        tools: [],
        useStreaming: false,
    };
    const compiled = {
        provider: 'anthropic',
        endpointKind: 'anthropic-messages',
        model: 'claude-3-5-sonnet',
        body: {
            model: 'claude-3-5-sonnet',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 16384,
            stream: true,
        },
        useStreaming: false,
        url: 'http://attacker.invalid',
        headers: { 'anthropic-beta': 'spoofed-beta-2020-01-01' },
    };

    const transport = buildTransportFromCompiledRequest(db, context, compiled);

    assert.equal(
        transport.headers['anthropic-beta'],
        'output-128k-2025-02-19,extended-cache-ttl-2025-04-11',
    );
    assert.equal(transport.headers['x-api-key'], 'server-claude-key');
    assert.equal(transport.headers['anthropic-version'], '2023-06-01');
    assert.equal(transport.body.stream, false);
});

test('compiled Anthropic transport adds the one-hour cache beta without high max tokens', () => {
    const db = {
        aiModel: 'claude-3-5-sonnet',
        claudeAPIKey: 'server-claude-key',
        claude1HourCaching: true,
    };
    const context = {
        provider: 'anthropic',
        endpointKind: 'anthropic-messages',
        model: 'claude-3-5-sonnet',
        messages: [],
        temperature: 1,
        maxTokens: 512,
        tools: [],
        useStreaming: false,
    };
    const compiled = {
        provider: 'anthropic',
        endpointKind: 'anthropic-messages',
        model: 'claude-3-5-sonnet',
        body: {
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 512,
        },
        useStreaming: false,
    };

    const transport = buildTransportFromCompiledRequest(db, context, compiled);

    assert.equal(transport.headers['anthropic-beta'], 'extended-cache-ttl-2025-04-11');
});

test('compiled Anthropic transport omits the beta header when no beta is required', () => {
    const db = {
        aiModel: 'claude-3-5-sonnet',
        claudeAPIKey: 'server-claude-key',
    };
    const context = {
        provider: 'anthropic',
        endpointKind: 'anthropic-messages',
        model: 'claude-3-5-sonnet',
        messages: [],
        temperature: 1,
        maxTokens: 512,
        tools: [],
        useStreaming: false,
    };
    const compiled = {
        provider: 'anthropic',
        endpointKind: 'anthropic-messages',
        model: 'claude-3-5-sonnet',
        body: {
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 512,
        },
        useStreaming: false,
        headers: { 'anthropic-beta': 'spoofed-beta-2020-01-01' },
    };

    const transport = buildTransportFromCompiledRequest(db, context, compiled);

    assert.equal(transport.headers['anthropic-beta'], undefined);
});

test('Anthropic context transport includes reconstructed beta headers', () => {
    const db = {
        aiModel: 'claude-3-5-sonnet',
        claudeAPIKey: 'server-claude-key',
        claude1HourCaching: true,
    };
    const context = {
        provider: 'anthropic',
        endpointKind: null,
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 1,
        maxTokens: 20000,
        tools: [],
        useStreaming: false,
    };

    const transport = buildTransportFromContext(db, context);

    assert.equal(
        transport.headers['anthropic-beta'],
        'output-128k-2025-02-19,extended-cache-ttl-2025-04-11',
    );
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
