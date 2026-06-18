// npx-self-install — the package's self-deploy (Волна 2, doc «Установка и упаковка +
// onboard» § «Self-install + гибрид-деплой»). `npx @agfpd/telegram-runtime` (a bare,
// no-subcommand invocation — the foundation's defaultNpxRunner runs `npx -y <pkg>`
// with NO args) IDEMPOTENTLY:
//   (a) puts an executable `telegram-runtime` on PATH (a self-contained `bun build
//       --compile` snapshot — decoupled from the npm-cache source dir, which GC's),
//   (b) writes the runtime manifest at <IAPEER_ROOT>/runtimes/telegram/runtime.json.
//
// This is the npx↔foundation seam: after this, `iapeer create <human> --runtime
// telegram` resolves the launcher on PATH (provisionPeer refuses a crash-looper if it
// is missing), bakes its abs path into the always-on plist (TELEGRAM_RUNTIME_BIN), and
// runs the per-peer self-config hook the manifest declares. Two ordering invariants:
// the manifest lands under the RIGHT root (manifest.ts resolves IAPEER_ROOT from env),
// and the bin is on PATH BEFORE provision (this runs first).
//
// Bin placement: IAPEER_BIN_DIR override → else ~/.local/bin (the standard user-bin,
// same home as the foundation's `iapeer`, and on the launchd-minimal PATH the plist
// bakes — `~/.bun/bin:~/.local/bin:/opt/homebrew/bin:/usr/bin:/bin`). Overwriting a
// legacy ~/.local/bin/telegram-runtime symlink with a real compiled bin is INTENDED
// (the package now owns this path); a sandbox proof sets IAPEER_BIN_DIR so a test never
// touches the real ~/.local/bin.

import { spawnSync } from 'child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { BIN_NAME, PACKAGE_NAME } from './constants.ts'
import { scaffoldHostDocs, type HostDocsResult } from './hostDocs.ts'
import { buildManifest, resolveIapeerRoot, writeManifestAtomic } from './manifest.ts'

/** The launcher binary name (`telegram-runtime`). Re-exported so callers/tests have a
 *  single import surface for the self-install contract. */
export { BIN_NAME }

export interface SelfInstallOptions {
  env?: NodeJS.ProcessEnv
  /** The cli.ts source entry to compile (default: this module's sibling cli.ts). When
   *  it is not a real .ts file on disk (running FROM a compiled bin), self-install
   *  falls back to copying the running executable instead of recompiling. */
  sourceEntry?: string
  /** The running interpreter / compiled bin (default process.execPath). When the
   *  source path is real and this is `bun`, it is the compiler we invoke. */
  execPath?: string
  /** FU6 on-host docs source dir. Default: `<package-root>/docs` derived from
   *  `sourceEntry` (`<pkg>/src/cli.ts` → `<pkg>/docs`). Missing (e.g. running from a
   *  compiled bin with no source tree) → soft-skip, never fails the install. */
  docsSource?: string
}

export type SelfInstallBinMode = 'compiled' | 'copied-self'

export interface SelfInstallResult {
  binPath: string
  manifestPath: string
  binMode: SelfInstallBinMode
  root: string
  binDir: string
  /** FU6 on-host docs scaffolding verdict (best-effort; never blocks the install). */
  docs: HostDocsResult
}

/** Resolve the bin dir: IAPEER_BIN_DIR override → else ~/.local/bin. */
export function resolveBinDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.IAPEER_BIN_DIR?.trim()
  if (override) return override
  const home = env.HOME?.trim() || homedir()
  if (!home) throw new Error('cannot resolve home directory for the bin dir')
  return join(home, '.local', 'bin')
}

