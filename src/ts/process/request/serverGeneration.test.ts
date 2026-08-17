import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../platform', () => ({
    isNodeServer: true,
}))

vi.mock('../../storage/database.svelte', () => ({
    getCurrentCharacter: () => ({ chaId: 'char1' }),
    getCurrentChat: () => ({ id: 'chat1' }),
}))

vi.mock('../../model/modellist', async () => {
    const actual = await vi.importActual<typeof import('../../model/types')>('../../model/types')
    return {
        LLMFormat: actual.LLMFormat,
    }
})

vi.mock('../../network/generationJobs', () => ({
    createGenerationJob: vi.fn(async () => ({ jobId: 'job-1', messageId: 'msg-1', status: 'queued' })),
    streamGenerationJob: vi.fn(async () => new ReadableStream()),
    waitForGenerationJob: vi.fn(async () => 'server-result'),
}))

vi.mock('./anthropic', () => ({
    requestClaude: vi.fn(),
}))

vi.mock('./google', () => ({
    requestGoogleCloudVertex: vi.fn(),
}))

vi.mock('./openAI/requests', () => ({
    requestOpenAI: vi.fn(),
    requestOpenAILegacyInstruct: vi.fn(),
    requestOpenAIResponseAPI: vi.fn(),
}))

import { LLMFormat } from '../../model/types'
import { requestClaude } from './anthropic'
import { createGenerationJob } from '../../network/generationJobs'
import { tryServerGenerationTransport } from './serverGeneration'
import type { RequestDataArgumentExtended } from './request'
import type { ModelModeExtended } from './shared'

const makeArg = (mode?:ModelModeExtended):RequestDataArgumentExtended => ({
    formated: [],
    bias: {},
    aiModel: 'claude-3-5-sonnet',
    useStreaming: false,
    continue: false,
    temperature: 0.7,
    maxTokens: 512,
    mode,
    modelInfo: {
        id: 'claude-3-5-sonnet',
        internalID: 'claude-3-5-sonnet-20241022',
        format: LLMFormat.Anthropic,
        flags: [],
        parameters: {},
    } as any,
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('tryServerGenerationTransport transport-mode preview parsing', () => {
    it('fails explicitly when the preview result is not valid JSON', async () => {
        vi.mocked(requestClaude).mockResolvedValue({
            type: 'success',
            result: 'this is not json',
        } as any)

        const res = await tryServerGenerationTransport(makeArg(), LLMFormat.Anthropic)

        expect(res).toEqual({
            type: 'fail',
            result: 'Failed to parse server transport preview',
        })
        expect(createGenerationJob).not.toHaveBeenCalled()
    })

    it('fails explicitly when the preview JSON is missing required fields', async () => {
        vi.mocked(requestClaude).mockResolvedValue({
            type: 'success',
            result: JSON.stringify({ body: { max_tokens: 512 } }),
        } as any)

        const res = await tryServerGenerationTransport(makeArg(), LLMFormat.Anthropic)

        expect(res).toEqual({
            type: 'fail',
            result: 'Failed to parse server transport preview',
        })
        expect(createGenerationJob).not.toHaveBeenCalled()
    })

    it('still surfaces provider preview failures explicitly', async () => {
        vi.mocked(requestClaude).mockResolvedValue({
            type: 'fail',
            result: 'provider preview error',
        } as any)

        const res = await tryServerGenerationTransport(makeArg(), LLMFormat.Anthropic)

        expect(res).toEqual({
            type: 'fail',
            result: 'provider preview error',
        })
        expect(createGenerationJob).not.toHaveBeenCalled()
    })

    it('creates a transport job from a valid preview', async () => {
        vi.mocked(requestClaude).mockResolvedValue({
            type: 'success',
            result: JSON.stringify({
                url: 'https://api.anthropic.com/v1/messages',
                body: { max_tokens: 512 },
                headers: { 'x-api-key': 'key' },
            }),
        } as any)

        const res = await tryServerGenerationTransport(makeArg(), LLMFormat.Anthropic)

        expect(createGenerationJob).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'transport',
            transport: expect.objectContaining({
                provider: 'anthropic',
                url: 'https://api.anthropic.com/v1/messages',
                body: { max_tokens: 512 },
                headers: { 'x-api-key': 'key' },
                method: 'POST',
                useStreaming: false,
            }),
        }))
        expect(res).toMatchObject({ type: 'success', result: 'server-result' })
    })
})

describe('tryServerGenerationTransport model-mode compiled preview fallback', () => {
    it('falls back to the server builder when the compiled preview is malformed', async () => {
        vi.mocked(requestClaude).mockResolvedValue({
            type: 'success',
            result: 'this is not json',
        } as any)

        const res = await tryServerGenerationTransport(makeArg('model'), LLMFormat.Anthropic)

        expect(createGenerationJob).toHaveBeenCalledTimes(1)
        expect(createGenerationJob).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'server',
            compiledTransport: undefined,
        }))
        expect(res).toMatchObject({ type: 'success', result: 'server-result' })
    })

    it('passes the compiled transport through when the preview is valid', async () => {
        vi.mocked(requestClaude).mockResolvedValue({
            type: 'success',
            result: JSON.stringify({
                url: 'https://api.anthropic.com/v1/messages',
                body: { max_tokens: 512, stream: false },
                headers: { 'x-api-key': 'key' },
            }),
        } as any)

        const res = await tryServerGenerationTransport(makeArg('model'), LLMFormat.Anthropic)

        expect(createGenerationJob).toHaveBeenCalledTimes(1)
        expect(createGenerationJob).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'server',
            compiledTransport: {
                provider: 'anthropic',
                endpointKind: 'anthropic-messages',
                model: 'claude-3-5-sonnet-20241022',
                body: { max_tokens: 512, stream: false },
                useStreaming: false,
            },
        }))
        expect(res).toMatchObject({ type: 'success', result: 'server-result' })
    })
})
