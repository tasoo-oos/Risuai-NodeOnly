import { createGenerationJob, streamGenerationJob, waitForGenerationJob } from '../../network/generationJobs'
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
        const serverJob = await createGenerationJob({
            characterId,
            chatId,
            model: arg.aiModel,
            overrideModel: arg.aiModel,
            continue: arg.continue,
            useStreaming: arg.useStreaming,
            mode: 'server',
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

    let transport:{url:string,body:any,headers:Record<string,string>}
    try {
        transport = JSON.parse(preview.result)
    } catch (error) {
        return {
            type: 'fail',
            result: `Failed to parse server transport preview: ${error}`
        }
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
