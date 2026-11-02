import { parse, stringify } from 'yaml'

export function parseYaml(data: Uint8Array): unknown {
    return parse(Buffer.from(data).toString('utf-8'))
}

export function stringifyYaml(value: unknown): Uint8Array {
    // Match JSON export behavior for unsupported values without changing the source object.
    const serializable = JSON.parse(JSON.stringify(value))
    return Buffer.from(stringify(serializable), 'utf-8')
}
