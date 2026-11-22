// Fixed-interval retry for HTTP 429 on Google model presets.
//
// Google AI Studio and Vertex AI answer 429 RESOURCE_EXHAUSTED when shared
// capacity is busy, not only when the caller's own quota runs out. Such a 429
// usually clears within seconds, so the request is re-sent at a FIXED interval
// (deliberately no exponential backoff) until it succeeds, the user stops it,
// or a safety cap is reached.
//
// The wrapper sits at the fetch seam, so it covers streaming, non-streaming
// and tool-loop requests alike: a 429 arrives before any output, so re-sending
// can neither duplicate streamed text nor re-run a tool.

/** Wait between attempts. Fixed: every retry waits the same time. */
export const RATE_LIMIT_RETRY_DELAY_MS = 2000
/** Safety cap on total attempts (first send included), about two minutes of
 *  waiting at the default delay, so a quota that is really exhausted still
 *  surfaces as an error instead of spinning out of sight. */
export const RATE_LIMIT_MAX_ATTEMPTS = 60

// Model-preset providers that answer 429 for transient capacity: AI Studio and
// Vertex Gemini (google-gemini adapter), and Vertex through its OpenAI-
// compatible endpoint.
const GOOGLE_PROVIDER_BASE_IDS = new Set(['google', 'vertex-gemini-native', 'vertex-openai'])

export function isGoogleRateLimitRetryTarget(adapterKind: string, providerBaseId: string | undefined): boolean {
    return adapterKind === 'google-gemini' || (!!providerBaseId && GOOGLE_PROVIDER_BASE_IDS.has(providerBaseId))
}

export interface RateLimitRetryOptions {
    delayMs?: number
    maxAttempts?: number
    /** Called before each re-send wait. `attempt` is the number of the next
     *  attempt (2 for the first retry). */
    onRetry?: (info: { attempt: number, status: number, delayMs: number }) => void
}

function abortError(): DOMException {
    return new DOMException('The operation was aborted.', 'AbortError')
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError())
            return
        }
        const onAbort = () => {
            clearTimeout(timer)
            reject(abortError())
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

export function withRateLimitRetry(base: typeof fetch, options: RateLimitRetryOptions = {}): typeof fetch {
    const delayMs = options.delayMs ?? RATE_LIMIT_RETRY_DELAY_MS
    const maxAttempts = Math.max(1, options.maxAttempts ?? RATE_LIMIT_MAX_ATTEMPTS)
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal ?? undefined
        for (let attempt = 1; ; attempt++) {
            const response = await base(input, init)
            if (response.status !== 429) return response
            // Read the 429 body to the end instead of cancelling it. Over a
            // server-side job transport, reaching the end of the stream is
            // what marks the job collected; an abandoned body would leave it
            // for boot recovery to insert as an error message.
            let bodyText = ''
            try {
                bodyText = await response.text()
            } catch (err) {
                if (signal?.aborted) throw abortError()
                throw err
            }
            if (signal?.aborted) throw abortError()
            if (attempt >= maxAttempts) {
                // Hand the adapter an equivalent response so its usual error
                // classification (rate-limit) and message extraction apply.
                const contentType = response.headers.get('content-type')
                return new Response(bodyText, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: contentType ? { 'content-type': contentType } : undefined,
                })
            }
            console.warn(`[ModelPreset] HTTP 429 from provider, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`)
            try {
                options.onRetry?.({ attempt: attempt + 1, status: response.status, delayMs })
            } catch (err) {
                console.error('[ModelPreset] rate-limit retry callback failed', err)
            }
            await sleepAbortable(delayMs, signal)
        }
    }) as typeof fetch
}
