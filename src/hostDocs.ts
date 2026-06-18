// FU6 — on-host docs per-package convention (`<IAPEER_ROOT>/docs/<package>/`).
//
// A faithful mirror of the foundation's scaffoldHostDocs (iapeer src/install/index.ts,
// commit b047ee8): on EVERY install + update, copy this package's PUBLIC docs to a
// stable on-host path so an agent (or a human) reads the docs that ship WITH the
// installed version, without needing the source tree. Versioned-as-artifact: each
// install/update refreshes the copy (the atomic temp-swap prunes docs removed in a
// newer version). We own ONLY our own `<root>/docs/telegram-runtime/` subdir; the
// foundation owns the `<root>/docs/` parent and the system-prompt pointer to it.
//
// EXCLUDES the `internals/` subtree (internals are local-only, never published). The
// npm `files` allowlist already keeps internals out of the tarball (docs/*.md +
// docs/ru/, not docs/) — the filter here is defense-in-depth for a dev source tree that
// still carries docs/internals/.
//
// BEST-EFFORT: a missing docs source or any copy error returns a soft verdict and never
// throws — the install MUST NOT fail because docs could not be staged (the caller in
// selfInstall additionally wraps the call). The ONE hard failure is the fail-closed
// sandbox guard: a misconfigured test that would otherwise write the REAL ~/.iapeer.

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { homedir } from 'os'
import { basename, join, relative, sep } from 'path'
import { resolveIapeerRoot } from './manifest.ts'

export interface HostDocsResult {
  copied: boolean
  /** The per-package destination — `<root>/docs/<pkg>/`. Always set (even on skip). */
  dest: string
  /** Why nothing was copied (missing source / copy error). Absent on success. */
  reason?: string
}

/**
 * Copy `docsSource` to `<IAPEER_ROOT or ~/.iapeer>/docs/<pkg>/`, atomically and
 * excluding the `internals/` subtree. Idempotent: re-running replaces the package's
 * docs cleanly (the atomic copy→tmp→rm-dest→rename drops the previous tree, so a doc
 * removed in a newer version is pruned, and a reader never sees a half-written tree).
 *
 * Returns what it did. Throws ONLY on the fail-closed sandbox guard; for a missing
 * source or any copy error it returns `{ copied: false, reason }`.
 */
export function scaffoldHostDocs(
  pkg: string,
  docsSource: string,
  env: NodeJS.ProcessEnv = process.env,
): HostDocsResult {
  const root = resolveIapeerRoot(env)
  const dest = join(root, 'docs', pkg)
  // Fail-closed sandbox guard (mirrors the foundation): never write the REAL
  // ~/.iapeer/docs under a sandboxed test that forgot to set IAPEER_ROOT. Compared
  // against the ACTUAL OS home (homedir()), not env.HOME — the root IS the isolation,
  // so an env.HOME-based check would false-trip when a test legitimately points
  // IAPEER_ROOT at <tmp>/.iapeer (with env.HOME also <tmp>).
  if (env.IAPEER_TEST_SANDBOX === '1' && root === join(homedir(), '.iapeer')) {
    throw new Error(
      `refusing to scaffold docs into the REAL ${join(root, 'docs')} under IAPEER_TEST_SANDBOX=1 — set IAPEER_ROOT`,
    )
  }
  if (!existsSync(docsSource)) return { copied: false, dest, reason: `docs source not found: ${docsSource}` }
  const tmp = `${dest}.tmp-${process.pid}`
  try {
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(join(dest, '..'), { recursive: true })
    cpSync(docsSource, tmp, {
      recursive: true,
      // Returning false for a directory skips its whole subtree.
      filter: src => {
        // macOS clutter: a dev/host docs tree carries .DS_Store; skip it everywhere so
        // it never leaks into <root>/docs/<pkg>/ (matches the foundation's filter).
        if (basename(src) === '.DS_Store') return false
        const rel = relative(docsSource, src)
        return rel !== 'internals' && !rel.startsWith(`internals${sep}`)
      },
    })
    rmSync(dest, { recursive: true, force: true })
    renameSync(tmp, dest)
    return { copied: true, dest }
  } catch (e) {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
    return { copied: false, dest, reason: e instanceof Error ? e.message : String(e) }
  }
}
