// Local equivalent of iapeer's install-signature contract. No foundation dependency:
// verify the staged executable before publishing it; repair only invalid signatures.
import { spawnSync } from 'child_process'

export interface InstallCommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
  signal?: NodeJS.Signals | null
}

/** Injectable compile/codesign runner; tests never invoke host-global signing tools. */
export type InstallCommandRunner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => InstallCommandResult

export const runInstallCommand: InstallCommandRunner = (command, args, env) =>
  spawnSync(command, args, { encoding: 'utf8', env })

export interface ExecutableSignatureOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  run?: InstallCommandRunner
}

function succeeded(result: InstallCommandResult): boolean {
  return result.status === 0 && !result.error && !result.signal
}

function failure(step: string, path: string, result: InstallCommandResult): Error {
  const detail = (result.error?.message || result.stderr || result.stdout ||
    (result.signal ? `signal ${result.signal}` : `exit ${result.status}`)).trim()
  return new Error(`self-install: codesign ${step} failed for ${path}: ${detail}`)
}

/** macOS only: strict verify → if invalid, ad-hoc sign → strict verify again.
 * A valid signature is NEVER replaced (preserves its identity/TCC continuity).
 * Throws on any unrecoverable failure; callers must not rename/publish the staged
 * file or manifest until this returns. Non-macOS installs invoke no signing tools. */
export function ensureExecutableSignature(path: string, opts: ExecutableSignatureOptions = {}): void {
  if ((opts.platform ?? process.platform) !== 'darwin') return
  const run = opts.run ?? runInstallCommand
  const env = opts.env ?? process.env
  const verifyArgs = ['--verify', '--deep', '--strict', path]
  const initial = run('/usr/bin/codesign', verifyArgs, env)
  if (succeeded(initial)) return
  // A missing/killed verifier is not evidence of an invalid signature. Fail closed
  // rather than re-signing a potentially valid executable on an infrastructure error.
  if (initial.error || initial.signal || initial.status === null) throw failure('verify', path, initial)

  const signed = run('/usr/bin/codesign', ['--force', '--sign', '-', path], env)
  if (!succeeded(signed)) throw failure('sign', path, signed)
  const verified = run('/usr/bin/codesign', verifyArgs, env)
  if (!succeeded(verified)) throw failure('verify after repair', path, verified)
}
