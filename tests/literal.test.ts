import { describe, expect, test } from 'bun:test'
import { chunkText, sendChunkResilient } from '../src/cli.ts'

export const mentorText = "Какой шаблон выберешь для поиска адресов именно со знаком «_»: '%_%@%' или '%\\_%@%'?"
const symbols = '* **bold** _ ~ ~~strike~~ `code` ``` [] [x](y) \\ \\_ $5 $10 &nbsp; <b>x</b>'

describe('literal outbound transport', () => {
  test.each([mentorText, symbols, 'строка 1\nстрока 2\n\nабзац 😀'])('sends original text without a parser: %s', async text => {
    const calls: unknown[][] = []
    const bot: any = { api: { sendMessage: async (...args: any[]) => {
      calls.push(args)
      return { message_id: 42, text: args[1], entities: [] }
    } } }
    await sendChunkResilient(bot, '42', text)
    expect(calls).toHaveLength(1)
    expect(calls[0].slice(0, 3)).toEqual(['42', text, { entities: [] }])
    expect(calls[0][3]).toBeInstanceOf(AbortSignal)
  })

  test('API text mismatch is reported and never duplicated by retry', async () => {
    let calls = 0
    const bot: any = { api: { sendMessage: async () => {
      calls++
      return { message_id: 42, text: 'wrong' }
    } } }
    await expect(sendChunkResilient(bot, '42', mentorText)).rejects.toThrow('differs from literal')
    expect(calls).toBe(1)
  })

  test('chunking preserves every character, whitespace and surrogate pairs', () => {
    for (const text of ['', mentorText, 'a'.repeat(4095) + '😀\n\n' + symbols.repeat(150), 'x'.repeat(4096) + '\n\nend']) {
      const chunks = chunkText(text)
      expect(chunks.join('')).toBe(text)
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4096)
        expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk)).toBe(false)
      }
    }
  })
})
