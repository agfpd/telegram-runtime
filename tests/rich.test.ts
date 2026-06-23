import { describe, expect, test } from 'bun:test'
import { GrammyError } from 'grammy'
import { sendRichResilient } from '../src/cli.ts'

// Unit proof for the rich-first outbound path (Bot API 10.1 sendRichMessage).
// The bot is a structural fake: sendRichResilient only touches bot.api.raw
// (a name-keyed Proxy in real grammy), so a plain object with a scripted
// sendRichMessage exercises the full decision logic — payload shape, the
// deterministic-4xx immediate fallback, and the transient-error retry loop —
// without the network.

type Call = { payload: Record<string, unknown>; signal: AbortSignal | undefined }

function fakeBot(impl: (payload: Record<string, unknown>) => Promise<unknown>, calls: Call[]): any {
  return {
    api: {
      raw: {
        sendRichMessage: async (payload: Record<string, unknown>, signal?: AbortSignal) => {
          calls.push({ payload, signal })
          return impl(payload)
        },
      },
    },
  }
}

function tgError(code: number, description: string): GrammyError {
  return new GrammyError(
    `Call to sendRichMessage failed (${code}: ${description})`,
    { ok: false, error_code: code, description } as any,
    'sendRichMessage',
    {},
  )
}

describe('sendRichResilient — payload contract', () => {
  test('delivers the agent GFM verbatim as rich_message.markdown and returns true', async () => {
    const calls: Call[] = []
    const text = '# Отчёт\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- пункт'
    const ok = await sendRichResilient(fakeBot(async () => ({}), calls), '42', text)
    expect(ok).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0].payload).toEqual({ chat_id: '42', rich_message: { markdown: text } })
    // The send must be bounded by an abort signal (outbound timeout discipline).
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })
})

describe('sendRichResilient — deterministic 4xx falls back immediately', () => {
  test('400 (markdown rejected / over-limit) → false after exactly one call', async () => {
    const calls: Call[] = []
    const bot = fakeBot(async () => {
      throw tgError(400, "Bad Request: can't parse rich message")
    }, calls)
    const ok = await sendRichResilient(bot, '42', 'text')
    expect(ok).toBe(false)
    expect(calls.length).toBe(1)
  })

  test('404 (Bot API server predates 10.1) → false after exactly one call', async () => {
    const calls: Call[] = []
    const bot = fakeBot(async () => {
      throw tgError(404, 'Not Found: method not found')
    }, calls)
    const ok = await sendRichResilient(bot, '42', 'text')
    expect(ok).toBe(false)
    expect(calls.length).toBe(1)
  })
})

describe('sendRichResilient — transient failures retry, then yield to legacy', () => {
  test('network error once, then success → true with a retry', async () => {
    const calls: Call[] = []
    let first = true
    const bot = fakeBot(async () => {
      if (first) {
        first = false
        throw new Error('network is unreachable')
      }
      return {}
    }, calls)
    const ok = await sendRichResilient(bot, '42', 'text')
    expect(ok).toBe(true)
    expect(calls.length).toBe(2)
  })

  test(
    '429 on every attempt → exhausts retries and returns false (never throws)',
    async () => {
      const calls: Call[] = []
      const bot = fakeBot(async () => {
        throw tgError(429, 'Too Many Requests: retry after 1')
      }, calls)
      const ok = await sendRichResilient(bot, '42', 'text')
      expect(ok).toBe(false)
      // OUTBOUND_SEND_RETRIES defaults to 2 → 3 attempts in total.
      expect(calls.length).toBe(3)
    },
    { timeout: 15_000 },
  )
})

import { hardenSoftBreaks, spaceRichParagraphs } from '../src/cli.ts'

