import { parseAnthropicMessage, type AdapterChatResponse, type AdapterPreparedRequest, type AdapterUsage } from 'src/ts/preset/adapter'
import type { ProviderJobResult, ProviderJobStatus, ProviderRequestJob } from './providerJob'
import { formatReasoningParts } from 'src/ts/preset/adapter/reasoning'
import { recordRequestLog, stripInlineMedia, type RequestLogRoute, type RequestLogSource } from 'src/ts/requestLog'

export const DEFAULT_ANTHROPIC_BATCH_POLL_MS = 3_000
export const DEFAULT_ANTHROPIC_BATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000 + 10 * 60 * 1000

interface AnthropicBatchJobOptions {
    pollMs?: number
    timeoutMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    /** Receives the batch's request-log rows (see AnthropicBatchRequestLog). */
    onRequestLog?: (entry: AnthropicBatchRequestLog) => void
    /** When the create-batch request was sent; defaults to job construction. */
    submittedAt?: number
}

export interface AnthropicBatchSubmitOptions extends AnthropicBatchJobOptions {
    prepared: AdapterPreparedRequest
    fetchImpl: typeof fetch
    signal?: AbortSignal
    customId: string
}

export type AnthropicBatchSubmitResult =
    | { ok: true; job: AnthropicBatchJob }
    | { ok: false; error: string }

export type AnthropicBatchMessageResult =
    | { type: 'success'; response: AdapterChatResponse }
    | { type: 'fail'; result: string }
    | { type: 'canceled'; result?: string }

// Request-log rows for a batch. A batch is a create POST, a status poll every
// few seconds for up to 24h, and a results GET; polls and cancel calls are not
// logged, since they would bury the generation and the per-message viewer
// shows only a generation's latest row. Two rows are written:
//  - 'submit', as soon as the create-batch call returns: the submitted body and
//    Anthropic's acknowledgement (which carries the msgbatch_ id). A batch is
//    billed once accepted, so this row exists even if the tab closes or the
//    caller never waits for the result.
//  - 'result', when the batch reaches a final outcome: the batch's URL (with
//    its id) and the results JSONL as the response body. It repeats the
//    submitted body so the viewer's latest row shows the request and its
//    answer together. Its duration spans the whole batch.
export interface AnthropicBatchRequestLog {
    phase: 'submit' | 'result'
    startedAt: number
    durationMs: number
    url: string
    method: 'POST' | 'GET'
    requestHeaders: Record<string, string>
    requestBody: string
    status?: number
    success: boolean
    aborted: boolean
    responseBody?: string
    responseType?: string
    errorMessage?: string
    usage?: AdapterUsage
}

