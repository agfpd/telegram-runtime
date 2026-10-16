import { describe, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { publishInstallPair } from '../src/installPair.ts'
import { buildManifest, runtimeManifestPath } from '../src/manifest.ts'

describe('publishInstallPair', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'tg-pair-'))
    const env = { HOME: dir, IAPEER_ROOT: join(dir, 'root') }
    const bin = join(dir, 'bin', 'telegram-runtime')
    const stage = `${bin}.tmp`
    const manifest = runtimeManifestPath(env)
    mkdirSync(dirname(bin), { recursive: true })
    mkdirSync(dirname(manifest), { recursive: true })
    writeFileSync(bin, 'old signed executable', { mode: 0o755 })
    writeFileSync(stage, 'new signed executable', { mode: 0o755 })
    writeFileSync(manifest, 'old manifest')
    return { dir, env, bin, stage, manifest }
  }
  for (const legacySymlink of [false, true]) {
    test(`manifest rename failure rolls back exact old ${legacySymlink ? 'symlink' : 'binary inode'}, no debris`, () => {
      const f = fixture()
      try {
        if (legacySymlink) {
          const target = join(f.dir, 'legacy')
          renameSync(f.bin, target)
          symlinkSync(target, f.bin)
        }
        const original = lstatSync(f.bin)
        expect(() => publishInstallPair(f.stage, f.bin, buildManifest(f.bin), f.env, (src, dest) => {
          if (dest === f.manifest) throw new Error('injected manifest rename EACCES')
          renameSync(src, dest)
        })).toThrow('EACCES')
        expect(readFileSync(f.bin, 'utf8')).toBe('old signed executable')
        if (!legacySymlink) expect(lstatSync(f.bin).ino).toBe(original.ino)
        expect(lstatSync(f.bin).mode).toBe(original.mode)
        expect(lstatSync(f.bin).isSymbolicLink()).toBe(legacySymlink)
        expect(readFileSync(f.manifest, 'utf8')).toBe('old manifest')
        expect(readdirSync(dirname(f.bin))).toEqual(['telegram-runtime'])
        expect(readdirSync(dirname(f.manifest))).toEqual(['runtime.json'])
      } finally { rmSync(f.dir, { recursive: true, force: true }) }
    })
  }
  test('first install manifest failure restores absence of binary', () => {
    const f = fixture()
    try {
      rmSync(f.bin)
      expect(() => publishInstallPair(f.stage, f.bin, buildManifest(f.bin), f.env, (src, dest) => {
        if (dest === f.manifest) throw new Error('manifest failed')
        renameSync(src, dest)
      })).toThrow('manifest failed')
      expect(readdirSync(dirname(f.bin))).toEqual([])
      expect(readFileSync(f.manifest, 'utf8')).toBe('old manifest')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
  test('manifest staging failure never changes installed binary', () => {
    const f = fixture()
    try {
      rmSync(f.env.IAPEER_ROOT, { recursive: true })
      writeFileSync(f.env.IAPEER_ROOT, 'obstruction')
      expect(() => publishInstallPair(f.stage, f.bin, buildManifest(f.bin), f.env)).toThrow()
      expect(readFileSync(f.bin, 'utf8')).toBe('old signed executable')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
  test('valid publication replaces both artifacts and cleans retained inode', () => {
    const f = fixture()
    try {
      chmodSync(f.stage, 0o755)
      expect(publishInstallPair(f.stage, f.bin, buildManifest(f.bin), f.env)).toBe(f.manifest)
      expect(readFileSync(f.bin, 'utf8')).toBe('new signed executable')
      expect(JSON.parse(readFileSync(f.manifest, 'utf8')).selfConfig.command).toBe(f.bin)
      expect(readdirSync(dirname(f.bin))).toEqual(['telegram-runtime'])
      expect(readdirSync(dirname(f.manifest))).toEqual(['runtime.json'])
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
  test('failure before binary publication leaves both old artifacts unchanged', () => {
    const f = fixture()
    try {
      expect(() => publishInstallPair(f.stage, f.bin, buildManifest(f.bin), f.env, () => {
        throw new Error('binary publication denied')
      })).toThrow('binary publication denied')
      expect(readFileSync(f.bin, 'utf8')).toBe('old signed executable')
      expect(readFileSync(f.manifest, 'utf8')).toBe('old manifest')
      expect(readdirSync(dirname(f.bin))).toEqual(['telegram-runtime', 'telegram-runtime.tmp'])
      expect(readdirSync(dirname(f.manifest))).toEqual(['runtime.json'])
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
  test('unrecoverable rollback error reports and retains the old executable for recovery', () => {
    const f = fixture()
    try {
      expect(() => publishInstallPair(f.stage, f.bin, buildManifest(f.bin), f.env, (src, dest) => {
        if (dest === f.manifest || String(src).endsWith('.rollback')) throw new Error('I/O unavailable')
        renameSync(src, dest)
      })).toThrow('pair publication and rollback failed')
      const saved = readdirSync(dirname(f.bin)).find(n => n.endsWith('.rollback'))!
      expect(saved).toBeDefined()
      expect(readFileSync(join(dirname(f.bin), saved), 'utf8')).toBe('old signed executable')
      expect(readFileSync(f.manifest, 'utf8')).toBe('old manifest')
      expect(readdirSync(dirname(f.manifest))).toEqual(['runtime.json'])
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
})
