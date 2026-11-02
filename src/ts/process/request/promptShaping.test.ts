import { beforeEach, describe, expect, test, vi } from 'vitest'

let mockDb: any
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mockDb,
}))

import { resolveMainPromptTarget, resolvePromptShaping } from './promptShaping'
import { emptyModelBinding } from 'src/ts/preset/types'

const PRESET = {
    id: 'p-main',
    name: 'Main',
    profileSnapshot: { adapterKind: 'openai-compatible', recommendedTokenizer: 'deepseek', schema: [] },
    userValues: {},
} as any

function presetChat() {
    const modelBinding = emptyModelBinding()
    modelBinding.main = PRESET.id
    return { useModelPreset: true, modelBinding } as any
}

const classicChat = { useModelPreset: false } as any

beforeEach(() => {
    mockDb = { modelPresets: [PRESET], nodeOnlyModelModeLock: 'none', aiModel: 'gemini-3-flash-preview' }
})

describe('prompt shaping of a ModelPreset chat ignores the global classic model', () => {
    // Each of these classic ids flips at least one heuristic on the classic path.
    test.each(['gpt-4o', 'claude-3-opus', 'openrouter', 'reverse_proxy', 'novelai'])(
        'db.aiModel = %s',
        (aiModel) => {
            mockDb.aiModel = aiModel
            const target = resolveMainPromptTarget(presetChat())
            expect(target).toEqual({ kind: 'modelPreset', preset: PRESET })
            expect(resolvePromptShaping(target)).toEqual({
                chatAdditionalTokens: 3,
                tokenizerNameMode: 'name',
                tokenizerTarget: { presetTokenizer: 'deepseek' },
                addStartNewChatMarker: true,
                addContinueMarker: false,
                mergeSystemPrompts: false,
                autoCachePoint: false,
            })
        },
    )
})

describe('classic chats keep the model-id heuristics', () => {
    test('gpt', () => {
        mockDb.aiModel = 'gpt-4o'
        expect(resolvePromptShaping(resolveMainPromptTarget(classicChat))).toEqual({
            chatAdditionalTokens: 5,
            tokenizerNameMode: 'noName',
            tokenizerTarget: 'gpt-4o',
            addStartNewChatMarker: true,
            addContinueMarker: true,
            mergeSystemPrompts: true,
            autoCachePoint: false,
        })
    })

    test('novelai', () => {
        mockDb.aiModel = 'novelai'
        const shaping = resolvePromptShaping(resolveMainPromptTarget(classicChat))
        expect(shaping.addStartNewChatMarker).toBe(false)
        expect(shaping.tokenizerTarget).toBe('novelai')
    })
})

describe('automatic cache point', () => {
    const ANTHROPIC = {
        ...PRESET,
        id: 'p-anthropic',
        profileSnapshot: { adapterKind: 'anthropic-messages', schema: [] },
    } as any

    function shapingFor(preset: any) {
        mockDb.modelPresets = [preset]
        const modelBinding = emptyModelBinding()
        modelBinding.main = preset.id
        return resolvePromptShaping(resolveMainPromptTarget({ useModelPreset: true, modelBinding } as any))
    }

    test.each([true, false])('classic chats follow db.automaticCachePoint = %s', (global) => {
        mockDb.automaticCachePoint = global
        expect(resolvePromptShaping(resolveMainPromptTarget(classicChat)).autoCachePoint).toBe(global)
    })

    test('a preset with the field unset stays off even when the global is on', () => {
        mockDb.automaticCachePoint = true
        expect(shapingFor(ANTHROPIC).autoCachePoint).toBe(false)
    })

    test('a preset with the field on applies even when the global is off', () => {
        mockDb.automaticCachePoint = false
        expect(shapingFor({ ...ANTHROPIC, automaticCachePoint: true }).autoCachePoint).toBe(true)
    })

    test('openai-compatible presets never mark cache points (the adapter ignores them)', () => {
        mockDb.automaticCachePoint = true
        expect(shapingFor({ ...PRESET, automaticCachePoint: true }).autoCachePoint).toBe(false)
    })

    test('google-gemini presets only mark cache points while their context caching is on', () => {
        const gemini = {
            ...PRESET,
            id: 'p-gemini',
            automaticCachePoint: true,
            profileSnapshot: { adapterKind: 'google-gemini', capabilities: ['cache'], schema: [] },
        }
        expect(shapingFor(gemini).autoCachePoint).toBe(false)
        expect(shapingFor({ ...gemini, promptCaching: { enabled: true } }).autoCachePoint).toBe(true)
        expect(shapingFor({
            ...gemini,
            promptCaching: { enabled: true },
            profileSnapshot: { ...gemini.profileSnapshot, capabilities: [] },
        }).autoCachePoint).toBe(false)
    })
})
