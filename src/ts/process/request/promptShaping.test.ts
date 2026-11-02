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
        })
    })

    test('novelai', () => {
        mockDb.aiModel = 'novelai'
        const shaping = resolvePromptShaping(resolveMainPromptTarget(classicChat))
        expect(shaping.addStartNewChatMarker).toBe(false)
        expect(shaping.tokenizerTarget).toBe('novelai')
    })
})
