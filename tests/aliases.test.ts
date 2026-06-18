import { describe, expect, test } from 'bun:test'
import { expandAlias, resolveAliases } from '../src/cli.ts'

describe('expandAlias — operator slash-command expansion (§3.5 IAPeer DECISIONS)', () => {
  test('returns expansion when text matches an alias key exactly', () => {
    const aliases = {
      '/new': 'Новая сессия. Зафиксируй важные факты и попрощайся.',
      '/pause': 'Сохрани pending state и не перезапускайся.',
    }
    expect(expandAlias('/new', aliases)).toBe(aliases['/new'])
    expect(expandAlias('/pause', aliases)).toBe(aliases['/pause'])
  })

  test('trims surrounding whitespace and newlines before matching', () => {
    const aliases = { '/new': 'expanded' }
    expect(expandAlias('/new', aliases)).toBe('expanded')
    expect(expandAlias(' /new', aliases)).toBe('expanded')
    expect(expandAlias('/new ', aliases)).toBe('expanded')
    expect(expandAlias('\n/new\n', aliases)).toBe('expanded')
  })

  test('returns original text when no key matches (no fuzzy)', () => {
    const aliases = { '/new': 'expanded' }
    expect(expandAlias('/newer', aliases)).toBe('/newer')
    expect(expandAlias('hello', aliases)).toBe('hello')
    expect(expandAlias('the /new command', aliases)).toBe('the /new command')
  })

  test('passes through when aliases map is missing or empty', () => {
    expect(expandAlias('/new', undefined)).toBe('/new')
    expect(expandAlias('/new', {})).toBe('/new')
  })

  test('passes through when alias value is an empty string', () => {
    // The sanitizer should drop empty-string values, but expandAlias also
    // guards on its own in case a caller hands in an unsanitized map.
    expect(expandAlias('/new', { '/new': '' })).toBe('/new')
  })

  test('handles multi-line expansion text', () => {
    const aliases = {
      '/new': 'Line one.\nLine two.\nLine three.',
    }
    expect(expandAlias('/new', aliases)).toBe('Line one.\nLine two.\nLine three.')
  })
})

describe('resolveAliases — canonical expansion.aliases with transition fallback', () => {
  const base = {
    personality: 'demo',
    runtime: 'claude',
    runtimes: ['claude'],
    description: '',
    intelligence: 'artificial' as const,
  }

  test('returns undefined for a null profile', () => {
    expect(resolveAliases(null)).toBeUndefined()
  })

  test('returns undefined when neither location has aliases', () => {
    expect(resolveAliases({ ...base })).toBeUndefined()
    expect(resolveAliases({ ...base, expansion: {} })).toBeUndefined()
    expect(resolveAliases({ ...base, interfaces: { telegram: { user_id: '1' } } })).toBeUndefined()
  })

  test('reads canonical expansion.aliases (migrated profile)', () => {
    const profile = {
      ...base,
      expansion: { aliases: { '/alias-new': 'expanded new' } },
    }
    expect(resolveAliases(profile)).toEqual({ '/alias-new': 'expanded new' })
  })

  test('falls back to interfaces.telegram.aliases (pre-relocation profile)', () => {
    const profile = {
      ...base,
      interfaces: { telegram: { aliases: { '/alias-new': 'tg new' } } },
    }
    expect(resolveAliases(profile)).toEqual({ '/alias-new': 'tg new' })
  })

  test('canonical wins ALONE over the fallback — no merge', () => {
    const profile = {
      ...base,
      expansion: { aliases: { '/alias-new': 'canonical new' } },
      interfaces: {
        telegram: { aliases: { '/alias-new': 'tg new', '/alias-compact': 'tg compact' } },
      },
    }
    expect(resolveAliases(profile)).toEqual({ '/alias-new': 'canonical new' })
  })

  test('legacy top-level aliases are NOT read anymore (removed fallback)', () => {
    // Zero registry profiles carried top-level aliases as of 2026-06-11
    // (verified per-profile) — the field is dead in the wild, so a profile
    // that somehow still has it gets NO expansion rather than legacy reads.
    const profile = {
      ...base,
      aliases: { '/new': 'legacy new' },
    } as Parameters<typeof resolveAliases>[0] & { aliases: Record<string, string> }
    expect(resolveAliases(profile)).toBeUndefined()
  })

  test('sanitizes canonical map: drops non-slash keys and empty values', () => {
    const profile = {
      ...base,
      expansion: {
        aliases: {
          '/alias-new': 'ok',
          'no-slash': 'dropped',
          '/alias-empty': '',
        } as Record<string, string>,
      },
    }
    expect(resolveAliases(profile)).toEqual({ '/alias-new': 'ok' })
  })

  test('sanitizes fallback map too', () => {
    const profile = {
      ...base,
      interfaces: {
        telegram: {
          aliases: {
            '/alias-new': 'ok',
            'no-slash': 'dropped',
            '/alias-empty': '',
          } as Record<string, string>,
        },
      },
    }
    expect(resolveAliases(profile)).toEqual({ '/alias-new': 'ok' })
  })

  test('empty-after-sanitize canonical map falls back to interfaces.telegram', () => {
    const profile = {
      ...base,
      expansion: { aliases: { 'no-slash': 'dropped' } as Record<string, string> },
      interfaces: { telegram: { aliases: { '/alias-new': 'tg new' } } },
    }
    expect(resolveAliases(profile)).toEqual({ '/alias-new': 'tg new' })
  })

  test('unknown expansion siblings do not break alias resolution', () => {
    const profile = {
      ...base,
      expansion: {
        aliases: { '/alias-new': 'ok' },
        preprocess: { rules: [] },
      },
    }
    expect(resolveAliases(profile)).toEqual({ '/alias-new': 'ok' })
  })

  test('end-to-end: migrated profile expands /alias-new', () => {
    const profile = {
      ...base,
      expansion: { aliases: { '/alias-new': 'Новая сессия.' } },
    }
    expect(expandAlias('/alias-new', resolveAliases(profile))).toBe('Новая сессия.')
    // bare /new is NOT an alias post-migration — control-layer namespace
    expect(expandAlias('/new', resolveAliases(profile))).toBe('/new')
  })
})
