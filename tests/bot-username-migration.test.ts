import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateBotKeys, peerBotKey } from '../src/cli.ts'

// ── peerBotKey: the read-side resolver (bot_username canonical, bot fallback) ──
describe('peerBotKey', () => {
  const base = { personality: 'x', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial' as const }

  test('resolves the canonical bot_username key', () => {
    expect(peerBotKey({ ...base, interfaces: { telegram: { bot_username: 'maria_bot' } } })).toBe('maria_bot')
  })

  test('normalizes @-prefix and case', () => {
    expect(peerBotKey({ ...base, interfaces: { telegram: { bot_username: '@Maria_Bot' } } })).toBe('maria_bot')
  })

  test('bot_username wins over a legacy bot', () => {
    expect(peerBotKey({ ...base, interfaces: { telegram: { bot_username: 'maria_bot', bot: 'maria' } } })).toBe('maria_bot')
  })

  test('falls back to the retired bot key during the migration window', () => {
    expect(peerBotKey({ ...base, interfaces: { telegram: { bot: 'maria' } } })).toBe('maria')
  })

  test('undefined for a peer with no telegram bot (e.g. the human owner)', () => {
    expect(peerBotKey({ ...base, interfaces: { telegram: { user_id: '1' } } })).toBeUndefined()
    expect(peerBotKey(base)).toBeUndefined()
  })
})

// ── migrateBotKeys: the idempotent bot_username cutover ───────────────────────
describe('migrateBotKeys', () => {
  let root: string
  let savedRoot: string | undefined

  function botEnvPath(key: string): string {
    return join(root, 'runtimes', 'telegram', 'bots', key, '.env')
  }
  function localProfilePath(cwd: string): string {
    return join(cwd, '.iapeer', 'peer-profile.json')
  }
  function readLocalTelegram(cwd: string): Record<string, unknown> {
    return JSON.parse(readFileSync(localProfilePath(cwd), 'utf8')).interfaces.telegram
  }

  // Seed a legacy fleet: credential dir named by personality, .env carrying the real
  // @username; registry + local profile carrying the retired `bot` key.
  function seedLegacyPeer(personality: string, username: string): string {
    const cwd = join(root, 'peers', personality)
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      localProfilePath(cwd),
      JSON.stringify({
        personality,
        default_runtime: 'claude',
        runtimes: ['claude'],
        intelligence: 'artificial',
        interfaces: { telegram: { bot: personality, activity: true } },
      }),
    )
    const envDir = join(root, 'runtimes', 'telegram', 'bots', personality)
    mkdirSync(envDir, { recursive: true })
    writeFileSync(join(envDir, '.env'), `TELEGRAM_BOT_TOKEN=1:TOK_${personality}\nTELEGRAM_BOT_USERNAME=${username}\n`)
    return cwd
  }

  function writeRegistry(peers: Array<{ personality: string; cwd: string }>): void {
    writeFileSync(
      join(root, 'peers-profiles.json'),
      JSON.stringify({
        version: 1,
        peers: peers.map(p => ({
          personality: p.personality,
          cwd: p.cwd,
          default_runtime: 'claude',
          runtimes: ['claude'],
          intelligence: 'artificial',
          interfaces: { telegram: { bot: p.personality } },
        })),
      }),
    )
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-migrate-'))
    mkdirSync(join(root, 'runtimes', 'telegram', 'bots'), { recursive: true })
    savedRoot = process.env.IAPEER_ROOT
    process.env.IAPEER_ROOT = root
  })
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.IAPEER_ROOT
    else process.env.IAPEER_ROOT = savedRoot
    rmSync(root, { recursive: true, force: true })
  })

  test('renames credential dirs to @username and rewrites profiles to bot_username, dropping bot', () => {
    const natalya = seedLegacyPeer('natalya', 'repetitor_agent_bot')
    const boris = seedLegacyPeer('boris', 'boris_claudecode_bot')
    writeRegistry([
      { personality: 'natalya', cwd: natalya },
      { personality: 'boris', cwd: boris },
    ])

    const report = migrateBotKeys()

    // dirs renamed to @username, old personality-named dirs gone
    expect(existsSync(botEnvPath('repetitor_agent_bot'))).toBe(true)
    expect(existsSync(botEnvPath('boris_claudecode_bot'))).toBe(true)
    expect(existsSync(botEnvPath('natalya'))).toBe(false)
    expect(existsSync(botEnvPath('boris'))).toBe(false)

    // local profiles cut over to bot_username, retired `bot` removed, other fields kept
    const nt = readLocalTelegram(natalya)
    expect(nt.bot_username).toBe('repetitor_agent_bot')
    expect('bot' in nt).toBe(false)
    expect(nt.activity).toBe(true)
    expect(readLocalTelegram(boris).bot_username).toBe('boris_claudecode_bot')

    expect(report.warnings).toEqual([])
    expect(report.dirRenames.map(r => `${r.from}->${r.to}:${r.applied}`).sort()).toEqual([
      'boris->boris_claudecode_bot:true',
      'natalya->repetitor_agent_bot:true',
    ])
    expect(report.profileRewrites.every(r => r.applied)).toBe(true)
  })

  test('is idempotent — a second run is a clean no-op', () => {
    const natalya = seedLegacyPeer('natalya', 'repetitor_agent_bot')
    writeRegistry([{ personality: 'natalya', cwd: natalya }])
    migrateBotKeys()
    const second = migrateBotKeys()
    expect(second.dirRenames).toEqual([])
    expect(second.profileRewrites).toEqual([])
    expect(second.warnings).toEqual([])
  })

  test('dry-run reports the plan but changes nothing on disk', () => {
    const natalya = seedLegacyPeer('natalya', 'repetitor_agent_bot')
    writeRegistry([{ personality: 'natalya', cwd: natalya }])

    const report = migrateBotKeys({ dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.dirRenames).toEqual([{ from: 'natalya', to: 'repetitor_agent_bot', applied: false }])
    expect(report.profileRewrites).toEqual([{ personality: 'natalya', from: 'natalya', to: 'repetitor_agent_bot', applied: false }])
    // disk untouched
    expect(existsSync(botEnvPath('natalya'))).toBe(true)
    expect(existsSync(botEnvPath('repetitor_agent_bot'))).toBe(false)
    expect(readLocalTelegram(natalya).bot).toBe('natalya')
    expect('bot_username' in readLocalTelegram(natalya)).toBe(false)
  })

  test('warns and leaves the dir as-is when the .env has no @username', () => {
    const cwd = join(root, 'peers', 'ghost')
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      localProfilePath(cwd),
      JSON.stringify({ personality: 'ghost', default_runtime: 'claude', runtimes: ['claude'], interfaces: { telegram: { bot: 'ghost' } } }),
    )
    const envDir = join(root, 'runtimes', 'telegram', 'bots', 'ghost')
    mkdirSync(envDir, { recursive: true })
    writeFileSync(join(envDir, '.env'), 'TELEGRAM_BOT_TOKEN=1:TOK\n') // no username
    writeRegistry([{ personality: 'ghost', cwd }])

    const report = migrateBotKeys()
    expect(existsSync(botEnvPath('ghost'))).toBe(true) // not renamed
    expect(report.warnings.length).toBeGreaterThan(0)
    expect(report.dirRenames).toEqual([])
  })
})
