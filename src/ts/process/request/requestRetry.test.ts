import { beforeEach, describe, expect, test, vi } from 'vitest'

// requestChatData's retry loop, with the dispatch target (requestOpenAI) and
// the app seams it touches stubbed out.

const mocks = vi.hoisted(() => ({
    beforeReplacers: new Set<(content: any[], type: string) => any>(),
    requestOpenAI: vi.fn(),
    db: {} as any,
}))

vi.mock('ollama/dist/browser.mjs', () => ({ Ollama: class {} }))
vi.mock('src/ts/globalApi.svelte', () => ({ globalFetch: vi.fn(), fetchNative: vi.fn() }))
vi.mock('../../globalApi.svelte', () => ({ globalFetch: vi.fn(), fetchNative: vi.fn() }))
vi.mock('../../plugins/plugins.svelte', () => ({
    pluginProcess: vi.fn(),
    pluginV2: {
        replacerbeforeRequest: mocks.beforeReplacers,
        replacerafterRequest: new Set(),
        providers: new Map(),
    },
}))
vi.mock('../../storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
    getCurrentCharacter: () => null,
    getCurrentChat: () => null,
}))
vi.mock('../mcp/mcp', () => ({ getTools: async () => [], callTool: vi.fn(), encodeToolCall: vi.fn(), decodeToolCall: vi.fn() }))
vi.mock('../triggers', () => ({ runTrigger: vi.fn() }))
vi.mock('./openAI/requests', () => ({
    requestOpenAI: mocks.requestOpenAI,
    requestOpenAILegacyInstruct: vi.fn(),
    requestOpenAIResponseAPI: vi.fn(),
}))
vi.mock('../../model/modellist', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../model/modellist')>()
    return {
        ...actual,
        getModelInfo: () => ({ id: 'gpt-4o', format: actual.LLMFormat.OpenAICompatible, flags: [actual.LLMFlags.hasFullSystemPrompt] }),
    }
})
vi.mock('./modelPresetBinding', () => ({
    resolveChatModelBinding: () => ({ kind: 'classic' }),
    classicModelIdFor: () => 'gpt-4o',
    buildModelPresetCredential: vi.fn(),
    applyPromptPresetParams: vi.fn(),
    presetSupportsVision: vi.fn(),
}))

import { requestChatData } from './request'

beforeEach(() => {
    mocks.beforeReplacers.clear()
    mocks.requestOpenAI.mockReset()
    mocks.db = { requestRetrys: 2, fallbackModels: {}, maxResponse: 100, temperature: 80, genTime: 1 }
})

describe('requestChatData retries', () => {
    test('before-request replacers see the original messages on every attempt', async () => {
        const seen: string[] = []
        mocks.beforeReplacers.add((formated) => {
            seen.push(formated.map((m: any) => m.content).join('|'))
            return [...formated, { role: 'system', content: 'appended' }]
        })
        mocks.requestOpenAI
            .mockResolvedValueOnce({ type: 'fail', result: 'boom' })
            .mockResolvedValueOnce({ type: 'success', result: 'ok' })

        const res = await requestChatData({
            formated: [{ role: 'user', content: 'hi' }],
            bias: {},
        } as any, 'model')

        expect(res).toMatchObject({ type: 'success', result: 'ok' })
        expect(seen).toEqual(['hi', 'hi'])
        const sent = mocks.requestOpenAI.mock.calls.map((c) => c[0].formated.map((m: any) => m.content))
        expect(sent).toEqual([['hi', 'appended'], ['hi', 'appended']])
    })
})
