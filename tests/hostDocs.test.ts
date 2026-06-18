// FU6 — hermetic tests for scaffoldHostDocs (the per-package on-host docs convention
// <IAPEER_ROOT>/docs/<pkg>/). Mirrors the foundation's docs.test.ts. Everything runs
// against an injected temp root (IAPEER_ROOT) under IAPEER_TEST_SANDBOX=1; the real
// ~/.iapeer is never touched.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { scaffoldHostDocs } from '../src/hostDocs.ts'

let base: string
let docsSrc: string
let env: NodeJS.ProcessEnv

function writeDocsFixture(): void {
  docsSrc = join(base, 'pkg', 'docs')
  mkdirSync(join(docsSrc, 'ru'), { recursive: true })
  mkdirSync(join(docsSrc, 'internals'), { recursive: true })
  writeFileSync(join(docsSrc, 'README.md'), '# contract')
  writeFileSync(join(docsSrc, '03-bots-and-bindings.md'), 'bots')
  writeFileSync(join(docsSrc, 'ru', '03-боты-и-привязки.md'), 'боты')
  writeFileSync(join(docsSrc, 'internals', 'secret.md'), 'internal-only')
  // macOS clutter that a dev/host tree carries — must NOT leak into the on-host copy.
  writeFileSync(join(docsSrc, '.DS_Store'), 'mac')
  writeFileSync(join(docsSrc, 'ru', '.DS_Store'), 'mac')
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'tg-docs-'))
  env = { HOME: base, IAPEER_ROOT: join(base, '.iapeer'), IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv
  writeDocsFixture()
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('scaffoldHostDocs', () => {
  test('copies docs to <root>/docs/telegram-runtime/, EXCLUDING internals and .DS_Store', () => {
    const r = scaffoldHostDocs('telegram-runtime', docsSrc, env)
    expect(r.copied).toBe(true)
    expect(r.dest).toBe(join(base, '.iapeer', 'docs', 'telegram-runtime'))
    expect(readFileSync(join(r.dest, 'README.md'), 'utf8')).toBe('# contract')
    expect(existsSync(join(r.dest, 'ru', '03-боты-и-привязки.md'))).toBe(true)
    expect(existsSync(join(r.dest, 'internals'))).toBe(false) // internals subtree skipped
    expect(existsSync(join(r.dest, '.DS_Store'))).toBe(false) // macOS clutter skipped
    expect(existsSync(join(r.dest, 'ru', '.DS_Store'))).toBe(false) // nested too
    expect(existsSync(`${r.dest}.tmp-${process.pid}`)).toBe(false) // no temp leftover
  })

  test('per-package layout: a second package lands in its OWN subdir, siblings kept', () => {
    scaffoldHostDocs('telegram-runtime', docsSrc, env)
    scaffoldHostDocs('iapeer', docsSrc, env)
    expect(existsSync(join(base, '.iapeer', 'docs', 'telegram-runtime', 'README.md'))).toBe(true)
    expect(existsSync(join(base, '.iapeer', 'docs', 'iapeer', 'README.md'))).toBe(true)
  })

  test('refresh: re-running replaces the package docs cleanly (stale files pruned)', () => {
    scaffoldHostDocs('telegram-runtime', docsSrc, env)
    const dest = join(base, '.iapeer', 'docs', 'telegram-runtime')
    writeFileSync(join(dest, 'STALE.md'), 'old') // simulate a removed-in-newer-version doc
    rmSync(join(docsSrc, '03-bots-and-bindings.md')) // source changed
    const r = scaffoldHostDocs('telegram-runtime', docsSrc, env)
    expect(r.copied).toBe(true)
    expect(existsSync(join(dest, 'STALE.md'))).toBe(false) // atomic swap drops the old tree
    expect(existsSync(join(dest, '03-bots-and-bindings.md'))).toBe(false)
    expect(existsSync(join(dest, 'README.md'))).toBe(true)
  })

  test('missing source → soft skip (never fails the install)', () => {
    const r = scaffoldHostDocs('telegram-runtime', join(base, 'nope'), env)
    expect(r.copied).toBe(false)
    expect(r.reason).toMatch(/not found/)
  })

  test('sandbox guard: refuses the REAL ~/.iapeer/docs under IAPEER_TEST_SANDBOX=1', () => {
    // Real HOME + no IAPEER_ROOT → resolves to the real ~/.iapeer/docs → must throw.
    expect(() =>
      scaffoldHostDocs('telegram-runtime', docsSrc, { HOME: homedir(), IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv),
    ).toThrow(/refusing to scaffold docs into the REAL/)
  })
})
