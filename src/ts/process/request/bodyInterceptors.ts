import { bodyIntercepterStore } from 'src/ts/stores.svelte'

type BodyInterceptor = { callback: (body: any, type: string) => any }

function parseJsonBody(body: string): unknown {
    try {
        const parsed = JSON.parse(body)
        return parsed !== null && typeof parsed === 'object' ? parsed : body
    } catch {
        return body
    }
}

function isJsonContainer(value: unknown): value is object {
    if (value === null || typeof value !== 'object') return false
    if (Array.isArray(value)) return true
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

function normalizeOutput(out: unknown): unknown {
    return typeof out === 'string' ? parseJsonBody(out) : out
}

// The plugin API documents the callback as receiving the parsed body object
// (risuai.d.ts), which is what globalFetch has always passed; string-body call
// sites (fetchNative) used to pass the raw JSON string instead, so a plugin
// written to the documented API silently did nothing there. Callbacks now get
// the object everywhere, and one that throws on it is retried once with the
// JSON string so plugins written against the old string behavior keep
// working. A falsy return keeps the current body, matching the old
// `callback(...) || body` contract. Non-JSON bodies (FormData, bytes, a
// non-JSON string) are passed through as-is, with no retry.
async function runInterceptors(
    initial: unknown,
    type: string,
    interceptors: readonly BodyInterceptor[],
): Promise<unknown> {
    let current = initial
    for (const interceptor of interceptors) {
        try {
            const out = await interceptor.callback(current, type)
            if (out) current = normalizeOutput(out)
        } catch (err) {
            if (!isJsonContainer(current)) {
                console.error(err)
                continue
            }
            try {
                const out = await interceptor.callback(JSON.stringify(current), type)
                if (out) current = normalizeOutput(out)
            } catch (retryErr) {
                console.error(retryErr)
            }
        }
    }
    return current
}

// Serialized-body form (fetchNative and the preset transports): the result is
// re-serialized, so the caller always gets a string back.
export async function applyBodyInterceptors(
    body: string,
    type: string,
    interceptors: readonly BodyInterceptor[] = bodyIntercepterStore,
): Promise<string> {
    if (interceptors.length === 0) return body
    const out = await runInterceptors(parseJsonBody(body), type, interceptors)
    return typeof out === 'string' ? out : JSON.stringify(out)
}

// Unserialized-body form (globalFetch, which serializes later): a string body
// stays a string and an object body stays an object unless an interceptor
// returns a non-JSON string.
export async function applyBodyInterceptorsToValue(
    body: unknown,
    type: string,
    interceptors: readonly BodyInterceptor[] = bodyIntercepterStore,
): Promise<unknown> {
    if (interceptors.length === 0) return body
    if (typeof body === 'string') return applyBodyInterceptors(body, type, interceptors)
    return runInterceptors(body, type, interceptors)
}

// fetch wrapper for the model-preset transports (proxied and server-job).
// Adapters call fetchImpl directly and never pass through fetchNative's
// interceptor step, so without this the interceptors never saw a preset
// request. Applied before the request reaches the server job, so the journaled
// and replayed request is the intercepted one.
export function withBodyInterceptors(inner: typeof fetch, type: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (bodyIntercepterStore.length === 0 || typeof init?.body !== 'string') {
            return inner(input, init)
        }
        return inner(input, { ...init, body: await applyBodyInterceptors(init.body, type) })
    }) as typeof fetch
}