describe('spaceRichParagraphs — paragraph spacer workaround', () => {
  test('plain + plain → spacer paragraph inserted', () => {
    expect(spaceRichParagraphs('абзац A\n\nабзац B')).toBe('абзац A\n\n&nbsp;\n\nабзац B')
  })

  test('heading boundaries untouched (headings render their own air)', () => {
    const md = '# Заголовок\n\nабзац A\n\n## Другой\n\nабзац B'
    expect(spaceRichParagraphs(md)).toBe(md)
  })

  test('table / list / quote / divider boundaries untouched', () => {
    const md = 'текст\n\n| a | b |\n|---|---|\n\n- пункт\n\n> цитата\n\n---\n\nконец'
    expect(spaceRichParagraphs(md)).toBe(md)
  })

  test('blank lines inside code fences are code, not paragraph breaks', () => {
    const md = '```\nstrokA\n\nstrokB\n```'
    expect(spaceRichParagraphs(md)).toBe(md)
  })

  test('plain paragraphs around a fence get no spacer against the fence', () => {
    const md = 'до\n\n```js\nx\n```\n\nпосле'
    expect(spaceRichParagraphs(md)).toBe(md)
  })

  test('three plain paragraphs → two spacers', () => {
    expect(spaceRichParagraphs('a\n\nb\n\nc')).toBe('a\n\n&nbsp;\n\nb\n\n&nbsp;\n\nc')
  })

  test('single paragraph / single newlines untouched', () => {
    expect(spaceRichParagraphs('строка раз\nстрока два')).toBe('строка раз\nстрока два')
  })
})

describe('hardenSoftBreaks — single \\n inside a paragraph becomes a GFM hard break', () => {
  test('the reported repro: three plain lines split by single \\n → each line hardened', () => {
    // GFM space-joins these into "строка-А строка-Б строка-В"; the hard break (two
    // trailing spaces) keeps them on separate lines. Last line has no successor.
    expect(hardenSoftBreaks('строка-А\nстрока-Б\nстрока-В')).toBe('строка-А  \nстрока-Б  \nстрока-В')
  })

  test('two plain lines → first hardened, second (no successor) untouched', () => {
    expect(hardenSoftBreaks('строка раз\nстрока два')).toBe('строка раз  \nстрока два')
  })

  test('ad-hoc bullets via • (not a GFM list marker) are plain → hardened line-by-line', () => {
    expect(hardenSoftBreaks('• раз\n• два\n• три')).toBe('• раз  \n• два  \n• три')
  })

  test('\\n\\n paragraph breaks are left alone (next line is blank, not plain)', () => {
    expect(hardenSoftBreaks('абзац1\n\nабзац2')).toBe('абзац1\n\nабзац2')
  })

  test('a real GFM list (- markers) is structural → NOT hardened (renders itself)', () => {
    expect(hardenSoftBreaks('- раз\n- два\n- три')).toBe('- раз\n- два\n- три')
  })

  test('table / heading / quote / divider rows are structural → untouched', () => {
    const md = '# Заголовок\nтекст\n| a | b |\n|---|---|\n| 1 | 2 |\n> цитата\n---'
    // Plain "текст" precedes a table row (structural) → "текст" NOT hardened;
    // every structural row is left intact so table/quote/divider parsing survives.
    expect(hardenSoftBreaks(md)).toBe(md)
  })

  test('lines inside a code fence pass through verbatim (single \\n is code, not prose)', () => {
    const md = '```js\nconst a = 1\nconst b = 2\n```'
    expect(hardenSoftBreaks(md)).toBe(md)
  })

  test('plain prose around a fenced block: prose hardened, fence body verbatim', () => {
    expect(hardenSoftBreaks('строка А\nстрока Б\n```\nкод1\nкод2\n```')).toBe(
      'строка А  \nстрока Б\n```\nкод1\nкод2\n```',
    )
  })

  test('composes after spaceRichParagraphs: paragraph spacer survives, inner \\n hardened', () => {
    // строка-А/строка-Б share a paragraph (single \n); абзац2 is a separate one.
    const spaced = spaceRichParagraphs('строка-А\nстрока-Б\n\nабзац2')
    expect(hardenSoftBreaks(spaced)).toBe('строка-А  \nстрока-Б\n\n&nbsp;\n\nабзац2')
  })

  test('a line already ending in a space still gets a >=2-space hard break', () => {
    expect(hardenSoftBreaks('раз \nдва')).toBe('раз   \nдва')
  })

  test('empty / single-line input is a no-op', () => {
    expect(hardenSoftBreaks('')).toBe('')
    expect(hardenSoftBreaks('одна строка')).toBe('одна строка')
  })
})
