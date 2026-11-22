import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { sendGoogleChatRequest, streamGoogleChatRequest } from 'src/ts/preset/adapter/googleGemini'
import type { ModelPreset } from 'src/ts/preset/types'
import {
    isGoogleRateLimitRetryTarget,
    RATE_LIMIT_RETRY_DELAY_MS,
    withRateLimitRetry,
} from './rateLimitRetry'

const RESOURCE_EXHAUSTED = JSON.stringify({
    error: { code: 429, message: 'Resource exhausted. Please try again later.', status: 'RESOURCE_EXHAUSTED' },
})

function rateLimited(): Response {
    return new Response(RESOURCE_EXHAUSTED, { status: 429, headers: { 'content-type': 'application/json' } })
}

function ok(text = 'hello'): Response {
    return new Response(text, { status: 200 })
}

/** A fetch stub answering from a queue; the last entry repeats. */
function queuedFetch(...responses: (() => Response)[]) {
    let i = 0
    return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
        const make = responses[Math.min(i, responses.length - 1)]
        i++
        return make()
    })
}

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('isGoogleRateLimitRetryTarget', () => {
    test('covers the google-gemini adapter and Vertex OpenAI-compatible', () => {
        expect(isGoogleRateLimitRetryTarget('google-gemini', 'google')).toBe(true)
        expect(isGoogleRateLimitRetryTarget('google-gemini', 'vertex-gemini-native')).toBe(true)
        expect(isGoogleRateLimitRetryTarget('google-gemini', undefined)).toBe(true)
        expect(isGoogleRateLimitRetryTarget('openai-compatible', 'vertex-openai')).toBe(true)
    })

    test('leaves other providers alone', () => {
        expect(isGoogleRateLimitRetryTarget('openai-compatible', 'openai')).toBe(false)
        expect(isGoogleRateLimitRetryTarget('openai-compatible', 'openrouter')).toBe(false)
        expect(isGoogleRateLimitRetryTarget('anthropic-messages', 'anthropic')).toBe(false)
        expect(isGoogleRateLimitRetryTarget('openai-compatible', undefined)).toBe(false)
    })
})

describe('withRateLimitRetry', () => {
    test('passes a non-429 response through untouched with a single call', async () => {
        const base = queuedFetch(() => new Response('bad', { status: 400 }))
        const res = await withRateLimitRetry(base, { delayMs: 0 })('https://x', { method: 'POST' })
        expect(res.status).toBe(400)
        expect(await res.text()).toBe('bad')
        expect(base).toHaveBeenCalledTimes(1)
    })

    test('re-sends after 429 until success, with the same request each time', async () => {
        const base = queuedFetch(rateLimited, rateLimited, rateLimited, () => ok('done'))
        const onRetry = vi.fn()
        const init = { method: 'POST', body: '{"a":1}' }
        const res = await withRateLimitRetry(base, { delayMs: 0, onRetry })('https://x', init)
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('done')
        expect(base).toHaveBeenCalledTimes(4)
        for (const call of base.mock.calls) {
            expect(call[0]).toBe('https://x')
            expect(call[1]).toBe(init)
        }
        expect(onRetry.mock.calls.map((c) => c[0].attempt)).toEqual([2, 3, 4])
    })

    test('waits the same fixed interval before every retry (no exponential backoff)', async () => {
        const sleeps: number[] = []
        const realSetTimeout = globalThis.setTimeout
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
            sleeps.push(ms ?? 0)
            return realSetTimeout(fn, 0)
        }) as typeof setTimeout)
        const base = queuedFetch(rateLimited, rateLimited, rateLimited, rateLimited, () => ok())
        const res = await withRateLimitRetry(base)('https://x', {})
        expect(res.status).toBe(200)
        expect(sleeps).toEqual([
            RATE_LIMIT_RETRY_DELAY_MS, RATE_LIMIT_RETRY_DELAY_MS,
            RATE_LIMIT_RETRY_DELAY_MS, RATE_LIMIT_RETRY_DELAY_MS,
        ])
    })

    test('drains each 429 body instead of abandoning it', async () => {
        const bodies: Response[] = []
        const base = vi.fn(async () => {
            const res = bodies.length < 2 ? rateLimited() : ok()
            bodies.push(res)
            return res
        })
        await withRateLimitRetry(base, { delayMs: 0 })('https://x', {})
        expect(bodies[0].bodyUsed).toBe(true)
        expect(bodies[1].bodyUsed).toBe(true)
    })

    test('returns an equivalent 429 response once the safety cap is reached', async () => {
        const base = queuedFetch(rateLimited)
        const res = await withRateLimitRetry(base, { delayMs: 0, maxAttempts: 5 })('https://x', {})
        expect(base).toHaveBeenCalledTimes(5)
        expect(res.status).toBe(429)
        expect(res.headers.get('content-type')).toBe('application/json')
        expect(await res.text()).toBe(RESOURCE_EXHAUSTED)
    })

    test('stopping during the wait rejects with AbortError and sends nothing more', async () => {
        const controller = new AbortController()
        const base = queuedFetch(rateLimited)
        const onRetry = vi.fn(() => controller.abort())
        const pending = withRateLimitRetry(base, { delayMs: 60_000, onRetry })('https://x', { signal: controller.signal })
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(base).toHaveBeenCalledTimes(1)
    })

    test('an already-aborted signal after a 429 does not retry', async () => {
        const controller = new AbortController()
        const base = vi.fn(async () => {
            controller.abort()
            return rateLimited()
        })
        const pending = withRateLimitRetry(base, { delayMs: 0 })('https://x', { signal: controller.signal })
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(base).toHaveBeenCalledTimes(1)
    })

    test('a throwing onRetry callback does not break the retry', async () => {
        const base = queuedFetch(rateLimited, () => ok())
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const res = await withRateLimitRetry(base, {
            delayMs: 0,
            onRetry: () => { throw new Error('boom') },
        })('https://x', {})
        expect(res.status).toBe(200)
    })
})

