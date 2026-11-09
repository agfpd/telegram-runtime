import { describe, expect, test } from 'bun:test'
import { chunkFormatted, entitiesDelivered, formatOutbound, MAX_ENTITIES_PER_MESSAGE } from '../src/outboundFormat.ts'
import { sendChunkResilient } from '../src/cli.ts'
const mentorText = "Какой шаблон выберешь для поиска адресов именно со знаком «_»: '%_%@%' или '%\\_%@%'?"

const plain = (s: string) => {
  const f = formatOutbound(s)
  expect(f.entities).toEqual([])
  expect(f.text).toBe(s)
}

describe('formatOutbound — recognised subset', () => {
  test('bold, link, inline code, fenced block with language', () => {
    const f = formatOutbound('**Итог**: см. [доку](https://e.com/a(b)) и `x_y`\n```sql\nSELECT 1;\n```\nконец')
    expect(f.text).toBe('Итог: см. доку и x_y\nSELECT 1;\nконец')
    expect(f.entities).toEqual([
      { type: 'bold', offset: 0, length: 4 },
      { type: 'text_link', offset: 10, length: 4, url: 'https://e.com/a(b)' },
      { type: 'code', offset: 17, length: 3 },
      { type: 'pre', offset: 21, length: 9, language: 'sql' },
    ])
  })

  test('heading → bold without the # prefix; strike', () => {
    const f = formatOutbound('## Шаги\n~~старое~~ новое')
    expect(f.text).toBe('Шаги\nстарое новое')
    expect(f.entities).toEqual([
      { type: 'bold', offset: 0, length: 4 },
      { type: 'strikethrough', offset: 5, length: 6 },
    ])
  })

  test('list markers stay literal text', () => plain('- один\n* два\n1. три'))

  test('fenced content is byte-exact, including markup-looking text and indentation', () => {
    const body = "  **не жирный** _x_ \\_ $5 `y`\n\tWHERE e LIKE '%\\_%@%'"
    const f = formatOutbound('```\n' + body + '\n```')
    expect(f.text).toBe(body)
    expect(f.entities).toEqual([{ type: 'pre', offset: 0, length: body.length }])
  })

  test('indented fence (inside a list) strips only the fence indent', () => {
    const f = formatOutbound('- шаг:\n  ```bash\n  ls -la\n    deep\n  ```')
    expect(f.text).toBe('- шаг:\nls -la\n  deep')
    expect(f.entities).toEqual([{ type: 'pre', offset: 7, length: 13, language: 'bash' }])
  })

  test('acceptance 6: short inline fragment mid-phrase is its own tap-to-copy code span, verbatim inside', () => {
    const frag = "Head_&_Shoulders 100% \\x $5 *new*"
    const f = formatOutbound('Купи шампунь `' + frag + '` в Ленте')
    expect(f.text).toBe('Купи шампунь ' + frag + ' в Ленте')
    expect(f.entities).toEqual([{ type: 'code', offset: 13, length: frag.length }])
  })

  test('double-backtick code span carries a backtick', () => {
    const f = formatOutbound('символ `` ` `` тут')
    expect(f.text).toBe('символ ` тут')
    expect(f.entities).toEqual([{ type: 'code', offset: 7, length: 1 }])
  })

  test('bold around inline code nests', () => {
    const f = formatOutbound('**run `ls`**')
    expect(f.text).toBe('run ls')
    expect(f.entities).toEqual([
      { type: 'bold', offset: 0, length: 6 },
      { type: 'code', offset: 4, length: 2 },
    ])
  })
})

describe('formatOutbound — literal guarantees (acceptance 2, 3, 4)', () => {
  test("Mentor SQL in a plain phrase arrives char-for-char", () => plain(mentorText))

  test("Mentor SQL inside a code block arrives char-for-char", () => {
    const sql = "SELECT email FROM users WHERE email LIKE '%_%@%' OR email LIKE '%\\_%@%';"
    const f = formatOutbound('```sql\n' + sql + '\n```')
    expect(f.text).toBe(sql)
    const g = formatOutbound('шаблон `' + "'%\\_%@%'" + '`')
    expect(g.text).toBe("шаблон '%\\_%@%'")
  })

  test.each([
    'snake_case_name и __init__ и _private_',
    'цены $5 и $10, итого $15.',
    'путь C:\\Users\\a_b и \\_ и \\* и \\\\',
    'одиночная * звезда, 2*3=6, a * b',
    '2**3 = 8 и x**y',
    'glob **/*.ts и src/**',
    'a ** b ** c',
    '|| spoiler? || и cmd1 || cmd2',
    "_italic_ и *italic* — не рендерим",
    '<b>html</b> &amp; &nbsp;',
    '~ тильда ~ и a~~b~~c',
    '#hashtag и #! shebang',
  ])('stays literal: %s', plain)

  test.each([
    '**незакрытый жирный',
    '`незакрытый код',
    '```sql\nSELECT 1; -- незакрытый блок',
    '[текст](не-url)',
    '[текст](javascript:alert(1))',
    '[текст](https://e.com',
    '****',
    '** пробел внутри **',
    '**жирный\nчерез строку**',
  ])('invalid/unclosed markup is kept verbatim: %s', plain)
})