/** True when `path` is a real .ts source file we can `bun build --compile`. */
function isCompilableSource(path: string | undefined): path is string {
  if (!path || !path.endsWith('.ts')) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Is `execPath` a bun interpreter (so `<execPath> build` works)? When running
 *  `bun src/cli.ts`, process.execPath IS the bun binary (basename `bun`). A compiled
 *  telegram-runtime has basename `telegram-runtime` → NOT bun → we must not call
 *  `<it> build` (it would be `telegram-runtime build …`), so we fall back to copy-self. */
function isBunInterpreter(execPath: string): boolean {
  const base = execPath.split('/').pop() ?? execPath
  return base === 'bun' || base === 'bun-debug'
}

function cleanup(path: string): void {
  try {
    if (existsSync(path)) renameSync(path, `${path}.dead`)
  } catch {
    // best-effort
  }
}

/** Tiny deterministic string hash for a unique-ish tmp suffix (Math.random is avoided
 *  to keep the tmp name reproducible within a run). */
function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

/**
 * Self-install: place the launcher on PATH + write the manifest. IDEMPOTENT — a
 * repeat run produces the same on-disk bin and a byte-identical manifest (atomic
 * overwrite-in-place; no duplicated or divergent state). Returns what it did.
 */
export function selfInstall(opts: SelfInstallOptions = {}): SelfInstallResult {
  const env = opts.env ?? process.env
  const sourceEntry = opts.sourceEntry ?? join(import.meta.dir, 'cli.ts')
  // `<pkg>/docs` from the source entry's package root (`<pkg>/src/cli.ts` → `<pkg>/docs`).
  const docsSource = opts.docsSource ?? join(dirname(sourceEntry), '..', 'docs')
  const execPath = opts.execPath ?? process.execPath
  const binDir = resolveBinDir(env)
  const binPath = join(binDir, BIN_NAME)

  mkdirSync(binDir, { recursive: true, mode: 0o755 })

  // Build to a sibling tmp in the SAME dir (rename is atomic only within one FS), then
  // chmod +x and rename over the target. A reader of `telegram-runtime` never sees a
  // half-written file, and a legacy symlink at binPath is replaced atomically.
  const tmp = `${binPath}.tmp.${process.pid}.${Math.abs(hashStr(binPath + execPath))}`
  let binMode: SelfInstallBinMode

  if (isCompilableSource(sourceEntry) && isBunInterpreter(execPath)) {
    // PRIMARY path: running under bun from the package source (npx → bin → bun cli.ts).
    // Compile a self-contained snapshot (bundles grammy) so the installed bin does not
    // depend on the npm cache (GC'd) or the source tree.
    const r = spawnSync(execPath, ['build', '--compile', '--outfile', tmp, sourceEntry], {
      encoding: 'utf8',
      env: env as Record<string, string>,
    })
    if (r.error || (r.status ?? 1) !== 0) {
      cleanup(tmp)
      throw new Error(
        `self-install: bun build --compile failed: ${(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim()}`,
      )
    }
    binMode = 'compiled'
  } else {
    // FALLBACK: running from an already-compiled bin (no .ts source / execPath is not
    // bun). Re-assert the install by copying the running executable into binDir.
    copyFileSync(execPath, tmp)
    binMode = 'copied-self'
  }

  chmodSync(tmp, 0o755)
  renameSync(tmp, binPath)

  // Manifest pins the ABSOLUTE installed bin into the self-config descriptor.
  const manifest = buildManifest(binPath)
  const manifestPath = writeManifestAtomic(manifest, env)

  // FU6 on-host docs — stage this version's public docs to <root>/docs/telegram-runtime/.
  // Best-effort: scaffoldHostDocs already soft-skips missing source / copy errors; the
  // try/catch additionally swallows the fail-closed sandbox guard so a docs problem can
  // NEVER fail the install (bin + manifest are the install contract, docs are a bonus).
  let docs: HostDocsResult
  try {
    docs = scaffoldHostDocs(PACKAGE_NAME, docsSource, env)
  } catch (e) {
    docs = {
      copied: false,
      dest: join(resolveIapeerRoot(env), 'docs', PACKAGE_NAME),
      reason: e instanceof Error ? e.message : String(e),
    }
  }

  return { binPath, manifestPath, binMode, root: resolveIapeerRoot(env), binDir, docs }
}
