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

// Runs the plugin body interceptors (registerBodyIntercepter) over a JSON
// request body that is already serialized. The plugin API documents the
// callback as receiving the parsed body object (risuai.d.ts), which is what
// globalFetch has always passed; string-body call sites (fetchNative) used to
// pass the raw JSON string instead, so a plugin written to the documented API
// silently did nothing there. Callbacks now get the object, and one that throws
// on it is retried once with the string form so plugins written against the
// old string behavior keep working. A falsy return keeps the current body,
// matching the old `callback(...) || body` contract.
export async function applyBodyInterceptors(
    body: string,
    type: string,
    interceptors: readonly BodyInterceptor[] = bodyIntercepterStore,
): Promise<string> {
    if (interceptors.length === 0) return body
    let current = parseJsonBody(body)
    for (const interceptor of interceptors) {
        try {
            const out = await interceptor.callback(current, type)
            if (out) current = typeof out === 'string' ? parseJsonBody(out) : out
        } catch (err) {
            if (typeof current === 'string') {
                console.error(err)
                continue
            }
            try {
                const out = await interceptor.callback(JSON.stringify(current), type)
                if (out) current = typeof out === 'string' ? parseJsonBody(out) : out
            } catch (retryErr) {
                console.error(retryErr)
            }
        }
    }
    return typeof current === 'string' ? current : JSON.stringify(current)
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
