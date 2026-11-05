import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureTelegramProfile, patchTelegramInterface } from '../src/profilePatch.ts'
import { runSelfConfig } from '../src/selfConfig.ts'
import { handleActivityCommand } from '../src/cli.ts'

const cli = join(import.meta.dir, '../src/cli.ts')
const modulePath = join(import.meta.dir, '../src/profilePatch.ts')

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'tg-profile-patch-'))
  mkdirSync(join(cwd, '.iapeer'))
  const path = join(cwd, '.iapeer/peer-profile.json')
  const lock = join(cwd, '.iapeer/.peer-profile.lock')
  const raw = {
    personality: 'probe', default_runtime: 'opencode', runtimes: ['opencode'],
    intelligence: 'artificial', description: 'keep', approval_mode: 'gated',
    expansion: { aliases: { '/alias_probe': 'keep' } },
    future: { nested: true }, interfaces: { web: { future: 1 }, telegram: { user_id: 'old', future: 2 } },
  }
  writeFileSync(path, JSON.stringify(raw))
  return { cwd, path, lock, raw }
}

test('all CLI profile writers change only owned leaves (no identity normalization)', () => {
  const f = fixture()
  try {
    const commands = [
      ['prepare', '--user-id', 'new'], ['interface', 'human', '--user-id', 'newer'],
      ['interface', 'bot', 'probe_bot', '--peer', 'probe'],
    ]
    // --peer resolution uses the registry projection; no host state is consulted.
    writeFileSync(join(f.cwd, 'peers-profiles.json'), JSON.stringify({ peers: [{
      ...f.raw, cwd: f.cwd,
    }] }))
    for (const args of commands) {
      const r = Bun.spawnSync([process.execPath, cli, ...args], {
        cwd: f.cwd, env: { ...process.env, IAPEER_ROOT: f.cwd },
      })
      expect(r.stderr.toString()).toBe('')
      expect(r.exitCode).toBe(0)
    }
    const raw = JSON.parse(readFileSync(f.path, 'utf8'))
    expect(raw).toEqual({ ...f.raw, runtimes: ['opencode', 'telegram'], interfaces: {
      web: { future: 1 }, telegram: { user_id: 'newer', bot_username: 'probe_bot', future: 2 },
    } })
    const before = statSync(f.path)
    ensureTelegramProfile(f.cwd)
    patchTelegramInterface(f.cwd, { user_id: 'newer' })
    expect(statSync(f.path).ino).toBe(before.ino)
    expect(statSync(f.path).mtimeMs).toBe(before.mtimeMs)
  } finally { rmSync(f.cwd, { recursive: true, force: true }) }
})

test('waiting writer reads the profile AFTER acquiring the shared core lock', async () => {
  const f = fixture()
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    mkdirSync(f.lock)
    child = Bun.spawn([process.execPath, '-e', `
      import { patchTelegramInterface } from ${JSON.stringify(modulePath)};
      console.log('ready');
      patchTelegramInterface(${JSON.stringify(f.cwd)}, {activity: true}, true);
    `], { stdout: 'pipe', stderr: 'pipe' })
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready')
    reader.releaseLock()
    expect(await Promise.race([
      child.exited.then(() => 'exited'), Bun.sleep(100).then(() => 'waiting'),
    ])).toBe('waiting')
    // Simulate a preceding cooperative writer committing while it still owns the lock.
    const newer = { ...f.raw, default_runtime: 'codex', future: { nested: false }, interfaces: {
      ...f.raw.interfaces, telegram: { ...f.raw.interfaces.telegram, user_id: 'concurrent' },
    } }
    writeFileSync(f.path, JSON.stringify(newer))
    rmSync(f.lock, { recursive: true })
    expect(await child.exited).toBe(0)
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ ...newer, interfaces: {
      ...newer.interfaces, telegram: { ...newer.interfaces.telegram, activity: true },
    } })
  } finally {
    child?.kill()
    if (child) await child.exited
    rmSync(f.cwd, { recursive: true, force: true })
  }
})

test('self-config fails closed on malformed profiles and does not write credentials', () => {
  const f = fixture()
  try {
    for (const bad of ['{bad', 'null', '[]', '42']) {
      writeFileSync(f.path, bad)
      expect(() => runSelfConfig({ cwd: f.cwd, env: {
        IAPEER_PEER_PERSONALITY: 'probe', IAPEER_ROOT: f.cwd,
        TELEGRAM_USER_ID: 'new', TELEGRAM_BOT_USERNAME: 'probe_bot', TELEGRAM_BOT_TOKEN: 'fake',
      } })).toThrow()
      expect(readFileSync(f.path, 'utf8')).toBe(bad)
      expect(existsSync(f.lock)).toBe(false)
      expect(existsSync(join(f.cwd, 'runtimes/telegram/bots/probe_bot/.env'))).toBe(false)
    }
  } finally { rmSync(f.cwd, { recursive: true, force: true }) }
})

test('prepare scaffolds a missing profile, then becomes a true no-op', () => {
  const f = fixture()
  try {
    rmSync(f.path)
    ensureTelegramProfile(f.cwd)
    const raw = JSON.parse(readFileSync(f.path, 'utf8'))
    expect(raw.default_runtime).toBe('telegram')
    expect(raw.intelligence).toBe('natural')
    expect(raw.runtimes).toEqual(['telegram'])
    const before = statSync(f.path)
    ensureTelegramProfile(f.cwd)
    expect(statSync(f.path).ino).toBe(before.ino)
    expect(statSync(f.path).mtimeMs).toBe(before.mtimeMs)
  } finally { rmSync(f.cwd, { recursive: true, force: true }) }
})

test('activity handler patches only activity; lock timeout reports failure without an unlocked fallback', async () => {
  const f = fixture()
  try {
    const messages: string[] = []
    const bot: any = { api: { sendMessage: async (_id: string, text: string) => { messages.push(text) } } }
    const target: any = { ...f.raw, cwd: f.cwd }
    await handleActivityCommand(bot, '123', target, 'on')
    const expected = { ...f.raw, interfaces: {
      ...f.raw.interfaces, telegram: { ...f.raw.interfaces.telegram, activity: true },
    } }
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual(expected)
    const before = readFileSync(f.path, 'utf8')
    mkdirSync(f.lock)
    await handleActivityCommand(bot, '123', target, 'off')
    expect(messages.at(-1)).toContain('lock timeout')
    expect(readFileSync(f.path, 'utf8')).toBe(before)
    expect(existsSync(f.lock)).toBe(true)
  } finally { rmSync(f.cwd, { recursive: true, force: true }) }
})
