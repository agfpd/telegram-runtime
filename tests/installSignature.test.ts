import { describe, expect, test } from 'bun:test'
import { ensureExecutableSignature, type InstallCommandResult, type InstallCommandRunner } from '../src/installSignature.ts'

const path = '/sandbox/bin/telegram-runtime.tmp'
const ok: InstallCommandResult = { status: 0, stdout: '', stderr: '' }
const invalid: InstallCommandResult = { status: 1, stdout: '', stderr: 'invalid signature' }

function harness(results: InstallCommandResult[]) {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  const env = { HOME: '/sandbox' }
  const run: InstallCommandRunner = (command, args, passedEnv) => {
    calls.push({ command, args, env: passedEnv })
    const result = results.shift()
    if (!result) throw new Error('unexpected runner call')
    return result
  }
  return { calls, opts: { platform: 'darwin' as const, run, env }, env }
}

describe('ensureExecutableSignature', () => {
  test('valid signature: strict verify only, no re-signing/TCC identity change', () => {
    const h = harness([ok])
    ensureExecutableSignature(path, h.opts)
    expect(h.calls).toEqual([{ command: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', path], env: h.env }])
  })

  test('invalid signature: verify → ad-hoc sign → strict re-verify, always staged path', () => {
    const h = harness([invalid, ok, ok])
    ensureExecutableSignature(path, h.opts)
    expect(h.calls.map(c => [c.command, ...c.args])).toEqual([
      ['/usr/bin/codesign', '--verify', '--deep', '--strict', path],
      ['/usr/bin/codesign', '--force', '--sign', '-', path],
      ['/usr/bin/codesign', '--verify', '--deep', '--strict', path],
    ])
    expect(h.calls.every(c => c.env === h.env)).toBe(true)
  })

  for (const [name, result] of [
    ['nonzero', invalid],
    ['spawn error', { ...ok, status: null, error: new Error('ENOENT') }],
    ['killed', { ...ok, status: null, signal: 'SIGKILL' }],
    ['null status', { ...ok, status: null }],
  ] as const) {
    test(`sign ${name}: throws, no follow-up verification`, () => {
      const h = harness([invalid, result])
      expect(() => ensureExecutableSignature(path, h.opts)).toThrow('codesign sign failed')
      expect(h.calls.length).toBe(2)
    })
    test(`re-verify ${name}: throws rather than trusting successful sign`, () => {
      const h = harness([invalid, ok, result])
      expect(() => ensureExecutableSignature(path, h.opts)).toThrow('codesign verify after repair failed')
      expect(h.calls.length).toBe(3)
    })
    if (name !== 'nonzero') {
      test(`initial verify ${name}: fail closed, do not overwrite a possibly valid signature`, () => {
        const h = harness([result])
        expect(() => ensureExecutableSignature(path, h.opts)).toThrow('codesign verify failed')
        expect(h.calls.length).toBe(1)
      })
    }
  }

  test('runner exception propagates fail-closed', () => {
    expect(() => ensureExecutableSignature(path, {
      platform: 'darwin', run: () => { throw new Error('runner exception') },
    })).toThrow('runner exception')
  })

  for (const platform of ['linux', 'win32'] as const) {
    test(`${platform}: no signing tool invoked`, () => {
      const h = harness([])
      ensureExecutableSignature(path, { ...h.opts, platform })
      expect(h.calls).toEqual([])
    })
  }
})
