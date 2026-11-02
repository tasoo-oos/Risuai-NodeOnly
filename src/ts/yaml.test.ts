import { describe, expect, it } from 'vitest'
import { parseYaml, stringifyYaml } from './yaml'

describe('YAML interchange', () => {
    it('round trips multiline prompts and chat messages', () => {
        const value = {
            type: 'risuChat',
            ver: 2,
            data: {
                prompt: 'First line\nSecond line',
                message: [{ role: 'user', data: 'Hello: world' }],
            },
        }

        expect(parseYaml(stringifyYaml(value))).toEqual(value)
    })

    it('does not mutate the exported value', () => {
        const value = { prompt: 'test', optional: undefined }

        stringifyYaml(value)

        expect(value).toHaveProperty('optional', undefined)
    })
})
