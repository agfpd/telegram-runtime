import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleStopCommand } from '../src/cli.ts'

// Hermetic, non-destructive integration proof for the stop→interrupt path.
// We point TELEGRAM_RUNTIME_IAPEER_BIN at a stub that records its argv and exits
// with a scripted code, so the test asserts (a) the exact spawn contract
// (`interrupt <personality>`, NO runtime — iapeer ≥0.4.130 fans out to all live
// runtimes) and (b) the
// exit-code→operator-feedback mapping — without touching any real peer session.

const tmp = mkdtempSync(join(tmpdir(), 'stop-handler-'))
const argvFile = join(tmp, 'argv.txt')
const prevBin = process.env.TELEGRAM_RUNTIME_IAPEER_BIN

afterEach(() => {
  if (prevBin === undefined) delete process.env.TELEGRAM_RUNTIME_IAPEER_BIN
  else process.env.TELEGRAM_RUNTIME_IAPEER_BIN = prevBin
})

// Build a stub `iapeer` that appends its argv to argvFile, prints `out` to
// stdout / `err` to stderr, and exits with `code`.
function installStub(code: number, out: string, err: string): void {
  const path = join(tmp, `iapeer-stub-${code}-${Math.abs(out.length + err.length)}`)
  const script =
    `#!/bin/sh\n` +
    `printf '%s\\n' "$*" >> ${JSON.stringify(argvFile)}\n` +
    `printf '%s' ${JSON.stringify(out)}\n` +
    `printf '%s' ${JSON.stringify(err)} 1>&2\n` +
    `exit ${code}\n`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  process.env.TELEGRAM_RUNTIME_IAPEER_BIN = path
}

function fakeBot(sent: string[]): any {
  return { api: { sendMessage: async (_chatId: string, text: string) => void sent.push(text) } }
}

const target: any = { personality: 'darwin', runtime: 'claude', cwd: '/tmp/x' }

describe('handleStopCommand — spawn contract + feedback mapping', () => {
  test('exit 0 → spawns runtime-less `interrupt <personality>` and confirms', async () => {
    writeFileSync(argvFile, '')
    installStub(0, 'interrupt → darwin (claude, opencode)\n', '')
    const sent: string[] = []
    await handleStopCommand(fakeBot(sent), '123', target)
    expect(readFileSync(argvFile, 'utf8').trim()).toBe('interrupt darwin')
    expect(sent).toEqual(['interrupted'])
  })

  test('partial failure (exit 0 + stderr failed) → still confirms interrupted', async () => {
    writeFileSync(argvFile, '')
    installStub(0, 'interrupt → darwin (claude)\n', 'interrupt: darwin (opencode) failed: timeout\n')
    const sent: string[] = []
    await handleStopCommand(fakeBot(sent), '1', target)
    expect(sent).toEqual(['interrupted'])
  })

  test('exit 1 with "peer offline" → reports peer not in a live session', async () => {
    installStub(1, '', 'interrupt: cannot control "darwin": peer offline: darwin (claude)\n')
    const sent: string[] = []
    await handleStopCommand(fakeBot(sent), '123', target)
    expect(sent).toEqual(['not in an active session'])
  })

  test('unexpected non-zero exit → surfaces the error, never silently swallows', async () => {
    installStub(1, '', 'interrupt: some other failure\n')
    const sent: string[] = []
    await handleStopCommand(fakeBot(sent), '123', target)
    expect(sent[0]).toContain('interrupt failed')
    expect(sent[0]).toContain('some other failure')
  })

  test('spawn failure (missing binary) → surfaces, does not throw', async () => {
    process.env.TELEGRAM_RUNTIME_IAPEER_BIN = join(tmp, 'definitely-not-here')
    const sent: string[] = []
    await handleStopCommand(fakeBot(sent), '123', target)
    expect(sent[0]).toContain('interrupt failed')
  })
})

process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
