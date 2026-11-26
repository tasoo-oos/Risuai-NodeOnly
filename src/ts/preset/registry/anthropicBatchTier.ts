// Anthropic Message Batches are selected per preset with service_tier=batch
// (process/request/request.ts turns that value into a batch job instead of a
// Messages call). The model registry does not offer that value, so it is added
// here, when a profile snapshot is resolved, rather than in the bundled
// registry files: those are a generated snapshot of the upstream registry that
// the next resync rewrites, and a synced remote catalog replaces them at
// runtime anyway.
import type { AdapterKind, RegistryFieldSchema } from '../types'

export const ANTHROPIC_BATCH_SERVICE_TIER = 'batch'
const SERVICE_TIER_KEY = 'service_tier'
const BATCH_OPTION = { value: ANTHROPIC_BATCH_SERVICE_TIER, label: 'Batch' } as const

/** Only first-party Anthropic serves the Message Batches API. */
export function isAnthropicBatchProvider(adapterKind: AdapterKind | string, providerBaseId: string): boolean {
    return adapterKind === 'anthropic-messages' && providerBaseId === 'anthropic'
}

/**
 * Adds a "Batch" option to the profile's service_tier select. Only touches a
 * field that already exists as a body-mapped enum, so a profile without a
 * service tier setting is left alone, and a registry that ships the option
 * itself is not duplicated. Never mutates the registry's own objects.
 */
export function withAnthropicBatchServiceTier(
    schema: RegistryFieldSchema[],
    adapterKind: AdapterKind | string,
    providerBaseId: string,
): RegistryFieldSchema[] {
    if (!isAnthropicBatchProvider(adapterKind, providerBaseId)) return schema
    let changed = false
    const next = schema.map((field) => {
        if (field?.key !== SERVICE_TIER_KEY || !Array.isArray(field.enum) || field.enum.length === 0) return field
        if (field.mapsTo?.target !== 'body' || field.mapsTo.path !== SERVICE_TIER_KEY) return field
        if (field.enum.some((option) => option?.value === ANTHROPIC_BATCH_SERVICE_TIER)) return field
        changed = true
        return { ...field, enum: [...field.enum, { ...BATCH_OPTION }] }
    })
    return changed ? next : schema
}
