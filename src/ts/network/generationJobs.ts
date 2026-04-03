import { forageStorage } from '../globalApi.svelte'
import { isNodeServer } from '../platform'

export type GenerationTransportPayload = {
    provider: 'openai' | 'anthropic' | 'google'
    url: string
    body: any
    headers: Record<string, string>
    method?: string
    useStreaming: boolean
}

export type CreateGenerationRequest = {
    characterId: string
    chatId: string
    model?: string
    overrideModel?: string | null
    mode: 'transport' | 'server'
    transport?: GenerationTransportPayload
    useStreaming?: boolean
    continue?: boolean
    requestOptions?: Record<string, any>
}

export type GenerationEvent = {
    type: string
    seq?: number
    jobId?: string
    text?: string
    status?: string
    messageId?: string
    resultText?: string
    error?: string
    ts?: number
}

export type GenerationJobResponse = {
    jobId: string
    messageId?: string | null
    status: string
}

export async function createGenerationJob(request: CreateGenerationRequest): Promise<GenerationJobResponse> {
    ensureNodeServer()
    const headers = await getServerHeaders(true)
    const response = await fetch('/api/generations', {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
    })

    if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Failed to create generation job (${response.status})`)
    }

    return await response.json()
}

export async function cancelGenerationJob(jobId: string): Promise<void> {
    ensureNodeServer()
    const headers = await getServerHeaders(true)
    const response = await fetch(`/api/generations/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers,
    })
    if (!response.ok) {
        throw new Error(`Failed to cancel generation job (${response.status})`)
    }
}

export async function waitForGenerationJob(jobId: string, abortSignal?: AbortSignal): Promise<string> {
    ensureNodeServer()
    return await new Promise<string>(async (resolve, reject) => {
        const auth = await forageStorage.createAuth()
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${wsProtocol}//${location.host}/api/generations/${encodeURIComponent(jobId)}/stream?risu-auth=${encodeURIComponent(auth)}`
        const ws = new WebSocket(wsUrl)
        let acc = ''
        let settled = false

        const cleanup = () => {
            if (abortSignal) {
                abortSignal.removeEventListener('abort', onAbort)
            }
            try { ws.close() } catch {}
        }

        const onAbort = () => {
            if (settled) return
            settled = true
            void cancelGenerationJob(jobId).catch(() => {})
            cleanup()
            reject(new Error('Aborted'))
        }

        if (abortSignal) {
            if (abortSignal.aborted) {
                onAbort()
                return
            }
            abortSignal.addEventListener('abort', onAbort, { once: true })
        }

        ws.onmessage = (message) => {
            const event = parseGenerationEvent(message.data)
            if (!event) return
            if (event.type === 'delta' && event.text) {
                acc += event.text
                return
            }
            if (event.type === 'completed') {
                settled = true
                cleanup()
                resolve(acc || event.resultText || '')
                return
            }
            if (event.type === 'failed' || event.type === 'canceled') {
                settled = true
                cleanup()
                reject(new Error(event.error || `Generation ${event.type}`))
            }
        }

        ws.onerror = () => {
            if (settled) return
            settled = true
            cleanup()
            reject(new Error('Generation stream websocket error'))
        }
    })
}

export async function streamGenerationJob(jobId: string, abortSignal?: AbortSignal): Promise<ReadableStream<{ [key: string]: string }>> {
    ensureNodeServer()
    const auth = await forageStorage.createAuth()
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${location.host}/api/generations/${encodeURIComponent(jobId)}/stream?risu-auth=${encodeURIComponent(auth)}`

    return new ReadableStream<{ [key: string]: string }>({
        start(controller) {
            const ws = new WebSocket(wsUrl)
            let acc = ''
            let closed = false

            const cleanup = () => {
                if (abortSignal) {
                    abortSignal.removeEventListener('abort', onAbort)
                }
                try { ws.close() } catch {}
            }

            const onAbort = () => {
                if (closed) return
                closed = true
                void cancelGenerationJob(jobId).catch(() => {})
                cleanup()
                controller.close()
            }

            if (abortSignal) {
                if (abortSignal.aborted) {
                    onAbort()
                    return
                }
                abortSignal.addEventListener('abort', onAbort, { once: true })
            }

            ws.onmessage = (message) => {
                const event = parseGenerationEvent(message.data)
                if (!event) return
                switch (event.type) {
                    case 'delta':
                        if (event.text) {
                            acc += event.text
                            controller.enqueue({ '0': acc })
                        }
                        break
                    case 'completed':
                        if (!closed) {
                            if (!acc && event.resultText) {
                                acc = event.resultText
                                controller.enqueue({ '0': acc })
                            }
                            closed = true
                            cleanup()
                            controller.close()
                        }
                        break
                    case 'failed':
                    case 'canceled':
                        if (!closed) {
                            closed = true
                            cleanup()
                            controller.error(new Error(event.error || `Generation ${event.type}`))
                        }
                        break
                }
            }

            ws.onerror = () => {
                if (closed) return
                closed = true
                cleanup()
                controller.error(new Error('Generation stream websocket error'))
            }
        },
        cancel() {
            void cancelGenerationJob(jobId).catch(() => {})
        }
    })
}

function parseGenerationEvent(raw: string): GenerationEvent | null {
    try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.type !== 'string') {
            return null
        }
        return parsed
    } catch {
        return null
    }
}

async function getServerHeaders(withBody = false): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
        'risu-auth': await forageStorage.createAuth(),
        'x-session-id': forageStorage.getSessionId(),
    }
    if (withBody) {
        headers['content-type'] = 'application/json'
    }
    return headers
}

function ensureNodeServer() {
    if (!isNodeServer) {
        throw new Error('Generation jobs are only available in Node server mode')
    }
}
