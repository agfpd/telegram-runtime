import { describe, expect, test } from 'bun:test'
import { escapeCurrencyDollars, toTelegramMarkdownV2 } from '../src/cli.ts'

describe('toTelegramMarkdownV2 — GFM → valid Telegram MarkdownV2', () => {
  test('escapes plain specials so the Bot API never rejects the message', () => {
    // The acceptance string: special chars must be backslash-escaped.
    expect(toTelegramMarkdownV2('цена 1.5-2.0 (примерно)')).toBe(
      'цена 1\\.5\\-2\\.0 \\(примерно\\)',
    )
  })

  test('bold **x** maps to single-asterisk TG bold', () => {
    expect(toTelegramMarkdownV2('**жирный**')).toBe('*жирный*')
  })

  test('inline code passes through, only \\ and ` escaped inside', () => {
    expect(toTelegramMarkdownV2('`a.b-c`')).toBe('`a.b-c`')
  })

  test('fenced code block survives with specials intact inside', () => {
    const out = toTelegramMarkdownV2('```\nconst x = 1.5 - (2)\n```')
    expect(out).toBe('```\nconst x = 1.5 - (2)\n```')
  })

  test('snake_case stays literal (italic only at word boundary)', () => {
    expect(toTelegramMarkdownV2('foo_bar_baz')).toBe('foo\\_bar\\_baz')
  })

  test('word-boundary italic _x_ maps to TG italic', () => {
    expect(toTelegramMarkdownV2('a _kursiv_ b')).toBe('a _kursiv_ b')
  })

  test('GFM heading becomes bold (TG has no heading syntax)', () => {
    expect(toTelegramMarkdownV2('# Заголовок')).toBe('*Заголовок*')
  })

  test('link text and url are escaped per spec', () => {
    expect(toTelegramMarkdownV2('[ссылка](https://e.com/a(b))')).toBe(
      '[ссылка](https://e.com/a(b\\))',
    )
  })

  test('newlines and blank lines are preserved verbatim', () => {
    expect(toTelegramMarkdownV2('a\n\nb')).toBe('a\n\nb')
  })

  test('lone backslash is doubled so MarkdownV2 does not choke', () => {
    expect(toTelegramMarkdownV2('C:\\Users')).toBe('C:\\\\Users')
  })
})

describe('escapeCurrencyDollars — lone $ never pairs into an inline formula', () => {
  test('several prices on one line are escaped (live repro 2026-10-30)', () => {
    expect(escapeCurrencyDollars('около $5,5 млрд. Раньше $2,8–3,3 млрд. Bybit ($1,5 млрд)')).toBe(
      'около \\$5,5 млрд. Раньше \\$2,8–3,3 млрд. Bybit (\\$1,5 млрд)',
    )
    expect(escapeCurrencyDollars('от $5 до $10, итого $15')).toBe('от \\$5 до \\$10, итого \\$15')
  })
  test('explicit author markup survives: bold, code span, $$ display math, math fence', () => {
    expect(escapeCurrencyDollars('**$5** и `код $x$` и ``a ` $b``')).toBe('**\\$5** и `код $x$` и ``a ` $b``')
    expect(escapeCurrencyDollars('$$E = mc^2$$')).toBe('$$E = mc^2$$')
    const fenced = '```math\nx = $a$\n```\nцена $3'
    expect(escapeCurrencyDollars(fenced)).toBe('```math\nx = $a$\n```\nцена \\$3')
  })
  test('idempotent; existing escapes untouched; unclosed backtick is literal', () => {
    const once = escapeCurrencyDollars('a $1 \\$2 b')
    expect(once).toBe('a \\$1 \\$2 b')
    expect(escapeCurrencyDollars(once)).toBe(once)
    expect(escapeCurrencyDollars('тик ` $5 и $6')).toBe('тик ` \\$5 и \\$6')
  })
  test('text without $ is returned unchanged', () => {
    const t = 'строка  \nвторая\n\n&nbsp;\n'
    expect(escapeCurrencyDollars(t)).toBe(t)
  })
})
