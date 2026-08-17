import { createGenerationJob, streamGenerationJob, waitForGenerationJob, type CompiledGenerationTransport } from '../../network/generationJobs'
import { isNodeServer } from '../../platform'
import { getCurrentCharacter, getCurrentChat } from '../../storage/database.svelte'
import { LLMFormat } from '../../model/modellist'
import { requestClaude } from './anthropic'
import { requestGoogleCloudVertex } from './google'
import { requestOpenAI, requestOpenAILegacyInstruct, requestOpenAIResponseAPI } from './openAI/requests'
import type { RequestDataArgumentExtended, requestDataResponse } from './request'

export async function tryServerGenerationTransport(arg:RequestDataArgumentExtended, format:LLMFormat):Promise<requestDataResponse|null>{
    if(!isNodeServer || arg.previewBody){
        return null
    }

    const provider = getServerTransportProvider(format)
    if(!provider){
        return null
    }

    const currentChar = arg.currentChar ?? getCurrentCharacter()
    const currentChat = getCurrentChat()
    const characterId = currentChar?.chaId ?? 'server_generation'
    const chatId = currentChat?.id ?? arg.chatId ?? `${characterId}_adhoc`

    if(arg.mode === 'model'){
        const descriptor = getCompiledTransportDescriptor(format)
        let compiledTransport:CompiledGenerationTransport|undefined
        if(descriptor && !arg.multiGen && hasTrustedServerEndpoint(arg, format)){
            const preview = await buildServerTransportPreview(arg, format)
            if(preview?.type === 'success'){
                const transport = parseTransportPreview(preview.result)
                const model = arg.modelInfo?.internalID || arg.aiModel
                if(transport && model){
                    compiledTransport = {
                        ...descriptor,
                        model,
                        body: transport.body,
                        useStreaming: Boolean(arg.useStreaming),
                    }
                }
            }
        }

        const serverJob = await createGenerationJob({
            characterId,
            chatId,
            model: arg.aiModel,
            overrideModel: arg.aiModel,
            continue: arg.continue,
            useStreaming: arg.useStreaming,
            mode: 'server',
            compiledTransport,
            requestOptions: {
                temperature: arg.temperature,
                maxTokens: arg.maxTokens,
                tools: arg.tools,
            },
        })

        if(arg.useStreaming){
            return {
                type: 'streaming',
                result: await streamGenerationJob(serverJob.jobId, arg.abortSignal),
                model: arg.aiModel,
                messageId: serverJob.messageId ?? undefined,
                serverOwned: true,
            }
        }

        return {
            type: 'success',
            result: await waitForGenerationJob(serverJob.jobId, arg.abortSignal),
            model: arg.aiModel,
            messageId: serverJob.messageId ?? undefined,
            serverOwned: true,
        }
    }

    const preview = await buildServerTransportPreview(arg, format)
    if(!preview){
        return null
    }

    if(preview.type === 'fail'){
        return preview
    }

    if(preview.type !== 'success'){
        return null
    }

    const transport = parseTransportPreview(preview.result)
    if(!transport){
        return null
    }

    const job = await createGenerationJob({
        characterId,
        chatId,
        model: arg.aiModel,
        overrideModel: arg.aiModel,
        continue: arg.continue,
        useStreaming: arg.useStreaming,
        mode: 'transport',
        transport: {
            provider,
            url: transport.url,
            body: transport.body,
            headers: transport.headers,
            method: 'POST',
            useStreaming: arg.useStreaming,
        }
    })

    if(arg.useStreaming){
        return {
            type: 'streaming',
            result: await streamGenerationJob(job.jobId, arg.abortSignal),
            model: arg.aiModel,
            messageId: job.messageId ?? undefined,
            serverOwned: true,
        }
    }

    return {
        type: 'success',
        result: await waitForGenerationJob(job.jobId, arg.abortSignal),
        model: arg.aiModel,
        messageId: job.messageId ?? undefined,
        serverOwned: true,
    }
}

function hasTrustedServerEndpoint(arg:RequestDataArgumentExtended, format:LLMFormat):boolean{
    if(arg.modelInfo?.endpoint || arg.modelInfo?.keyIdentifier){
        return false
    }
    if(arg.aiModel?.startsWith('xcustom:::')){
        return format === LLMFormat.OpenAICompatible
    }
    if(arg.aiModel === 'reverse_proxy'){
        return format === LLMFormat.OpenAICompatible
            || format === LLMFormat.Anthropic
            || format === LLMFormat.AnthropicLegacy
    }
    return true
}

function parseTransportPreview(result:string):{url:string,body:Record<string,any>,headers:Record<string,string>}|null{
    try {
        const transport = JSON.parse(result)
        if(!transport || typeof transport.url !== 'string' || !transport.url
            || !transport.body || typeof transport.body !== 'object' || Array.isArray(transport.body)
            || !transport.headers || typeof transport.headers !== 'object' || Array.isArray(transport.headers)){
            return null
        }
        return transport
    } catch {
        return null
    }
}

function getCompiledTransportDescriptor(format:LLMFormat):Pick<CompiledGenerationTransport, 'provider'|'endpointKind'>|null{
    switch(format){
        case LLMFormat.OpenAICompatible:
            return { provider: 'openai', endpointKind: 'chat-completions' }
        case LLMFormat.Mistral:
            return { provider: 'openai', endpointKind: 'mistral-chat' }
        case LLMFormat.Anthropic:
        case LLMFormat.AnthropicLegacy:
            return { provider: 'anthropic', endpointKind: 'anthropic-messages' }
        case LLMFormat.GoogleCloud:
            return { provider: 'google', endpointKind: 'google-generate' }
        default:
            return null
    }
}

function getServerTransportProvider(format:LLMFormat):'openai'|'anthropic'|'google'|null{
    switch(format){
        case LLMFormat.OpenAICompatible:
        case LLMFormat.Mistral:
        case LLMFormat.OpenAILegacyInstruct:
        case LLMFormat.OpenAIResponseAPI:
            return 'openai'
        case LLMFormat.Anthropic:
        case LLMFormat.AnthropicLegacy:
        case LLMFormat.AWSBedrockClaude:
            return 'anthropic'
        case LLMFormat.VertexAIGemini:
        case LLMFormat.GoogleCloud:
            return 'google'
        default:
            return null
    }
}

async function buildServerTransportPreview(arg:RequestDataArgumentExtended, format:LLMFormat):Promise<requestDataResponse|null>{
    const previewArg = {
        ...arg,
        previewBody: true,
    }

    switch(format){
        case LLMFormat.OpenAICompatible:
        case LLMFormat.Mistral:
            return requestOpenAI(previewArg)
        case LLMFormat.OpenAILegacyInstruct:
            return requestOpenAILegacyInstruct(previewArg)
        case LLMFormat.OpenAIResponseAPI:
            return requestOpenAIResponseAPI(previewArg)
        case LLMFormat.Anthropic:
        case LLMFormat.AnthropicLegacy:
        case LLMFormat.AWSBedrockClaude:
            return requestClaude(previewArg)
        case LLMFormat.VertexAIGemini:
        case LLMFormat.GoogleCloud:
            return requestGoogleCloudVertex(previewArg)
        default:
            return null
    }
}
