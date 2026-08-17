'use strict';

const { createLogger } = require('./logger.cjs');
const { selectServerTools } = require('./toolRunner.cjs');

const log = createLogger('PromptBuilder');

async function buildGenerationContext(db, command) {
    const character = findCharacter(db, command.characterId);
    if (!character) {
        throw new Error(`Character not found: ${command.characterId}`);
    }

    const chat = findChat(character, command.chatId);
    if (!chat) {
        throw new Error(`Chat not found: ${command.chatId}`);
    }

    const provider = command.compiledTransport?.provider || detectProvider(command.overrideModel || db.aiModel || '');
    const model = resolveModel(db, provider, command.compiledTransport?.model || command.overrideModel || db.aiModel || '');
    const messages = buildMessages(db, character, chat, command);
    const { safeTools, unsupportedTools } = selectServerTools(command.requestOptions?.tools);
    const temperature = normalizeTemperature(command.requestOptions?.temperature, db.temperature);
    const maxTokens = Number.isFinite(command.requestOptions?.maxTokens)
        ? command.requestOptions.maxTokens
        : (db.maxResponse || 512);

    return {
        provider,
        endpointKind: command.compiledTransport?.endpointKind || null,
        model,
        character,
        chat,
        messages,
        temperature,
        maxTokens,
        tools: safeTools,
        unsupportedTools,
        useStreaming: command.useStreaming !== false && safeTools.length === 0,
    };
}

function validateCompiledTransport(compiled) {
    if (!compiled || typeof compiled !== 'object' || Array.isArray(compiled)) {
        return 'compiledTransport must be an object';
    }
    const endpointProviders = {
        'chat-completions': 'openai',
        'mistral-chat': 'openai',
        'anthropic-messages': 'anthropic',
        'google-generate': 'google',
    };
    if (!Object.hasOwn(endpointProviders, compiled.endpointKind)
        || endpointProviders[compiled.endpointKind] !== compiled.provider) {
        return 'compiledTransport provider and endpointKind do not match';
    }
    if (typeof compiled.model !== 'string' || !compiled.model || compiled.model.length > 512
        || (compiled.provider === 'google' && !/^[A-Za-z0-9._-]+$/.test(compiled.model))) {
        return 'compiledTransport.model is invalid';
    }
    if (!compiled.body || typeof compiled.body !== 'object' || Array.isArray(compiled.body)) {
        return 'compiledTransport.body must be an object';
    }
    if (typeof compiled.useStreaming !== 'boolean') {
        return 'compiledTransport.useStreaming must be a boolean';
    }
    let bodySize;
    try {
        bodySize = Buffer.byteLength(JSON.stringify(compiled.body));
    } catch {
        return 'compiledTransport.body must be JSON serializable';
    }
    if (bodySize > 8 * 1024 * 1024) {
        return 'compiledTransport.body exceeds the 8 MB limit';
    }
    return null;
}

function buildTransportFromCompiledRequest(db, context, compiled) {
    const validationError = validateCompiledTransport(compiled);
    if (validationError) {
        throw new Error(validationError);
    }
    if (compiled.provider !== context.provider || compiled.endpointKind !== context.endpointKind) {
        throw new Error('Compiled transport does not match the generation context');
    }

    const trustedTransport = buildTransportFromContext(db, context);
    const body = { ...compiled.body };
    if (compiled.provider === 'openai' || compiled.provider === 'anthropic') {
        body.stream = context.useStreaming;
    }
    body.tools = compiled.provider === 'google' && context.tools?.length
        ? {
            functionDeclarations: context.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
            })),
        }
        : trustedTransport.body.tools;
    if (context.unsupportedTools?.length) {
        delete body.tool_choice;
        delete body.parallel_tool_calls;
    }

    return {
        ...trustedTransport,
        body,
        useStreaming: context.useStreaming,
    };
}

function buildTransportFromContext(db, context) {
    switch (context.provider) {
        case 'anthropic':
            return buildAnthropicTransport(db, context);
        case 'google':
            return buildGoogleTransport(db, context);
        case 'openai':
        default:
            return buildOpenAITransport(db, context);
    }
}

function findCharacter(db, characterId) {
    return (db.characters || []).find((character) => character?.chaId === characterId) || null;
}

function findChat(character, chatId) {
    return (character.chats || []).find((chat) => chat?.id === chatId)
        || character.chats?.[character.chatPage || 0]
        || character.chats?.[0]
        || null;
}

function buildMessages(db, character, chat, command) {
    const messages = [];
    const system = buildSystemPrompt(db, character);
    if (system) {
        messages.push({ role: 'system', content: system });
    }

    for (const message of chat.message || []) {
        messages.push({
            role: message.role === 'char' ? 'assistant' : 'user',
            content: message.data || '',
        });
    }

    if (command.continue && messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        return messages;
    }

    return messages;
}

function buildSystemPrompt(db, character) {
    const parts = [];
    const mainPrompt = character.systemPrompt?.replaceAll('{{original}}', db.mainPrompt || '') || db.mainPrompt || '';
    if (mainPrompt) {
        parts.push(mainPrompt);
    }
    if (character.desc) {
        parts.push(`Character description:\n${character.desc}`);
    }
    if (character.personality) {
        parts.push(`Personality:\n${character.personality}`);
    }
    if (character.scenario) {
        parts.push(`Scenario:\n${character.scenario}`);
    }
    if (db.globalNote) {
        parts.push(`Global note:\n${db.globalNote}`);
    }
    return parts.filter(Boolean).join('\n\n');
}

