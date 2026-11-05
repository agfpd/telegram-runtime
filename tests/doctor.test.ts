import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = join(import.meta.dir, '../src/cli.ts')

describe('doctor CLI: service bot is intentionally faceless', () => {
  test('approval role needs token but not an agent binding; ordinary/unknown roles still do', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-doctor-'))
    try {
      const cwd = join(root, 'owner')
      mkdirSync(join(cwd, '.iapeer'), { recursive: true })
      writeFileSync(join(cwd, '.iapeer/peer-profile.json'), JSON.stringify({
        personality: 'owner', default_runtime: 'telegram', intelligence: 'natural',
        interfaces: { telegram: { user_id: '123' } },
      }))
      const botDir = join(root, 'runtimes/telegram/bots/service_bot')
      mkdirSync(botDir, { recursive: true })
      const envFile = join(botDir, '.env')
      // Use the same credential filename as runtime provisioning.
      const run = (role: string, token = '1:fake') => {
        writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_BOT_ROLE=${role}\n`)
        const result = Bun.spawnSync([process.execPath, cli, 'doctor', '--json'], {
          cwd, env: { ...process.env, IAPEER_ROOT: root },
        })
        return { code: result.exitCode, json: JSON.parse(result.stdout.toString()) }
      }
      expect(run('approval').code).toBe(0)
      expect(run('approval').json.bots[0].role).toBe('approval')
      expect(run('').code).toBe(1)
      expect(run('unknown').code).toBe(1)
      expect(run('approval', '').json.problems).toContain('bot service_bot missing TELEGRAM_BOT_TOKEN')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('polling CLI', () => {
  test('exit status reflects fresh, degraded, stale and missing bots; rejects bad options', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-poll-cli-'))
    try {
      const botDir = join(root, 'runtimes/telegram/bots/probe_bot')
      mkdirSync(botDir, { recursive: true })
      const log = join(root, 'runtime.log')
      const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, 'polling', ...args], {
        env: { ...process.env, IAPEER_ROOT: root },
      })
      const event = (evt: string, at = Date.now()) => 'telegram-runtime polling ' + JSON.stringify({
        ts: new Date(at).toISOString(), evt, botKey: 'probe_bot', generation: 1, cycles: 1,
      }) + '\n'
      writeFileSync(log, event('poll.heartbeat'))
      expect(run('--log', log, '--json').exitCode).toBe(0)
      expect(JSON.parse(run('--log', log, '--json').stdout.toString()).bots[0].status).toBe('healthy')
      mkdirSync(join(root, 'runtimes/telegram/bots/unstarted_bot'))
      expect(run('--log', log, '--json').exitCode).toBe(1)
      rmSync(join(root, 'runtimes/telegram/bots/unstarted_bot'), { recursive: true })
      writeFileSync(log, event('poll.heartbeat', Date.now() - 400_000))
      expect(JSON.parse(run('--log', log, '--json').stdout.toString()).bots[0].status).toBe('stale')
      writeFileSync(log, event('poll.heartbeat') + event('poll.error'))
      expect(run('--log', log).stdout.toString()).toContain('probe_bot degraded')
      for (const args of [[], ['--log'], ['--log', log, '--max-age-ms', 'NaN'], ['--log', log, '--max-age-ms', '0']]) {
        expect(run(...args).exitCode).toBe(1)
      }
      expect(run('--log', join(root, 'absent')).exitCode).toBe(1)
      rmSync(botDir, { recursive: true })
      expect(run('--log', log, '--json').exitCode).toBe(1) // zero bots is not healthy
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