// End to end through the Gemini adapter: the wrapper sits on options.fetchImpl
// exactly as requestModelPreset installs it.
describe('Gemini adapter behind withRateLimitRetry', () => {
    const preset: ModelPreset = {
        id: 'preset-google',
        name: 'Gemini',
        profileSnapshot: {
            profileId: 'demo:google',
            profileVersion: 1,
            providerBaseId: 'google',
            providerBaseVersion: 1,
            adapterKind: 'google-gemini',
            auth: { kind: 'x-goog-api-key', fields: ['apiKey'] },
            endpoint: { kind: 'static', url: 'https://demo.test/v1beta/models' },
            modelId: 'gemini-demo',
            schema: [
                { key: 'apiKey', type: 'string', label: 'API Key', secret: true, mapsTo: { target: 'auth', path: 'apiKey' } },
            ],
            uiSchema: { groups: [], fields: [] },
            defaults: {},
            headerTemplate: { 'Content-Type': 'application/json' },
            capabilities: ['streaming'],
        },
        userValues: {},
        createdAt: 0,
        updatedAt: 0,
    }
    const messages = [{ role: 'user' as const, content: 'Hi' }]

    function sse(...chunks: string[]): () => Response {
        return () => new Response(chunks.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }

    test('a stream that hit 429 first still delivers the full answer', async () => {
        const base = queuedFetch(rateLimited, rateLimited, sse(
            'data: {"candidates":[{"content":{"parts":[{"text":"He"}],"role":"model"}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[{"text":"llo"}],"role":"model"}}]}\n\n',
        ))
        const text: string[] = []
        for await (const delta of streamGoogleChatRequest(preset, {
            messages, fetchImpl: withRateLimitRetry(base, { delayMs: 0 }),
        }, { apiKey: 'k' })) {
            if (delta.textDelta) text.push(delta.textDelta)
        }
        expect(text.join('')).toBe('Hello')
        expect(base).toHaveBeenCalledTimes(3)
    })

    test('after the cap the adapter still reports a rate-limit error with the provider message', async () => {
        const base = queuedFetch(rateLimited)
        await expect(sendGoogleChatRequest(preset, {
            messages, fetchImpl: withRateLimitRetry(base, { delayMs: 0, maxAttempts: 3 }),
        }, { apiKey: 'k' })).rejects.toMatchObject({
            kind: 'rate-limit',
            status: 429,
            message: 'Resource exhausted. Please try again later.',
        })
        expect(base).toHaveBeenCalledTimes(3)
    })
})