describe('chunkFormatted (acceptance 5)', () => {
  test('a code block straddling the limit is moved whole into the next chunk', () => {
    const code = 'x := 1\n'.repeat(100).trimEnd()
    const src = 'a'.repeat(3900) + '\n```go\n' + code + '\n```\nхвост'
    const chunks = chunkFormatted(formatOutbound(src))
    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toBe('a'.repeat(3900))
    expect(chunks[1].text).toBe(code + '\nхвост')
    expect(chunks[1].entities).toEqual([{ type: 'pre', offset: 0, length: code.length, language: 'go' }])
  })

  test('a code block larger than the limit splits into valid pre parts, no char lost', () => {
    const code = Array.from({ length: 900 }, (_, k) => `line_${k} = '%_%'`).join('\n')
    const f = formatOutbound('```\n' + code + '\n```')
    const chunks = chunkFormatted(f)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map(c => c.text).join('\n')).toBe(code)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(4096)
      expect(c.entities).toEqual([{ type: 'pre', offset: 0, length: c.text.length }])
    }
  })

  test('entity budget per message is respected', () => {
    const f = formatOutbound('**a** '.repeat(250))
    const chunks = chunkFormatted(f)
    for (const c of chunks) expect(c.entities.length).toBeLessThanOrEqual(MAX_ENTITIES_PER_MESSAGE)
    expect(chunks.reduce((n, c) => n + c.entities.length, 0)).toBe(250)
  })

  test('edge whitespace is trimmed with offsets shifted; surrogates intact', () => {
    const chunks = chunkFormatted(formatOutbound('\n\n  **b**  \n'))
    expect(chunks).toEqual([{ text: 'b', entities: [{ type: 'bold', offset: 0, length: 1 }] }])
    const emoji = chunkFormatted({ text: 'a'.repeat(4095) + '😀b', entities: [] })
    for (const c of emoji) expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(c.text)).toBe(false)
    expect(emoji.map(c => c.text).join('')).toBe('a'.repeat(4095) + '😀b')
  })
})

describe('send path', () => {
  test('entities are sent explicitly, never a parse_mode', async () => {
    const calls: any[][] = []
    const bot: any = { api: { sendMessage: async (...args: any[]) => {
      calls.push(args)
      return { message_id: 1, text: args[1], entities: args[2].entities }
    } } }
    const f = formatOutbound('**x** `y`')
    await sendChunkResilient(bot, '42', f)
    expect(calls[0][1]).toBe('x y')
    expect(calls[0][2]).toEqual({ entities: f.entities })
    expect(calls[0][2].parse_mode).toBeUndefined()
  })

  test('a 400 on entities resends the same text plain — message never lost', async () => {
    const { GrammyError } = await import('grammy')
    const calls: any[][] = []
    const bot: any = { api: { sendMessage: async (...args: any[]) => {
      calls.push(args)
      if (args[2].entities.length) {
        throw new GrammyError('x', { ok: false, error_code: 400, description: "Bad Request: entity URL is invalid" }, 'sendMessage', {})
      }
      return { message_id: 1, text: args[1], entities: [] }
    } } }
    await sendChunkResilient(bot, '42', formatOutbound('[a](https://x)'))
    expect(calls).toHaveLength(2)
    expect(calls[1][1]).toBe('a (https://x)')
    expect(calls[1][2]).toEqual({ entities: [] })
  })

  test('receipt coverage check tolerates server normalisation', () => {
    const exp = formatOutbound('**run `ls` now** [d](https://e.com)').entities
    // Telegram splits bold around code and appends "/" to the url.
    expect(entitiesDelivered(exp, [
      { type: 'bold', offset: 0, length: 4 }, { type: 'code', offset: 4, length: 2 },
      { type: 'bold', offset: 6, length: 4 }, { type: 'text_link', offset: 11, length: 1 },
    ])).toBe(true)
    expect(entitiesDelivered(exp, [])).toBe(false)
  })
})
