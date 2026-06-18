import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildManifest,
  readManifest,
  resolveIapeerRoot,
  runtimeManifestPath,
  writeManifestAtomic,
} from '../src/manifest.ts'

describe('resolveIapeerRoot', () => {
  test('IAPEER_ROOT wins (the seam: manifest under the right root)', () => {
    expect(resolveIapeerRoot({ IAPEER_ROOT: '/sbx/root', HOME: '/home/x' })).toBe('/sbx/root')
  })
  test('IAPEER_ROOT trimmed', () => {
    expect(resolveIapeerRoot({ IAPEER_ROOT: '  /sbx/root  ', HOME: '/home/x' })).toBe('/sbx/root')
  })
  test('falls back to $HOME/.iapeer when IAPEER_ROOT unset (prod unchanged)', () => {
    expect(resolveIapeerRoot({ HOME: '/home/x' })).toBe('/home/x/.iapeer')
  })
})

describe('runtimeManifestPath', () => {
  test('is <root>/runtimes/telegram/runtime.json (where the foundation reads)', () => {
    expect(runtimeManifestPath({ IAPEER_ROOT: '/sbx/root' })).toBe('/sbx/root/runtimes/telegram/runtime.json')
  })
})

describe('buildManifest', () => {
  const m = buildManifest('/abs/bin/telegram-runtime')

  test('runtime is "telegram"', () => {
    expect(m.runtime).toBe('telegram')
  })

  test('selfConfig is the OBJECT form with the absolute bin + self-config arg', () => {
    // String descriptor cannot carry the `self-config` arg → object form required.
    expect(m.selfConfig).toEqual({ command: '/abs/bin/telegram-runtime', args: ['self-config'] })
  })

  test('OPERATOR-ADD: NO peers[] (telegram humans arrive via `iapeer create`)', () => {
    expect(m.peers).toBeUndefined()
    expect('peers' in m).toBe(false)
  })
})

describe('writeManifestAtomic / readManifest', () => {
  function sandbox(): { env: NodeJS.ProcessEnv; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'tg-manifest-'))
    return { env: { IAPEER_ROOT: join(dir, 'root') }, dir }
  }

  test('writes under IAPEER_ROOT and round-trips; serialized form has no peers key', () => {
    const { env, dir } = sandbox()
    try {
      const path = writeManifestAtomic(buildManifest('/abs/bin/telegram-runtime'), env)
      expect(path).toBe(join(env.IAPEER_ROOT!, 'runtimes', 'telegram', 'runtime.json'))
      const onDisk = readFileSync(path, 'utf8')
      expect(onDisk).not.toContain('"peers"')
      const back = readManifest(env)
      expect(back?.runtime).toBe('telegram')
      expect(back?.selfConfig).toEqual({ command: '/abs/bin/telegram-runtime', args: ['self-config'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('idempotent: a repeat write is byte-identical', () => {
    const { env, dir } = sandbox()
    try {
      const p1 = writeManifestAtomic(buildManifest('/abs/bin/telegram-runtime'), env)
      const m1 = readFileSync(p1, 'utf8')
      const p2 = writeManifestAtomic(buildManifest('/abs/bin/telegram-runtime'), env)
      const m2 = readFileSync(p2, 'utf8')
      expect(p2).toBe(p1)
      expect(m2).toBe(m1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('readManifest returns null when absent', () => {
    const { env, dir } = sandbox()
    try {
      expect(readManifest(env)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
