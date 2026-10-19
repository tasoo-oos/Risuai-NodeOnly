import { afterEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    store: [] as { callback: (body: any, type: string) => any }[],
}))

vi.mock('src/ts/stores.svelte', () => ({
    bodyIntercepterStore: mocks.store,
}))

import { applyBodyInterceptors, withBodyInterceptors } from './bodyInterceptors'

afterEach(() => {
    mocks.store.length = 0
})

describe('applyBodyInterceptors', () => {
    test('no interceptors returns the body untouched', async () => {
        const body = '{ "a" : 1 }'
        expect(await applyBodyInterceptors(body, 'openai_streaming', [])).toBe(body)
    })

    test('callback receives the parsed object, as the plugin API documents', async () => {
        const seen: unknown[] = []
        const out = await applyBodyInterceptors('{"model":"m","temperature":1}', 'openai_streaming', [{
            callback: (body, type) => {
                seen.push(typeof body, type)
                body.temperature = 0.5
                return body
            },
        }])
        expect(seen).toEqual(['object', 'openai_streaming'])
        expect(JSON.parse(out)).toEqual({ model: 'm', temperature: 0.5 })
    })

    test('a callback written against the string body is retried with the string', async () => {
        const out = await applyBodyInterceptors('{"model":"old"}', 'anthropic_streaming', [{
            callback: (body: string) => body.replace('old', 'new'),
        }])
        expect(JSON.parse(out)).toEqual({ model: 'new' })
    })

    test('falsy return keeps the body; in-place mutation is kept', async () => {
        const out = await applyBodyInterceptors('{"a":1}', 't', [
            { callback: () => undefined },
            { callback: (body) => { body.b = 2 } },
        ])
        expect(JSON.parse(out)).toEqual({ a: 1, b: 2 })
    })

    test('chained interceptors see the previous output, string or object', async () => {
        const out = await applyBodyInterceptors('{"n":1}', 't', [
            { callback: () => '{"n":2}' },
            { callback: (body) => ({ n: body.n + 1 }) },
        ])
        expect(JSON.parse(out)).toEqual({ n: 3 })
    })

    test('a callback that fails both ways is skipped', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const out = await applyBodyInterceptors('{"a":1}', 't', [
            { callback: () => { throw new Error('boom') } },
            { callback: (body) => ({ ...body, ok: true }) },
        ])
        expect(JSON.parse(out)).toEqual({ a: 1, ok: true })
        errorSpy.mockRestore()
    })

    test('a non-JSON body is passed through as a string', async () => {
        const out = await applyBodyInterceptors('a=1&b=2', 't', [
            { callback: (body) => `${body}&c=3` },
        ])
        expect(out).toBe('a=1&b=2&c=3')
    })
})

describe('withBodyInterceptors', () => {
    test('intercepts string bodies with the given type before the inner fetch', async () => {
        const inner = vi.fn(async () => new Response('ok'))
        const types: string[] = []
        mocks.store.push({ callback: (body, type) => { types.push(type); return { ...body, injected: true } } })

        await withBodyInterceptors(inner as typeof fetch, 'preset_openai-compatible')('https://x/v1', {
            method: 'POST',
            headers: { a: 'b' },
            body: '{"model":"m"}',
        })

        expect(types).toEqual(['preset_openai-compatible'])
        const init = (inner.mock.calls[0] as unknown[])[1] as RequestInit
        expect(JSON.parse(init.body as string)).toEqual({ model: 'm', injected: true })
        expect(init.headers).toEqual({ a: 'b' })
    })

    test('passes through untouched without interceptors or with a non-string body', async () => {
        const inner = vi.fn(async () => new Response('ok'))
        const wrapped = withBodyInterceptors(inner as typeof fetch, 't')
        const init = { method: 'POST', body: '{"a":1}' }
        await wrapped('https://x', init)
        expect((inner.mock.calls[0] as unknown[])[1]).toBe(init)

        mocks.store.push({ callback: () => ({ changed: true }) })
        const bytes = new Uint8Array([1, 2])
        const binInit = { method: 'POST', body: bytes }
        await wrapped('https://x', binInit)
        expect((inner.mock.calls[1] as unknown[])[1]).toBe(binInit)
    })
})
