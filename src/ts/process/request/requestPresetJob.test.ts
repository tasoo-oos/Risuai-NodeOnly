import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bodyIntercepterStore } from 'src/ts/stores.svelte'

// requestChatData → requestModelPreset on the server-side job transport, with
// the adapter and the job transport stubbed. Pins what the job record is told
// about the live run's post-processing (jobRecovery.ts replays it), and that
// plugin body interceptors see the preset request before it becomes a job.

const mocks = vi.hoisted(() => ({
    afterReplacers: new Set<(content: string, type: string) => any>(),
    jobOpts: [] as any[],
    jobBodies: [] as string[],
    db: {} as any,
    preset: {} as any,
}))

vi.mock('ollama/dist/browser.mjs', () => ({ Ollama: class {} }))
vi.mock('src/ts/globalApi.svelte', () => ({ globalFetch: vi.fn(), fetchNative: vi.fn() }))
vi.mock('../../globalApi.svelte', () => ({ globalFetch: vi.fn(), fetchNative: vi.fn() }))
vi.mock('../../plugins/plugins.svelte', () => ({
    pluginProcess: vi.fn(),
    pluginV2: {
        replacerbeforeRequest: new Set(),
        replacerafterRequest: mocks.afterReplacers,
        providers: new Map(),
    },
}))
vi.mock('../../storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
    getCurrentCharacter: () => null,
    getCurrentChat: () => ({ id: 'chat-1' }),
}))
vi.mock('../mcp/mcp', () => ({ getTools: async () => [], callTool: vi.fn(), encodeToolCall: vi.fn(), decodeToolCall: vi.fn() }))
vi.mock('../triggers', () => ({ runTrigger: vi.fn() }))
vi.mock('./modelPresetBinding', () => ({
    resolveChatModelBinding: () => ({ kind: 'modelPreset', preset: mocks.preset }),
    applyPromptPresetParams: (preset: any) => preset,
    classicModelIdFor: vi.fn(),
    buildModelPresetCredential: () => undefined,
    presetSupportsVision: () => false,
    presetAnthropicCacheTtl: () => '5m',
    resolveClassicFallbackModels: () => [],
}))
vi.mock('src/ts/preset/adapter/wireInvariants', () => ({ resolveWireModelId: () => 'wire-model' }))
vi.mock('src/ts/requestLog', () => ({
    createRequestLogScope: () => ({
        wrap: (f: typeof fetch) => f,
        setRoute: () => {},
        setUsage: () => {},
        setRequestBody: () => {},
        close: async () => {},
    }),
    recordRequestLog: vi.fn(),
    stripInlineMedia: (x: unknown) => x,
}))
vi.mock('./jobFetch', () => ({
    makeJobFetch: (opts: any) => {
        mocks.jobOpts.push(opts)
        return async (_url: string, init: RequestInit) => {
            mocks.jobBodies.push(init.body as string)
            return new Response('{}')
        }
    },
    ModelJobBusyError: class extends Error {},
    ModelJobConnectionLostError: class extends Error {},
}))
// The adapter only has to send one request through the transport it is given
// and report the text; the wire format is covered by the adapter tests.
vi.mock('src/ts/preset/adapter', () => {
    const send = async (_preset: any, options: any) => {
        await options.fetchImpl('https://provider.example/v1/chat', { method: 'POST', body: '{"model":"wire-model"}' })
        return { text: '{x} (y)', reasoning: [] }
    }
    async function* stream(_preset: any, options: any) {
        await options.fetchImpl('https://provider.example/v1/chat', { method: 'POST', body: '{"model":"wire-model"}' })
        yield { textDelta: '{x} ' }
        yield { textDelta: '(y)' }
    }
    return {
        sendChatRequest: send, streamChatRequest: stream, previewChatRequest: vi.fn(),
        sendAnthropicChatRequest: send, streamAnthropicChatRequest: stream, previewAnthropicChatRequest: vi.fn(),
        sendGoogleChatRequest: send, streamGoogleChatRequest: stream, previewGoogleChatRequest: vi.fn(),
        runToolLoop: vi.fn(),
    }
})

import { requestChatData } from './request'

const ESCAPED = '\uE9B8x\uE9B9 \uE9BAy\uE9BB'

function makePreset(overrides: Record<string, unknown> = {}) {
    return {
        id: 'p1',
        name: 'My Preset',
        useStreaming: true,
        profileSnapshot: {
            adapterKind: 'openai-compatible',
            capabilities: ['streaming'],
            providerBaseId: 'openai',
            modelId: 'wire-model',
            auth: { kind: 'bearer' },
        },
        ...overrides,
    }
}

async function run(arg: Record<string, unknown> = {}) {
    return requestChatData({
        formated: [{ role: 'user', content: 'hi' }],
        bias: {},
        realChatId: 'chat-1',
        chatId: 'gen-1',
        ...arg,
    } as any, 'model')
}

beforeEach(() => {
    mocks.afterReplacers.clear()
    mocks.jobOpts.length = 0
    mocks.jobBodies.length = 0
    mocks.db = { nodeOnlyServerSideRequests: true, showRequestStatus: false, requestRetrys: 0, fallbackModels: {} }
    mocks.preset = makePreset()
})

afterEach(() => {
    bodyIntercepterStore.length = 0
})

describe('preset request on the server-job transport', () => {
    test('escapeOutput run: job records the escape, live result is escaped then replaced', async () => {
        mocks.afterReplacers.add(async (content) => `${content}!`)

        const res = await run({ escape: true })

        // escape forces non-streaming, so the live run returns a whole result.
        expect(mocks.jobOpts[0]).toMatchObject({ streaming: false, decoupledStreaming: false, escapeOutput: true })
        expect(res).toMatchObject({ type: 'success', result: `${ESCAPED}!` })
    })

    test('decoupled-streaming run: job records it, live result gets the replacers', async () => {
        mocks.preset = makePreset({ decoupledStreaming: true })
        mocks.afterReplacers.add(async (content) => content.toUpperCase())

        const res = await run()

        expect(mocks.jobOpts[0]).toMatchObject({ streaming: true, decoupledStreaming: true, escapeOutput: false })
        expect(res).toMatchObject({ type: 'success', result: '{X} (Y)' })
    })

    test('plain streaming run: not decoupled, live result is the raw stream', async () => {
        mocks.afterReplacers.add(async (content) => content.toUpperCase())

        const res = await run()

        expect(mocks.jobOpts[0]).toMatchObject({ streaming: true, decoupledStreaming: false })
        expect(res.type).toBe('streaming')
    })

    test('decoupledStreaming is not recorded when the run does not stream', async () => {
        mocks.preset = makePreset({ decoupledStreaming: true, useStreaming: false })

        await run()

        expect(mocks.jobOpts[0]).toMatchObject({ streaming: false, decoupledStreaming: false })
    })

    test('body interceptors rewrite the request before it becomes a job', async () => {
        const types: string[] = []
        bodyIntercepterStore.push({
            id: 'i1',
            callback: (body: any, type: string) => { types.push(type); return { ...body, injected: true } },
        } as any)

        await run({ useStreaming: false })

        expect(types).toEqual(['preset_openai-compatible'])
        expect(JSON.parse(mocks.jobBodies[0])).toEqual({ model: 'wire-model', injected: true })
    })
})
