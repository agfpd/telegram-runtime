import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireProcessLock } from '../src/botLock.ts'

function tempLock(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-bot-lock-'))
  return { dir, path: join(dir, 'runtime.lock') }
}

async function waitFor(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(20)
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`)
}

describe('identity-aware bot runtime lock', () => {
  test('legacy PID-only lock owned by a live foreign process is reclaimed (PID reuse regression)', async () => {
    const { dir, path } = tempLock()
    const foreign = Bun.spawn(['/bin/sleep', '30'])
    try {
      writeFileSync(path, `${foreign.pid}\n`, { mode: 0o600 })

      const release = acquireProcessLock(path, 'bot "pid_reuse_bot"')
      const owner = JSON.parse(readFileSync(path, 'utf8'))
      expect(owner).toMatchObject({ version: 1, pid: process.pid })
      expect(owner.processStarted).toBeString()
      expect(owner.executable).toBeString()
      expect(owner.instance).toBeString()
      expect(() => process.kill(foreign.pid, 0)).not.toThrow()

      release()
      expect(existsSync(path)).toBe(false)
    } finally {
      foreign.kill()
      await foreign.exited
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('v1 lock whose PID now identifies a different process instance is reclaimed', async () => {
    const { dir, path } = tempLock()
    const foreign = Bun.spawn(['/bin/sleep', '30'])
    try {
      writeFileSync(
        path,
        `${JSON.stringify({
          version: 1,
          pid: foreign.pid,
          processStarted: 'Sun Jan  1 00:00:00 1970',
          executable: '/old/bin/telegram-runtime',
          command: '/old/bin/telegram-runtime run',
          instance: 'dead-runtime-instance',
        })}\n`,
        { mode: 0o600 },
      )

      const release = acquireProcessLock(path, 'bot "pid_reuse_v1_bot"')
      expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid)
      expect(() => process.kill(foreign.pid, 0)).not.toThrow()
      release()
    } finally {
      foreign.kill()
      await foreign.exited
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a concurrent real lock owner still blocks a second runtime', async () => {
    const { dir, path } = tempLock()
    const ready = join(dir, 'ready')
    const helper = join(dir, 'holder.ts')
    const moduleUrl = new URL('../src/botLock.ts', import.meta.url).href
    writeFileSync(
      helper,
      `import { acquireProcessLock } from ${JSON.stringify(moduleUrl)}\n` +
        `const release = acquireProcessLock(${JSON.stringify(path)}, 'bot "concurrent_bot"')\n` +
        `await Bun.write(${JSON.stringify(ready)}, String(process.pid))\n` +
        `process.once('SIGTERM', () => { release(); process.exit(0) })\n` +
        `await new Promise(() => {})\n`,
    )
    const holder = Bun.spawn([process.execPath, helper], { stderr: 'pipe' })
    try {
      await waitFor(ready)
      const holderPid = Number(readFileSync(ready, 'utf8'))
      expect(holderPid).toBe(holder.pid)
      expect(() => acquireProcessLock(path, 'bot "concurrent_bot"')).toThrow(
        `bot "concurrent_bot" is already owned by pid ${holder.pid}`,
      )
    } finally {
      holder.kill('SIGTERM')
      await holder.exited
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
