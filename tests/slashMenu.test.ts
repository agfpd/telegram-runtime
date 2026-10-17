// Phase «Slash-меню бота и переключение рантайма из Telegram» — unit coverage for the
// pure pieces: the hard runtime-switch command parser (C) and the slash-menu builder (A,
// including the B underscore-grammar filter). The handlers shell out to `iapeer` and the
// live setMyCommands call are covered by the live demo, not here.

import { describe, expect, test } from 'bun:test'
import { buildBotCommands, parseRuntimeSwitchCommand, runtimeSwitchUnavailableText } from '../src/cli.ts'

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
  const cand = ['claude', 'codex', 'opencode']
  test('matches a bare candidate runtime (with optional @botname, case-insensitive)', () => {
    expect(parseRuntimeSwitchCommand('/claude', cand)).toBe('claude')
    expect(parseRuntimeSwitchCommand('/codex', cand)).toBe('codex')
    expect(parseRuntimeSwitchCommand('/opencode', cand)).toBe('opencode')
    expect(parseRuntimeSwitchCommand('/codex@boris_claudecode_bot', cand)).toBe('codex')
    expect(parseRuntimeSwitchCommand('  /Claude  ', cand)).toBe('claude')
  })

  test('does NOT match control commands, non-candidates, or anything with trailing text', () => {
    for (const t of ['/new', '/compact', '/stop', '/activity', '/runtime', '/claudex', 'codex', '/codex now', '/alias_new']) {
      expect(parseRuntimeSwitchCommand(t, cand)).toBeNull()
    }
    expect(parseRuntimeSwitchCommand('/opencode', ['claude', 'codex'])).toBeNull() // no hardcode: list-driven
    expect(parseRuntimeSwitchCommand('/claude', [])).toBeNull()
  })
})

describe('buildBotCommands', () => {
  const names = (cmds: { command: string }[]) => cmds.map(c => c.command)

  test('control commands are always present (no aliases, single runtime → no switch)', () => {
    const cmds = buildBotCommands(peer({ runtimes: ['claude'] }), null)
    expect(names(cmds)).toEqual(['new', 'compact', 'stop', 'activity'])
  })

  test('runtime-switch commands come from discovered agent endpoints only, when ≥2', () => {
    const ok = (runtimes: string[]) => ({ state: 'ok' as const, runtimes })
    const cmds = buildBotCommands(peer({ runtimes: ['claude', 'codex', 'opencode'] }), null, ok(['claude', 'codex', 'opencode']))
    expect(names(cmds)).toEqual(['new', 'compact', 'stop', 'activity', 'claude', 'codex', 'opencode'])
    // declared but not hostable on this core → not offered
    expect(names(buildBotCommands(peer({ runtimes: ['claude', 'codex'] }), null, ok(['claude'])))).toEqual(['new', 'compact', 'stop', 'activity'])
  })

  test('pre-discovery core: ONE explanatory /runtime entry instead of a silently shrunken menu', () => {
    const cmds = buildBotCommands(peer({ runtimes: ['claude', 'codex'] }), null, { state: 'absent' })
    expect(names(cmds)).toEqual(['new', 'compact', 'stop', 'activity', 'runtime'])
    expect(cmds.at(-1)!.description).toContain('0.4.115')
    // single-runtime peer: nothing to explain
    expect(names(buildBotCommands(peer({ runtimes: ['claude'] }), null, { state: 'absent' }))).not.toContain('runtime')
  })

  test('unavailable text: absent names the required core, unreachable says so, ok is null', () => {
    expect(runtimeSwitchUnavailableText({ state: 'absent' })).toContain('iapeer ≥ 0.4.115')
    expect(runtimeSwitchUnavailableText({ state: 'unreachable' })).toContain('не отвечает')
    expect(runtimeSwitchUnavailableText({ state: 'ok', runtimes: [] })).toBeNull()
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
