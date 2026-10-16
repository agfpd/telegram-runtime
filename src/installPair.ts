import { randomUUID } from 'crypto'
import { linkSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { runtimeManifestPath, type RuntimeManifest } from './manifest.ts'

/** Publish an already signature-verified staged executable and its manifest.
 * Stage all writes first. If the second rename fails, restore the previous binary
 * using its retained inode/signature (or legacy symlink), or remove a first install.
 * This handles synchronous I/O errors, not power loss / SIGKILL between renames.
 * No lifecycle operations belong here; running processes keep their old inode. */
export function publishInstallPair(
  stagedBin: string,
  binPath: string,
  manifest: RuntimeManifest,
  env: NodeJS.ProcessEnv,
  // Narrow filesystem fault-injection seam; production always uses renameSync.
  rename: typeof renameSync = renameSync,
): string {
  const manifestPath = runtimeManifestPath(env)
  const suffix = `${process.pid}.${randomUUID()}`
  const stagedManifest = `${manifestPath}.${suffix}.tmp`
  const backupBin = `${binPath}.${suffix}.rollback`
  let hadBin = false
  let publishedBin = false
  let retainBackup = false
  const cleanup = (path: string) => { try { rmSync(path, { force: true }) } catch {} }
  try {
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o755 })
    writeFileSync(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
    let isSymlink = false
    try {
      isSymlink = lstatSync(binPath).isSymbolicLink()
      hadBin = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (hadBin) {
      // macOS link(2) follows symlinks: retain their link text explicitly instead.
      if (isSymlink) symlinkSync(readlinkSync(binPath), backupBin)
      else linkSync(binPath, backupBin)
    }
    rename(stagedBin, binPath)
    publishedBin = true
    rename(stagedManifest, manifestPath)
    return manifestPath
  } catch (error) {
    if (publishedBin) {
      try {
        if (hadBin) rename(backupBin, binPath)
        else rmSync(binPath)
      } catch (rollbackError) {
        retainBackup = true
        throw new AggregateError([error, rollbackError],
          `self-install: pair publication and rollback failed; ${hadBin ? `previous binary retained at ${backupBin}` : `could not remove first-install binary ${binPath}`}`)
      }
    }
    throw error
  } finally {
    cleanup(stagedManifest)
    if (!retainBackup) cleanup(backupBin)
  }
}
