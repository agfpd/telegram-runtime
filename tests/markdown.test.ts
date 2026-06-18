import { describe, expect, test } from 'bun:test'
import { toTelegramMarkdownV2 } from '../src/cli.ts'

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
