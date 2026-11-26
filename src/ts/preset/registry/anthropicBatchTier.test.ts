import { describe, expect, test } from 'vitest'
import type { RegistryFieldSchema } from '../types'
import { loadBundledRegistry } from './loader'
import { resolveSnapshot } from './snapshot'
import { withAnthropicBatchServiceTier } from './anthropicBatchTier'

function serviceTierField(values: string[] = ['auto', 'standard_only']): RegistryFieldSchema {
    return {
        key: 'service_tier',
        type: 'string',
        label: 'Service Tier',
        enum: values.map((value) => ({ value, label: value })),
        mapsTo: { target: 'body', path: 'service_tier' },
    }
}

function tierValues(schema: RegistryFieldSchema[]): unknown[] | undefined {
    return schema.find((f) => f.key === 'service_tier')?.enum?.map((o) => o.value)
}

describe('withAnthropicBatchServiceTier', () => {
    test('appends a Batch option to a first-party Anthropic service tier select without mutating it', () => {
        const field = serviceTierField()
        const schema = [field]

        const next = withAnthropicBatchServiceTier(schema, 'anthropic-messages', 'anthropic')

        expect(tierValues(next)).toEqual(['auto', 'standard_only', 'batch'])
        expect(next.find((f) => f.key === 'service_tier')?.enum?.at(-1)).toEqual({ value: 'batch', label: 'Batch' })
        expect(field.enum?.map((o) => o.value)).toEqual(['auto', 'standard_only'])
        expect(schema).toEqual([field])
    })

    test('leaves other providers, schemas without the field, and registries that already offer batch alone', () => {
        const schema = [serviceTierField()]
        expect(withAnthropicBatchServiceTier(schema, 'anthropic-messages', 'openrouter')).toBe(schema)
        expect(withAnthropicBatchServiceTier(schema, 'openai-compatible', 'anthropic')).toBe(schema)

        const noTier: RegistryFieldSchema[] = [{ key: 'temperature', type: 'number', label: 'Temperature' }]
        expect(withAnthropicBatchServiceTier(noTier, 'anthropic-messages', 'anthropic')).toBe(noTier)

        const already = [serviceTierField(['auto', 'batch'])]
        expect(withAnthropicBatchServiceTier(already, 'anthropic-messages', 'anthropic')).toBe(already)

        const notBody: RegistryFieldSchema[] = [{ ...serviceTierField(), mapsTo: { target: 'header', path: 'service_tier' } }]
        expect(withAnthropicBatchServiceTier(notBody, 'anthropic-messages', 'anthropic')).toBe(notBody)
    })

    test('every bundled Anthropic profile with a service tier offers Batch after snapshot resolution', () => {
        const registry = loadBundledRegistry()
        const anthropicIds = Object.values(registry.registries)
            .flatMap((entry) => Object.values(entry.profiles ?? {}))
            .filter((profile) => profile.providerBaseId === 'anthropic')
            .map((profile) => profile.id)
        expect(anthropicIds.length).toBeGreaterThan(0)

        let withTier = 0
        for (const id of anthropicIds) {
            const values = tierValues(resolveSnapshot(registry, id).schema)
            if (!values) continue
            withTier++
            expect(values, id).toContain('batch')
            expect(values.filter((v) => v === 'batch'), id).toHaveLength(1)
        }
        // All 17 bundled Anthropic profiles carry a service tier today.
        expect(withTier).toBe(anthropicIds.length)
        // The registry objects themselves are untouched.
        for (const entry of Object.values(registry.registries)) {
            for (const profile of Object.values(entry.profiles ?? {})) {
                expect(tierValues(profile.schema ?? []) ?? [], profile.id).not.toContain('batch')
            }
        }
    })
})
