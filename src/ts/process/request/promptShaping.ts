import { getDatabase, type Chat } from 'src/ts/storage/database.svelte'
import { presetConsumesCachePoint, type ModelPreset } from 'src/ts/preset/types'
import { classicModelIdFor, resolveChatModelBinding, resolvePresetTokenizer } from './modelPresetBinding'

/**
 * Where a chat's main request goes, as seen by the prompt builder (sendChat):
 * the classic model id (a slot-pinned legacy model included), or the bound
 * ModelPreset. A blocked binding counts as classic on the global model, as
 * before — that request fails at dispatch anyway.
 */
export type MainPromptTarget =
    | { kind: 'classic'; model: string }
    | { kind: 'modelPreset'; preset: ModelPreset }

export function resolveMainPromptTarget(chat: Chat | null | undefined): MainPromptTarget {
    const binding = resolveChatModelBinding(chat, 'model')
    if (binding.kind === 'modelPreset') return { kind: 'modelPreset', preset: binding.preset }
    const model = binding.kind === 'classic' ? classicModelIdFor(binding, 'model') : getDatabase().aiModel
    return { kind: 'classic', model }
}

/**
 * Model-dependent prompt-shaping decisions sendChat makes before dispatch.
 *
 * Classic targets keep the long-standing model-id heuristics. A ModelPreset
 * target gets fixed values instead: those heuristics read the classic model id,
 * which for a preset chat is the unrelated global db.aiModel (it even changes
 * with the selected prompt preset). The fixed values are what the default
 * classic model produces, i.e. what most preset chats already got.
 */
export interface PromptShaping {
    /** Per-message overhead added by the context-budget token counter. */
    chatAdditionalTokens: number
    /** Whether the token counter also counts message names. */
    tokenizerNameMode: 'name' | 'noName'
    /** ChatTokenizer target: classic model id, or the preset's tokenizer. */
    tokenizerTarget: string | { presetTokenizer: string }
    /** Insert the '[Start a new chat]' system marker (still subject to the prompt setting). */
    addStartNewChatMarker: boolean
    /** Append '[Continue the last response]' on continue. */
    addContinueMarker: boolean
    /** Merge consecutive system prompts that share memo and name. */
    mergeSystemPrompts: boolean
    /**
     * Mark the last three user messages of the chat block as cachePoint when
     * the prompt template has no cache card. Classic: db.automaticCachePoint.
     * ModelPreset: the preset's own automaticCachePoint (unset = off), and only
     * where the preset consumes cachePoint at all.
     */
    autoCachePoint: boolean
}

export function resolvePromptShaping(target: MainPromptTarget): PromptShaping {
    if (target.kind === 'modelPreset') {
        return {
            chatAdditionalTokens: 3,
            tokenizerNameMode: 'name',
            tokenizerTarget: { presetTokenizer: resolvePresetTokenizer(target.preset) },
            addStartNewChatMarker: true,
            addContinueMarker: false,
            mergeSystemPrompts: false,
            autoCachePoint: target.preset.automaticCachePoint === true && presetConsumesCachePoint(target.preset),
        }
    }
    const model = target.model ?? ''
    const isGpt = model.startsWith('gpt')
    return {
        chatAdditionalTokens: isGpt ? 5 : 3,
        tokenizerNameMode: isGpt ? 'noName' : 'name',
        tokenizerTarget: model,
        addStartNewChatMarker: !model.startsWith('novelai'),
        addContinueMarker: model.startsWith('claude') || isGpt || model.startsWith('openrouter') || model.startsWith('reverse_proxy'),
        mergeSystemPrompts: isGpt || model.startsWith('claude') || model === 'openrouter' || model === 'reverse_proxy',
        autoCachePoint: getDatabase().automaticCachePoint === true,
    }
}
