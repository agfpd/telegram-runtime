import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleLifecycleCommand, parseLifecycleCommand, runControlBinary } from '../src/cli.ts'

// Mirrors stop-handler.test.ts: a stub `iapeer` records argv and exits with a
// scripted code, proving (a) the exact spawn contract (`<op> <personality>
// <runtime>`, runtime explicit) and (b) the exit-code→operator-feedback
// mapping — without touching any real peer session.

const tmp = mkdtempSync(join(tmpdir(), 'lifecycle-handler-'))
const argvFile = join(tmp, 'argv.txt')
const prevBin = process.env.TELEGRAM_RUNTIME_IAPEER_BIN

afterEach(() => {
  if (prevBin === undefined) delete process.env.TELEGRAM_RUNTIME_IAPEER_BIN
  else process.env.TELEGRAM_RUNTIME_IAPEER_BIN = prevBin
})

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

describe('parseLifecycleCommand — bare slash = control, everything else = delivery', () => {
  test('bare commands and @botname suffix detect', () => {
    expect(parseLifecycleCommand('/new')).toBe('new')
    expect(parseLifecycleCommand('/compact')).toBe('compact')
    expect(parseLifecycleCommand(' /new ')).toBe('new')
    expect(parseLifecycleCommand('/new@darwin_claudecode_bot')).toBe('new')
    expect(parseLifecycleCommand('/compact@darwin_claudecode_bot')).toBe('compact')
  })

  test('anything beyond the pure command flows to delivery', () => {
    expect(parseLifecycleCommand('/new прошу')).toBeNull()
    expect(parseLifecycleCommand('/compact сейчас же')).toBeNull()
    expect(parseLifecycleCommand('new')).toBeNull()
    expect(parseLifecycleCommand('compact')).toBeNull()
    expect(parseLifecycleCommand('/renew')).toBeNull()
    expect(parseLifecycleCommand('/newx')).toBeNull()
    expect(parseLifecycleCommand('/alias-new')).toBeNull()
    expect(parseLifecycleCommand('/new!')).toBeNull()
    expect(parseLifecycleCommand('сделай /new')).toBeNull()
  })
})

describe('handleLifecycleCommand — spawn contract + feedback mapping', () => {
  test('/new: exit 0 → pre-ack, spawns `new <personality> <runtime>`, confirms READY', async () => {
    writeFileSync(argvFile, '')
    installStub(0, 'new: claude-darwin fresh session up\n', '')
    const sent: string[] = []
    await handleLifecycleCommand(fakeBot(sent), '123', target, 'new')
    expect(readFileSync(argvFile, 'utf8').trim()).toBe('new darwin claude')
    expect(sent).toEqual(['restarting session...', 'fresh session up'])
  })

  test('/compact: exit 0 → spawns `compact <personality> <runtime>` and confirms', async () => {
    writeFileSync(argvFile, '')
    installStub(0, 'compact → darwin (claude)\n', '')
    const sent: string[] = []
    await handleLifecycleCommand(fakeBot(sent), '123', target, 'compact')
    expect(readFileSync(argvFile, 'utf8').trim()).toBe('compact darwin claude')
    expect(sent).toEqual(['context compacted'])
  })

  test('compact offline → reports peer not in a live session', async () => {
    installStub(1, '', 'compact: cannot control "darwin": peer offline: darwin (claude)\n')
    const sent: string[] = []
    await handleLifecycleCommand(fakeBot(sent), '123', target, 'compact')
    expect(sent).toEqual(['not in an active session'])
  })

  test('compact nothing-to-compact token → reports a normal no-op, not failure', async () => {
    installStub(1, '', 'compact: nothing-to-compact — context is fresh; nothing to compact\n')
    const sent: string[] = []
    await handleLifecycleCommand(fakeBot(sent), '123', target, 'compact')
    expect(sent).toEqual(['nothing to compact — context is fresh'])
  })

  test('compact nothing-to-compact token is recognized on stdout too', async () => {
    installStub(1, 'nothing-to-compact: context is fresh; nothing to compact\n', '')
    const sent: string[] = []
    await handleLifecycleCommand(fakeBot(sent), '123', target, 'compact')
    expect(sent).toEqual(['nothing to compact — context is fresh'])
  })

  test('unexpected non-zero exit → surfaces the error, never silently swallows', async () => {
    installStub(1, '', 'new: darwin (claude): failed — boot deadline\n')
    const sent: string[] = []
    await handleLifecycleCommand(fakeBot(sent), '123', target, 'new')
    // sent[0] is the /new pre-ack; the verdict follows.
    expect(sent[1]).toContain('new failed')
    expect(sent[1]).toContain('failed — boot deadline')
  })

  test('runControlBinary kills a hung child on timeout and resolves (never hangs)', async () => {
    const r = await runControlBinary('/bin/sleep', ['30'], 300)
    expect(r.timedOut).toBe(true)
    expect(r.status).toBeNull()
  })

  test('spawn failure (missing binary) → surfaces, does not throw', async () => {
    process.env.TELEGRAM_RUNTIME_IAPEER_BIN = join(tmp, 'definitely-not-here')
    const sent: string[] = []
    await handleLifecycleCommand(fakeBot(sent), '123', target, 'compact')
    expect(sent[0]).toContain('compact failed')
  })
})

process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
