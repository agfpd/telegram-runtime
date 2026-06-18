import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runSelfConfig } from '../src/selfConfig.ts'

function sandboxCwd(): string {
  return mkdtempSync(join(tmpdir(), 'tg-selfconfig-'))
}

describe('runSelfConfig', () => {
  test('PRESERVES the foundation-provisioned intelligence=natural (never clobbers identity)', () => {
    const cwd = sandboxCwd()
    try {
      // The foundation provisions the local profile FIRST (personality + intelligence=
      // natural, the launch nature-gate value) — then calls the hook.
      const profilePath = join(cwd, '.iapeer', 'peer-profile.json')
      mkdirSync(join(cwd, '.iapeer'), { recursive: true })
      writeFileSync(
        profilePath,
        JSON.stringify({
          personality: 'maria',
          runtime: 'telegram',
          runtimes: ['telegram'],
          intelligence: 'natural',
          description: 'op',
          initial_prompt: 'keep-me', // an adjacent-contract field the hook must not drop
        }),
      )
      const r = runSelfConfig({
        env: { IAPEER_PEER_PERSONALITY: 'maria', IAPEER_PEER_INTELLIGENCE: 'natural', TELEGRAM_USER_ID: '12345' },
        cwd,
      })
      expect(r.personality).toBe('maria')
      expect(r.userId).toBe('12345')
      const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
      // identity preserved verbatim — NOT coerced back to legacy `human`
      expect(profile.intelligence).toBe('natural')
      expect(profile.personality).toBe('maria')
      expect(profile.initial_prompt).toBe('keep-me')
      // telegram presence written
      expect(profile.interfaces.telegram.user_id).toBe('12345')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('idempotent: a repeat run is byte-stable', () => {
    const cwd = sandboxCwd()
    try {
      const env = { IAPEER_PEER_PERSONALITY: 'maria', TELEGRAM_USER_ID: '12345', TELEGRAM_BOT: 'maria-bot' }
      const r1 = runSelfConfig({ env, cwd })
      const a = readFileSync(r1.profilePath, 'utf8')
      const r2 = runSelfConfig({ env, cwd })
      const b = readFileSync(r2.profilePath, 'utf8')
      expect(b).toBe(a)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('links a bot and writes its credential .env under IAPEER_ROOT-aware bots registry', () => {
    const cwd = sandboxCwd()
    const root = join(cwd, 'iapeer-root')
    try {
      const r = runSelfConfig({
        env: {
          IAPEER_PEER_PERSONALITY: 'maria',
          IAPEER_ROOT: root,
          TELEGRAM_USER_ID: '12345',
          TELEGRAM_BOT: 'maria-bot',
          TELEGRAM_BOT_TOKEN: '999:ABCDEF',
          TELEGRAM_BOT_USERNAME: 'maria_bot',
        },
        cwd,
      })
      expect(r.bot).toBe('maria-bot')
      expect(r.botEnvPath).toBe(join(root, 'runtimes', 'telegram', 'bots', 'maria-bot', '.env'))
      const envText = readFileSync(r.botEnvPath!, 'utf8')
      expect(envText).toContain('TELEGRAM_BOT_TOKEN=999:ABCDEF')
      expect(envText).toContain('TELEGRAM_BOT_USERNAME=maria_bot')
      const profile = JSON.parse(readFileSync(r.profilePath, 'utf8'))
      expect(profile.interfaces.telegram.bot).toBe('maria-bot')
      // The @username is NOT duplicated into the profile — even though it was supplied
      // and written to the credential .env above, the profile carries ONLY the catalog
      // key. @username is derived from the .env for display (no write-only dup).
      expect('bot_username' in profile.interfaces.telegram).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('profile never carries bot_username (also when no @username is supplied)', () => {
    const cwd = sandboxCwd()
    try {
      const r = runSelfConfig({
        env: { IAPEER_PEER_PERSONALITY: 'maria', TELEGRAM_BOT: 'maria-bot' },
        cwd,
      })
      const profile = JSON.parse(readFileSync(r.profilePath, 'utf8'))
      expect(profile.interfaces.telegram.bot).toBe('maria-bot')
      expect('bot_username' in profile.interfaces.telegram).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('preserves an existing telegram interface field (e.g. operator-set activity) on merge', () => {
    const cwd = sandboxCwd()
    try {
      const profilePath = join(cwd, '.iapeer', 'peer-profile.json')
      mkdirSync(join(cwd, '.iapeer'), { recursive: true })
      writeFileSync(
        profilePath,
        JSON.stringify({
          personality: 'maria',
          runtime: 'telegram',
          intelligence: 'natural',
          interfaces: { telegram: { activity: true, user_id: 'old' } },
        }),
      )
      runSelfConfig({ env: { IAPEER_PEER_PERSONALITY: 'maria', TELEGRAM_USER_ID: 'new' }, cwd })
      const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
      expect(profile.interfaces.telegram.activity).toBe(true) // preserved
      expect(profile.interfaces.telegram.user_id).toBe('new') // updated
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('no operator inputs → still configured (no-op confirm), exits without throwing', () => {
    const cwd = sandboxCwd()
    try {
      const r = runSelfConfig({ env: { IAPEER_PEER_PERSONALITY: 'maria' }, cwd })
      expect(r.personality).toBe('maria')
      expect(r.userId).toBeUndefined()
      const profile = JSON.parse(readFileSync(r.profilePath, 'utf8'))
      expect(profile.interfaces.telegram).toEqual({})
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('resolves personality from namespaced env over bare PEER_PERSONALITY', () => {
    const cwd = sandboxCwd()
    try {
      const r = runSelfConfig({
        env: { IAPEER_PEER_PERSONALITY: 'maria', PEER_PERSONALITY: 'boris' },
        cwd,
      })
      expect(r.personality).toBe('maria')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