export interface AnthropicBatchPreviewRequest {
    url: string
    body: { requests: { custom_id: string; params: AdapterPreparedRequest['body'] }[] }
    headers: Record<string, string>
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatAnthropicResponse(response: AdapterChatResponse): string {
    return formatReasoningParts(response.reasoning) + response.text
}

export async function safeJson(response: Response): Promise<unknown> {
    try {
        return await response.json()
    } catch {
        return undefined
    }
}

export async function safeResponseText(response: Response): Promise<string> {
    try {
        return await response.text()
    } catch (e) {
        return e instanceof Error ? e.message : String(e)
    }
}

function emitRequestLog(
    onRequestLog: ((entry: AnthropicBatchRequestLog) => void) | undefined,
    entry: AnthropicBatchRequestLog,
): void {
    if (!onRequestLog) return
    try {
        onRequestLog(entry)
    } catch (e) {
        // Logging must never affect the request.
        console.error('[ModelPreset] Anthropic batch logging failed', e)
    }
}

export interface AnthropicBatchRequestLoggerInit {
    source: RequestLogSource
    /** Generation key the per-message log viewer looks rows up by. */
    genId: string
    model: string
    provider: string
    /** The transport fetchNative last used (direct or proxy). */
    route: () => RequestLogRoute | undefined
}

// Sends batch rows to the server request log (save/request-logs.db). The
// batch path cannot use the transport-wrapping log scope, which would record
// every status poll and file the create-batch acknowledgement as the answer.
// Headers go through as-is; the server masks credentials on ingest, as it
// does for every other row.
export function createAnthropicBatchRequestLogger(
    init: AnthropicBatchRequestLoggerInit,
): (entry: AnthropicBatchRequestLog) => void {
    return (entry) => {
        recordRequestLog({
            timestamp: entry.startedAt,
            category: 'llm',
            source: init.source,
            chatId: init.genId,
            generationId: init.genId,
            model: init.model,
            provider: init.provider,
            url: entry.url,
            method: entry.method,
            status: entry.status,
            success: entry.success,
            aborted: entry.aborted,
            route: init.route(),
            streaming: false,
            durationMs: entry.durationMs,
            requestHeaders: JSON.stringify(entry.requestHeaders),
            requestBody: stripInlineMedia(entry.requestBody),
            responseBody: entry.responseBody === undefined ? undefined : stripInlineMedia(entry.responseBody.trim()),
            responseType: entry.responseType,
            errorMessage: entry.errorMessage,
            inputTokens: entry.usage?.promptTokens,
            outputTokens: entry.usage?.completionTokens,
            cachedTokens: entry.usage?.cachedTokens,
            reasoningTokens: entry.usage?.reasoningTokens,
        })
    }
}

export function anthropicBatchBaseUrl(messagesUrl: string): string {
    const clean = messagesUrl.replace(/\/?$/, '')
    return clean.endsWith('/messages') ? `${clean}/batches` : `${clean}/messages/batches`
}

export function toAnthropicBatchParams(body: AdapterPreparedRequest['body']): AdapterPreparedRequest['body'] {
    const params = { ...body }
    delete params.service_tier
    delete params.stream
    return params
}

export function anthropicBatchSubmitBody(prepared: AdapterPreparedRequest, customId: string): string {
    return JSON.stringify({
        requests: [{ custom_id: customId, params: toAnthropicBatchParams(prepared.body) }],
    })
}

export function previewAnthropicBatchRequest(
    prepared: AdapterPreparedRequest,
    customId = 'preview',
): AnthropicBatchPreviewRequest {
    const params = toAnthropicBatchParams(prepared.body)
    return {
        url: anthropicBatchBaseUrl(prepared.url),
        body: { requests: [{ custom_id: customId, params }] },
        headers: prepared.headers,
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseBatchStatus(payload: unknown): string | undefined {
    if (!isRecord(payload)) return undefined
    return typeof payload.processing_status === 'string' ? payload.processing_status : undefined
}

export class AnthropicBatchJob implements ProviderRequestJob {
    readonly provider = 'anthropic'
    readonly kind = 'message-batch'
    readonly createdAt: number
    private status: ProviderJobStatus = { state: 'submitted', message: 'Batch submitted' }
    private cancelRequested = false
    private readonly pollMs: number
    private readonly timeoutMs: number
    private readonly sleep: (ms: number) => Promise<void>
    private readonly now: () => number
    private readonly onRequestLog?: (entry: AnthropicBatchRequestLog) => void
    private readonly submittedAt: number
    private requestLogged = false
    // HTTP details of the response that decided the outcome (results, or a
    // failed status poll), for the request log.
    private finalResponse?: { url: string; status: number; body: string; type?: string }
    private finalUsage?: AdapterUsage

    constructor(
        readonly id: string,
        private readonly prepared: AdapterPreparedRequest,
        private readonly batchId: string,
        private readonly fetchImpl: typeof fetch,
        options: AnthropicBatchJobOptions = {},
    ) {
        this.pollMs = options.pollMs ?? DEFAULT_ANTHROPIC_BATCH_POLL_MS
        this.timeoutMs = options.timeoutMs ?? DEFAULT_ANTHROPIC_BATCH_TIMEOUT_MS
        this.sleep = options.sleep ?? defaultSleep
        this.now = options.now ?? Date.now
        this.onRequestLog = options.onRequestLog
        this.createdAt = this.now()
        this.submittedAt = options.submittedAt ?? this.createdAt
    }

    getStatus(): ProviderJobStatus {
        return this.status
    }

    private setStatus(status: ProviderJobStatus, onStatus?: (status: ProviderJobStatus) => void): void {
        this.status = status
        onStatus?.(status)
    }

    async cancel(): Promise<void> {
        if (this.cancelRequested) return
        this.cancelRequested = true
        this.setStatus({ state: 'cancel-requested', message: 'Cancel requested; waiting for final batch state' })
        try {
            await this.fetchImpl(this.cancelUrl(), {
                method: 'POST',
                headers: this.prepared.headers,
                body: '{}',
            })
        } catch (e) {
            console.error('[ModelPreset] Anthropic batch cancel failed', e)
        }
    }

    async wait(options: { signal?: AbortSignal | null; onStatus?: (status: ProviderJobStatus) => void } = {}): Promise<ProviderJobResult> {
        const response = await this.waitForResponse(options)
        if (response.type !== 'success') return response
        return { type: 'success', result: formatAnthropicResponse(response.response) }
    }

    async waitForResponse(options: { signal?: AbortSignal | null; onStatus?: (status: ProviderJobStatus) => void } = {}): Promise<AnthropicBatchMessageResult> {
        let result: AnthropicBatchMessageResult
        try {
            result = await this.pollForResponse(options)
        } catch (e) {
            this.recordRequestLog({ type: 'fail', result: e instanceof Error ? e.message : String(e) }, options.signal)
            throw e
        }
        this.recordRequestLog(result, options.signal)
        return result
    }

    private recordRequestLog(result: AnthropicBatchMessageResult, signal?: AbortSignal | null): void {
        if (this.requestLogged) return
        this.requestLogged = true
        const success = result.type === 'success'
        emitRequestLog(this.onRequestLog, {
            phase: 'result',
            startedAt: this.submittedAt,
            durationMs: Math.max(0, this.now() - this.submittedAt),
            url: this.finalResponse?.url ?? this.statusUrl(),
            method: 'GET',
            requestHeaders: this.prepared.headers,
            requestBody: anthropicBatchSubmitBody(this.prepared, this.id),
            status: this.finalResponse?.status,
            success,
            aborted: result.type === 'canceled' || (!success && (this.cancelRequested || signal?.aborted === true)),
            responseBody: this.finalResponse?.body,
            responseType: this.finalResponse?.type,
            errorMessage: success ? undefined : result.result,
            usage: success ? this.finalUsage : undefined,
        })
    }

    private async pollForResponse(options: { signal?: AbortSignal | null; onStatus?: (status: ProviderJobStatus) => void }): Promise<AnthropicBatchMessageResult> {
        const startedAt = this.now()
        const abortHandler = () => {
            this.setStatus({ state: 'cancel-requested', message: 'Cancel requested; waiting for final batch state' }, options.onStatus)
            void this.cancel()
        }
        options.signal?.addEventListener('abort', abortHandler, { once: true })
        try {
            if (options.signal?.aborted && !this.cancelRequested) {
                await this.cancel()
            }
            while (true) {
                if (this.now() - startedAt > this.timeoutMs) {
                    const message = 'Anthropic batch request timed out'
                    this.setStatus({ state: 'failed', message }, options.onStatus)
                    return { type: 'fail', result: message }
                }

                let statusRes: Response
                try {
                    statusRes = await this.fetchImpl(this.statusUrl(), {
                        method: 'GET',
                        headers: this.prepared.headers,
                        signal: this.cancelRequested ? undefined : options.signal ?? undefined,
                    })
                } catch (e) {
                    if (options.signal?.aborted || this.cancelRequested) {
                        await this.sleep(this.pollMs)
                        continue
                    }
                    return { type: 'fail', result: e instanceof Error ? e.message : String(e) }
                }

                if (!statusRes.ok) {
                    const message = await safeResponseText(statusRes)
                    this.finalResponse = {
                        url: this.statusUrl(),
                        status: statusRes.status,
                        body: message,
                        type: statusRes.headers.get('content-type') ?? undefined,
                    }
                    this.setStatus({ state: 'failed', message }, options.onStatus)
                    return { type: 'fail', result: message }
                }

                const processingStatus = parseBatchStatus(await safeJson(statusRes))
                if (!processingStatus) {
                    const message = 'Invalid Anthropic batch status response'
                    this.setStatus({ state: 'failed', message }, options.onStatus)
                    return { type: 'fail', result: message }
                }
                if (processingStatus !== 'ended') {
                    this.setStatus({
                        state: this.cancelRequested ? 'cancel-requested' : 'running',
                        message: `Anthropic batch ${processingStatus}`,
                    }, options.onStatus)
                    await this.sleep(this.pollMs)
                    continue
                }

                try {
                    return await this.readResponseResult(options.onStatus)
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e)
                    this.setStatus({ state: 'failed', message }, options.onStatus)
                    return { type: 'fail', result: message }
                }
            }
        } finally {
            options.signal?.removeEventListener('abort', abortHandler)
        }
    }

    private async readResponseResult(onStatus?: (status: ProviderJobStatus) => void): Promise<AnthropicBatchMessageResult> {
        const batchRes = await this.fetchImpl(this.resultsUrl(), {
            method: 'GET',
            headers: this.prepared.headers,
        })
        const body = await safeResponseText(batchRes)
        this.finalResponse = {
            url: this.resultsUrl(),
            status: batchRes.status,
            body,
            type: batchRes.headers.get('content-type') ?? undefined,
        }
        if (!batchRes.ok) {
            this.setStatus({ state: 'failed', message: body }, onStatus)
            return { type: 'fail', result: body }
        }

        const lines = body.split('\n').filter((line) => line.trim().length > 0)
        for (const line of lines) {
            let batchData: unknown
            try {
                batchData = JSON.parse(line)
            } catch {
                continue
            }
            if (!isRecord(batchData) || !isRecord(batchData.result)) continue
            const result = batchData.result
            const resultType = typeof result.type === 'string' ? result.type : undefined
            switch (resultType) {
                case 'succeeded': {
                    const response = parseAnthropicMessage(result.message)
                    this.finalUsage = response.usage
                    this.setStatus({ state: 'succeeded', message: 'Anthropic batch completed' }, onStatus)
                    return { type: 'success', response }
                }
                case 'errored': {
                    const error = isRecord(result.error) ? result.error : undefined
                    const innerError = error && isRecord(error.error) ? error.error : undefined
                    const message = typeof innerError?.message === 'string'
                        ? `${typeof innerError.type === 'string' ? `${innerError.type}: ` : ''}${innerError.message}`
                        : error ? JSON.stringify(error) : 'Anthropic batch errored'
                    this.setStatus({ state: 'failed', message }, onStatus)
                    return { type: 'fail', result: message }
                }
                case 'canceled':
                    this.setStatus({ state: 'canceled', message: 'Anthropic batch canceled' }, onStatus)
                    return { type: 'canceled', result: 'Anthropic batch canceled' }
                case 'expired':
                    this.setStatus({ state: 'expired', message: 'Anthropic batch expired' }, onStatus)
                    return { type: 'fail', result: 'Anthropic batch request expired' }
            }
        }
        const message = 'No Anthropic batch result found'
        this.setStatus({ state: 'failed', message }, onStatus)
        return { type: 'fail', result: message }
    }

    private batchBaseUrl(): string {
        return anthropicBatchBaseUrl(this.prepared.url)
    }

    private statusUrl(): string {
        return `${this.batchBaseUrl()}/${encodeURIComponent(this.batchId)}`
    }

    private resultsUrl(): string {
        return `${this.statusUrl()}/results`
    }

    private cancelUrl(): string {
        return `${this.statusUrl()}/cancel`
    }
}

export async function submitAnthropicBatchJob(options: AnthropicBatchSubmitOptions): Promise<AnthropicBatchSubmitResult> {
    const batchUrl = anthropicBatchBaseUrl(options.prepared.url)
    const requestBody = anthropicBatchSubmitBody(options.prepared, options.customId)
    const now = options.now ?? Date.now
    const submittedAt = now()
    // Logged on every outcome: an accepted batch is billed even if nothing
    // ever waits for it, and a rejected one shows Anthropic's error.
    const logSubmit = (outcome: { success: boolean; error?: string; status?: number; body?: string; type?: string; aborted?: boolean }) => {
        emitRequestLog(options.onRequestLog, {
            phase: 'submit',
            startedAt: submittedAt,
            durationMs: Math.max(0, now() - submittedAt),
            url: batchUrl,
            method: 'POST',
            requestHeaders: options.prepared.headers,
            requestBody,
            status: outcome.status,
            success: outcome.success,
            aborted: outcome.aborted === true,
            responseBody: outcome.body,
            responseType: outcome.type,
            errorMessage: outcome.error,
        })
    }
    let response: Response
    try {
        response = await options.fetchImpl(batchUrl, {
            method: 'POST',
            headers: options.prepared.headers,
            body: requestBody,
            signal: options.signal,
        })
    } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        logSubmit({ success: false, error, aborted: (e as Error)?.name === 'AbortError' })
        return { ok: false, error }
    }
    const responseText = await safeResponseText(response)
    const responseType = response.headers.get('content-type') ?? undefined
    if (!response.ok) {
        logSubmit({ success: false, error: responseText, status: response.status, body: responseText, type: responseType })
        return { ok: false, error: responseText }
    }
    let payload: unknown
    try {
        payload = JSON.parse(responseText)
    } catch {
        payload = undefined
    }
    if (!isRecord(payload) || typeof payload.id !== 'string' || payload.id.length === 0) {
        const error = 'No batch id returned from Anthropic batch request'
        logSubmit({ success: false, error, status: response.status, body: responseText, type: responseType })
        return { ok: false, error }
    }
    logSubmit({ success: true, status: response.status, body: responseText, type: responseType })
    const jobOptions: AnthropicBatchJobOptions = {
        pollMs: options.pollMs,
        timeoutMs: options.timeoutMs,
        sleep: options.sleep,
        now: options.now,
        onRequestLog: options.onRequestLog,
        submittedAt,
    }
    return {
        ok: true,
        job: new AnthropicBatchJob(options.customId, options.prepared, payload.id, options.fetchImpl, jobOptions),
    }
}
