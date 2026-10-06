import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BIN_NAME, resolveBinDir, selfInstall } from '../src/selfInstall.ts'
import { type InstallCommandResult, type InstallCommandRunner } from '../src/installSignature.ts'

const SOURCE_ENTRY = join(import.meta.dir, '../src/cli.ts')

describe('resolveBinDir', () => {
  test('IAPEER_BIN_DIR wins (keeps the sandbox proof off the real ~/.local/bin)', () => {
    expect(resolveBinDir({ IAPEER_BIN_DIR: '/sbx/bin', HOME: '/home/x' })).toBe('/sbx/bin')
  })
  test('falls back to $HOME/.local/bin (on the launchd-minimal PATH)', () => {
    expect(resolveBinDir({ HOME: '/home/x' })).toBe('/home/x/.local/bin')
  })
  test('BIN_NAME is telegram-runtime (matches the foundation default launcher)', () => {
    expect(BIN_NAME).toBe('telegram-runtime')
  })
})

describe('selfInstall (real compile)', () => {
  function sandbox(): { env: NodeJS.ProcessEnv; root: string; binDir: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'tg-install-'))
    const root = join(dir, 'iapeer-root')
    const binDir = join(dir, 'bin')
    // IAPEER_TEST_SANDBOX=1 arms the fail-closed docs guard; IAPEER_ROOT points it at the
    // tmp root so the guard passes (it only throws for the REAL ~/.iapeer).
    const env = { ...process.env, HOME: dir, IAPEER_ROOT: root, IAPEER_BIN_DIR: binDir, IAPEER_TEST_SANDBOX: '1' }
    return { env, root, binDir, dir }
  }

  test(
    'places a compiled, executable bin on PATH + writes the manifest (no peers[]) under IAPEER_ROOT',
    () => {
      const { env, root, binDir, dir } = sandbox()
      try {
        const r = selfInstall({ env, sourceEntry: SOURCE_ENTRY })

        expect(r.binMode).toBe('compiled')
        expect(r.binPath).toBe(join(binDir, 'telegram-runtime'))
        expect(r.root).toBe(root)
        const st = statSync(r.binPath)
        expect(st.isFile()).toBe(true)
        expect(st.mode & 0o111).toBeGreaterThan(0)

        // manifest under the RIGHT root, operator-add (no peers[])
        expect(r.manifestPath).toBe(join(root, 'runtimes', 'telegram', 'runtime.json'))
        const manifest = JSON.parse(readFileSync(r.manifestPath, 'utf8'))
        expect(manifest.runtime).toBe('telegram')
        expect(manifest.selfConfig).toEqual({ command: r.binPath, args: ['self-config'] })
        expect(manifest.peers).toBeUndefined()

        // FU6 on-host docs scaffolded from the package's real docs/ (next to the source
        // entry) into <root>/docs/telegram-runtime/, EXCLUDING internals.
        expect(r.docs.copied).toBe(true)
        expect(r.docs.dest).toBe(join(root, 'docs', 'telegram-runtime'))
        expect(statSync(join(r.docs.dest, 'README.md')).isFile()).toBe(true)
        expect(existsSync(join(r.docs.dest, 'internals'))).toBe(false)

        // the compiled bin actually runs (self-contained snapshot, grammy bundled)
        const help = spawnSync(r.binPath, ['--help'], { encoding: 'utf8' })
        expect(help.status).toBe(0)
        expect(help.stdout).toContain('self-install')
        expect(help.stdout).toContain('self-config')
        expect(help.stdout).toContain('run')

        if (process.platform === 'darwin') {
          expect(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', r.binPath]).status).toBe(0)
          // Exercise the real compiled executable's copy-self path, not a source
          // simulation. Both roots/bin dirs stay sandboxed; production is untouched.
          const copyBinDir = join(dir, 'copy-bin')
          const copyRoot = join(dir, 'copy-root')
          const copied = spawnSync(r.binPath, ['self-install'], {
            encoding: 'utf8', env: { ...env, IAPEER_BIN_DIR: copyBinDir, IAPEER_ROOT: copyRoot },
          })
          expect(copied.status).toBe(0)
          expect(copied.stdout).toContain('copied-self')
          const copyBin = join(copyBinDir, BIN_NAME)
          expect(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', copyBin]).status).toBe(0)
          expect(readFileSync(copyBin).equals(readFileSync(r.binPath))).toBe(true)
          expect(spawnSync(copyBin, ['--help']).status).toBe(0)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    180_000,
  )

  test(
    'idempotent: a repeat install yields a byte-identical manifest and a present bin',
    () => {
      const { env, dir } = sandbox()
      try {
        const r1 = selfInstall({ env, sourceEntry: SOURCE_ENTRY })
        const m1 = readFileSync(r1.manifestPath, 'utf8')
        const r2 = selfInstall({ env, sourceEntry: SOURCE_ENTRY })
        const m2 = readFileSync(r2.manifestPath, 'utf8')
        expect(r2.manifestPath).toBe(r1.manifestPath)
        expect(m2).toBe(m1)
        expect(statSync(r2.binPath).isFile()).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    180_000,
  )
})

describe('selfInstall signature ordering/failure (sandbox + mock runners)', () => {
  const ok: InstallCommandResult = { status: 0, stdout: '', stderr: '' }
  const invalid: InstallCommandResult = { status: 1, stdout: '', stderr: 'invalid signature' }

  for (const mode of ['compiled', 'copied-self'] as const) {
    function fixture() {
      const dir = mkdtempSync(join(tmpdir(), 'tg-signature-'))
      const binDir = join(dir, 'bin')
      const root = join(dir, 'root')
      const binPath = join(binDir, BIN_NAME)
      const manifestDir = join(root, 'runtimes', 'telegram')
      const manifestPath = join(manifestDir, 'runtime.json')
      mkdirSync(binDir)
      mkdirSync(manifestDir, { recursive: true })
      writeFileSync(binPath, 'old executable')
      writeFileSync(manifestPath, 'old manifest')
      const sourceEntry = join(dir, 'entry.ts')
      writeFileSync(sourceEntry, 'console.log("hello")')
      const execPath = mode === 'compiled' ? '/sandbox/bun' : join(dir, 'running-bin')
      if (mode === 'copied-self') writeFileSync(execPath, 'new executable')
      const env = { ...process.env, HOME: dir, IAPEER_ROOT: root, IAPEER_BIN_DIR: binDir, IAPEER_TEST_SANDBOX: '1' }
      return { dir, binDir, binPath, manifestPath, env, sourceEntry, execPath }
    }

    function runner(f: ReturnType<typeof fixture>, results: InstallCommandResult[]) {
      const calls: string[][] = []
      const run: InstallCommandRunner = (command, args, env) => {
        calls.push([command, ...args])
        expect(env).toBe(f.env)
        // No command may see a published new binary or manifest before verification.
        expect(readFileSync(f.binPath, 'utf8')).toBe('old executable')
        expect(readFileSync(f.manifestPath, 'utf8')).toBe('old manifest')
        if (command === f.execPath) {
          expect(mode).toBe('compiled')
          expect(args.slice(0, 3)).toEqual(['build', '--compile', '--outfile'])
          writeFileSync(args[3], 'new executable')
          return ok
        }
        expect(command).toBe('/usr/bin/codesign')
        const tmp = args.at(-1)!
        expect(tmp.startsWith(`${f.binPath}.tmp.`)).toBe(true)
        expect(readFileSync(tmp, 'utf8')).toBe('new executable')
        expect(statSync(tmp).mode & 0o777).toBe(0o755) // chmod precedes verify
        const result = results.shift()
        if (!result) throw new Error('unexpected codesign')
        return result
      }
      return { calls, run }
    }

    for (const repair of [false, true]) {
      test(`${mode}: ${repair ? 'repair + re-verify' : 'valid signature'} precedes bin/manifest publication`, () => {
        const f = fixture()
        try {
          const h = runner(f, repair ? [invalid, ok, ok] : [ok])
          const result = selfInstall({ ...f, platform: 'darwin', run: h.run })
          expect(result.binMode).toBe(mode)
          expect(readFileSync(f.binPath, 'utf8')).toBe('new executable')
          expect(JSON.parse(readFileSync(f.manifestPath, 'utf8')).selfConfig.command).toBe(f.binPath)
          expect(h.calls.filter(c => c[0] === '/usr/bin/codesign').map(c => c[1])).toEqual(
            repair ? ['--verify', '--force', '--verify'] : ['--verify'],
          )
          expect(readdirSync(f.binDir)).toEqual([BIN_NAME])
        } finally { rmSync(f.dir, { recursive: true, force: true }) }
      })
    }

    for (const [name, results] of [
      ['sign failure', [invalid, invalid]],
      ['verify after repair failure', [invalid, ok, invalid]],
      ['verify spawn failure', [{ ...ok, status: null, error: new Error('ENOENT') }]],
    ] as const) {
      test(`${mode}: ${name} preserves old bin + manifest and removes tmp (no .dead)`, () => {
        const f = fixture()
        try {
          const h = runner(f, [...results])
          expect(() => selfInstall({ ...f, platform: 'darwin', run: h.run })).toThrow('codesign')
          expect(readFileSync(f.binPath, 'utf8')).toBe('old executable')
          expect(readFileSync(f.manifestPath, 'utf8')).toBe('old manifest')
          expect(readdirSync(f.binDir)).toEqual([BIN_NAME])
        } finally { rmSync(f.dir, { recursive: true, force: true }) }
      })
    }

    test(`${mode}: non-macOS never invokes codesign`, () => {
      const f = fixture()
      try {
        const h = runner(f, [])
        expect(selfInstall({ ...f, platform: 'linux', run: h.run }).binMode).toBe(mode)
        expect(h.calls.some(c => c[0] === '/usr/bin/codesign')).toBe(false)
      } finally { rmSync(f.dir, { recursive: true, force: true }) }
    })

    test(`${mode}: runner exception removes staged output and preserves installed pair`, () => {
      const f = fixture()
      try {
        const h = runner(f, [])
        const run: InstallCommandRunner = (command, args, env) => {
          if (command === '/usr/bin/codesign') throw new Error('verifier unavailable')
          return h.run(command, args, env)
        }
        expect(() => selfInstall({ ...f, platform: 'darwin', run })).toThrow('verifier unavailable')
        expect(readFileSync(f.binPath, 'utf8')).toBe('old executable')
        expect(readFileSync(f.manifestPath, 'utf8')).toBe('old manifest')
        expect(readdirSync(f.binDir)).toEqual([BIN_NAME])
      } finally { rmSync(f.dir, { recursive: true, force: true }) }
    })

    test(`${mode}: staging failure preserves installed files and cleans partial output`, () => {
      const f = fixture()
      try {
        if (mode === 'copied-self') rmSync(f.execPath)
        const run: InstallCommandRunner = (_command, args) => {
          writeFileSync(args[3], 'partial output')
          return { ...invalid, stderr: 'compile failed' }
        }
        expect(() => selfInstall({ ...f, platform: 'darwin', run })).toThrow()
        expect(readFileSync(f.binPath, 'utf8')).toBe('old executable')
        expect(readFileSync(f.manifestPath, 'utf8')).toBe('old manifest')
        expect(readdirSync(f.binDir)).toEqual([BIN_NAME])
      } finally { rmSync(f.dir, { recursive: true, force: true }) }
    })
  }
})
