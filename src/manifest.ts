// Runtime MANIFEST — the package-facing contract surface (Волна 2, doc «Протокол
// iapeer рантайма» § «Контракт пакета рантайма»). The package WRITES this at npx-
// install (self-deploy); the foundation only READS it (readRuntimeManifest →
// createPeer/deployRuntime). The path MUST match byte-for-byte where the foundation
// looks: <IAPEER_ROOT or ~/.iapeer>/runtimes/telegram/runtime.json
//
// OPERATOR-ADD mode (mode b): telegram peers are PEOPLE the package cannot know
// ahead of time, so the manifest declares NO `peers[]` — humans are added one at a
// time with `iapeer create <human> --runtime telegram`. (Contrast the notifier pilot,
// declared-set mode a, which lists timer+watcher.) The shared per-peer self-config
// hook is the same; only the enumeration differs.
//
// IAPEER_ROOT-aware: we re-implement the foundation's resolveGlobalRoot contract HERE
// (we cannot import from the foundation repo — it is a separate package). The rule is
// the SAME: IAPEER_ROOT env wins, else $HOME/.iapeer. A manifest written under the
// wrong root (npx not inheriting IAPEER_ROOT) is the most likely first failure — so we
// always resolve it from the passed env, never hard-code ~/.iapeer.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { RUNTIME, VERSION } from './constants.ts'

/** A self-config hook descriptor (mirror of the foundation's SelfConfigDescriptor):
 *  a bare command (PATH-resolvable / absolute) or {command, args}. We always emit the
 *  OBJECT form — a string descriptor carries no args, but the hook needs the
 *  `self-config` subcommand, and we pin the ABSOLUTE installed bin so the hook is
 *  PATH-independent (the foundation runs it with cwd=peer.cwd + namespaced env). */
export interface SelfConfigDescriptor {
  command: string
  args?: string[]
}

/** One declared peer in a package's FIXED set (mode a). telegram (operator-add, mode
 *  b) emits NO peers[], so this is only here for round-trip type fidelity with the
 *  frozen manifest schema. */
export interface RuntimePeerDecl {
  personality: string
  intelligence?: 'absent' | 'natural' | 'artificial'
  description?: string
  path?: string
  runtimeBin?: string
}

export interface RuntimeManifest {
  runtime: string
  /** Package version, stamped from package.json (see VERSION). The foundation schema
   *  (runtime/index.ts) declares it; it powers `iapeer status` version reporting and
   *  `update-runtime` gating against npm-latest. Optional in the type for round-trip
   *  fidelity with legacy manifests written before it was stamped. */
  version?: string
  selfConfig?: string | SelfConfigDescriptor
  peers?: RuntimePeerDecl[]
}

/** Mirror of the foundation's resolveGlobalRoot: IAPEER_ROOT wins, else $HOME/.iapeer.
 *  Re-implemented (not imported) because the foundation is a separate package; kept in
 *  lockstep with its contract on purpose. */
export function resolveIapeerRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.IAPEER_ROOT?.trim()
  if (override) return override
  const home = env.HOME?.trim() || homedir()
  if (!home) throw new Error('cannot resolve home directory for ~/.iapeer')
  return join(home, '.iapeer')
}

/** <root>/runtimes/telegram/runtime.json (IAPEER_ROOT-aware). */
export function runtimeManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveIapeerRoot(env), 'runtimes', RUNTIME, 'runtime.json')
}

/**
 * Build the telegram runtime manifest. `binPath` is the ABSOLUTE path the self-
 * installer placed the launcher at — pinned into the self-config descriptor so the
 * hook resolves without any PATH dependency. OPERATOR-ADD: NO `peers[]` (the package
 * does not know the humans ahead of time; they arrive via `iapeer create`).
 */
export function buildManifest(binPath: string): RuntimeManifest {
  return {
    runtime: RUNTIME,
    version: VERSION,
    selfConfig: { command: binPath, args: ['self-config'] },
    // NO peers[] — operator-add. Omitted on purpose (foundation reads its absence as
    // "operator-add only"; deployRuntime.operatorAddOnly === true).
  }
}

/** Write the manifest atomically (tmp+rename) under <root>/runtimes/telegram/. mkdir
 *  -p the runtime dir first. Returns the written path. Idempotent: a repeat write
 *  produces byte-identical content (stable key order, sorted-by-construction). */
export function writeManifestAtomic(manifest: RuntimeManifest, env: NodeJS.ProcessEnv = process.env): string {
  const path = runtimeManifestPath(env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  renameSync(tmp, path)
  return path
}

/** Read the manifest, or null when absent. Throws on present-but-malformed JSON (it
 *  is our declared contract — a corruption should surface, not silently degrade). */
export function readManifest(env: NodeJS.ProcessEnv = process.env): RuntimeManifest | null {
  const path = runtimeManifestPath(env)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as RuntimeManifest
}
