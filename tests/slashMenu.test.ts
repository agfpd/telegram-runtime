// Phase «Slash-меню бота и переключение рантайма из Telegram» — unit coverage for the
// pure pieces: the hard runtime-switch command parser (C) and the slash-menu builder (A,
// including the B underscore-grammar filter). The handlers shell out to `iapeer` and the
// live setMyCommands call are covered by the live demo, not here.

import { describe, expect, test } from 'bun:test'
import { buildBotCommands, parseRuntimeSwitchCommand } from '../src/cli.ts'

function peer(over: Record<string, unknown> = {}): any {
  return {
    personality: 'boris',
    runtime: 'claude',
    runtimes: ['claude', 'codex'],
    description: '',
    intelligence: 'artificial',
    cwd: '/tmp/peer',
    ...over,
  }
}

describe('parseRuntimeSwitchCommand', () => {
  test('matches a bare known-runtime command (with optional @botname, case-insensitive)', () => {
    expect(parseRuntimeSwitchCommand('/claude')).toBe('claude')
    expect(parseRuntimeSwitchCommand('/codex')).toBe('codex')
    expect(parseRuntimeSwitchCommand('/codex@boris_claudecode_bot')).toBe('codex')
    expect(parseRuntimeSwitchCommand('  /Claude  ')).toBe('claude')
  })

  test('does NOT match control commands, unknown words, or anything with trailing text', () => {
    for (const t of ['/new', '/compact', '/stop', '/activity', '/runtime', '/claudex', 'codex', '/codex now', '/alias_new']) {
      expect(parseRuntimeSwitchCommand(t)).toBeNull()
    }
  })
})

describe('buildBotCommands', () => {
  const names = (cmds: { command: string }[]) => cmds.map(c => c.command)

  test('control commands are always present (no aliases, single runtime → no switch)', () => {
    const cmds = buildBotCommands(peer({ runtimes: ['claude'] }), null)
    expect(names(cmds)).toEqual(['new', 'compact', 'stop', 'activity'])
  })

  test('runtime-switch commands appear only when ≥2 declared agent runtimes, one per runtime', () => {
    const cmds = buildBotCommands(peer({ runtimes: ['claude', 'codex'] }), null)
    expect(names(cmds)).toContain('claude')
    expect(names(cmds)).toContain('codex')
    // a non-agent runtime (telegram) is never a switch target
    const mixed = buildBotCommands(peer({ runtimes: ['claude', 'telegram'] }), null)
    expect(names(mixed)).not.toContain('telegram')
    expect(names(mixed)).not.toContain('claude') // only 1 AGENT runtime declared → no switch
  })

  test('aliases (canonical expansion.aliases) are included with the slash stripped + a description', () => {
    const p = peer({
      expansion: { aliases: { '/alias_new': 'Fresh session. Write a handoff, then self-fresh.', '/alias_compact': 'Compact now.' } },
    })
    const cmds = buildBotCommands(p, p)
    const byName = Object.fromEntries(cmds.map(c => [c.command, c.description]))
    expect(byName.alias_new).toBe('Fresh session. Write a handoff, then self-fresh.')
    expect(byName.alias_compact).toBe('Compact now.')
  })

  test('B grammar filter: a legacy hyphen alias key is skipped (Telegram forbids "-")', () => {
    const p = peer({ runtimes: ['claude'], expansion: { aliases: { '/alias-new': 'legacy hyphen' } } })
    const cmds = buildBotCommands(p, p)
    expect(names(cmds)).toEqual(['new', 'compact', 'stop', 'activity']) // hyphen alias dropped, not registered
  })

  test('description is collapsed to one line and truncated to ≤256 chars', () => {
    const long = 'x'.repeat(400)
    const p = peer({ runtimes: ['claude'], expansion: { aliases: { '/alias_big': `multi\n  line\t${long}` } } })
    const desc = buildBotCommands(p, p).find(c => c.command === 'alias_big')!.description
    expect(desc.length).toBeLessThanOrEqual(256)
    expect(desc).not.toContain('\n')
    expect(desc.endsWith('...')).toBe(true)
  })
})