function normalizeTemperature(requestValue, dbValue) {
    if (Number.isFinite(requestValue)) {
        return requestValue;
    }
    if (Number.isFinite(dbValue)) {
        return dbValue / 100;
    }
    return 1;
}

function detectProvider(model) {
    const value = String(model || '').toLowerCase();
    if (value.includes('claude')) {
        return 'anthropic';
    }
    if (value.includes('gemini') || value.includes('vertex')) {
        return 'google';
    }
    return 'openai';
}

function resolveModel(db, provider, fallbackModel) {
    if (provider === 'anthropic') {
        return fallbackModel || 'claude-3-5-sonnet-latest';
    }
    if (provider === 'google') {
        return fallbackModel || 'gemini-2.0-flash';
    }
    if (fallbackModel === 'openrouter' && db.openrouterRequestModel) {
        return db.openrouterRequestModel;
    }
    if (fallbackModel === 'reverse_proxy' && db.customProxyRequestModel) {
        return db.customProxyRequestModel;
    }
    return fallbackModel || 'gpt-4o-mini';
}

function buildOpenAITransport(db, context) {
    let url = 'https://api.openai.com/v1/chat/completions';
    let apiKey = db.openAIKey || '';

    if (context.endpointKind === 'mistral-chat') {
        url = 'https://api.mistral.ai/v1/chat/completions';
        apiKey = db.mistralKey || '';
    } else if (String(db.aiModel).startsWith('openrouter')) {
        url = db.forceReplaceUrl || 'https://openrouter.ai/api/v1/chat/completions';
        apiKey = db.openrouterKey || '';
    } else if (db.aiModel === 'reverse_proxy' && db.forceReplaceUrl) {
        url = normalizeCompletionUrl(db.forceReplaceUrl, 'chat/completions');
        apiKey = db.proxyKey || '';
    } else if (String(db.aiModel).startsWith('xcustom:::') && db.customModels) {
        const found = db.customModels.find((model) => model.id === db.aiModel);
        if (found?.url) {
            url = normalizeCompletionUrl(found.url, 'chat/completions');
            apiKey = found.key || '';
        }
    }

    return {
        provider: 'openai',
        url,
        method: 'POST',
        useStreaming: context.useStreaming,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: {
            model: context.model,
            messages: context.messages,
            temperature: context.temperature,
            max_tokens: context.maxTokens,
            stream: context.useStreaming,
            tools: context.tools?.length > 0
                ? context.tools.map((tool) => ({
                    type: 'function',
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                    },
                }))
                : undefined,
        },
    };
}

function buildAnthropicTransport(db, context) {
    const url = (db.aiModel === 'reverse_proxy' && db.forceReplaceUrl)
        ? normalizeCompletionUrl(db.forceReplaceUrl, 'messages')
        : 'https://api.anthropic.com/v1/messages';
    const apiKey = db.aiModel === 'reverse_proxy' ? (db.proxyKey || '') : (db.claudeAPIKey || '');
    const messages = [];
    let system = '';
    for (const message of context.messages) {
        if (message.role === 'system') {
            system += (system ? '\n\n' : '') + message.content;
            continue;
        }
        messages.push({ role: message.role, content: message.content });
    }
    if (messages.length === 0) {
        messages.push({ role: 'user', content: 'Start' });
    }

    return {
        provider: 'anthropic',
        url,
        method: 'POST',
        useStreaming: context.useStreaming,
        batching: Boolean(db.claudeBatching),
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
            'accept': 'application/json',
        },
        body: {
            model: context.model,
            system,
            messages,
            max_tokens: context.maxTokens,
            temperature: context.temperature,
            stream: context.useStreaming,
            tools: context.tools?.length > 0
                ? context.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.inputSchema,
                }))
                : undefined,
        },
    };
}

function buildGoogleTransport(db, context) {
    const apiKey = db.google?.accessToken || '';
    const endpoint = context.useStreaming ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${context.model}:${endpoint}?key=${apiKey}`;
    const contents = [];
    let system = '';
    for (const message of context.messages) {
        if (message.role === 'system') {
            system += (system ? '\n\n' : '') + message.content;
            continue;
        }
        contents.push({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
        });
    }
    return {
        provider: 'google',
        url,
        method: 'POST',
        useStreaming: context.useStreaming,
        headers: {
            'Content-Type': 'application/json',
        },
        body: {
            contents,
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            tools: context.tools?.length > 0
                ? [{
                    functionDeclarations: context.tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                    })),
                }]
                : undefined,
            generation_config: {
                temperature: context.temperature,
                maxOutputTokens: context.maxTokens,
            },
        },
    };
}

function normalizeCompletionUrl(url, suffix) {
    if (!url) {
        return url;
    }
    if (url.endsWith(suffix) || url.endsWith(`${suffix}/`)) {
        return url;
    }
    if (url.endsWith('/v1') || url.endsWith('/v1/')) {
        return `${url.replace(/\/$/, '')}/${suffix}`;
    }
    if (url.endsWith('/')) {
        return `${url}v1/${suffix}`;
    }
    return `${url}/v1/${suffix}`;
}

module.exports = {
    buildGenerationContext,
    buildTransportFromContext,
    buildTransportFromCompiledRequest,
    validateCompiledTransport,
};
