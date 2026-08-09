import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { basename, dirname } from 'path'

export type ReleaseLock = () => void

type ProcessIdentity = {
  started: string
  executable: string
  command: string
}

type LockOwnerV1 = {
  version: 1
  pid: number
  processStarted: string
  executable: string
  command: string
  instance: string
}

type ParsedOwner =
  | { format: 'v1'; owner: LockOwnerV1 }
  | { format: 'legacy'; pid: number }
  | { format: 'malformed' }

type LockSnapshot = {
  raw: string
  dev: number
  ino: number
}

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errorCode(err) === 'EPERM'
  }
}

function readPsField(pid: number, field: 'lstart' | 'comm' | 'command'): string | null {
  const result = spawnSync('/bin/ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  })
  if (result.error || result.status !== 0) return null
  const value = result.stdout.trim()
  return value || null
}

/**
 * `kill(pid, 0)` proves only that the numeric PID exists. A PID can be reused
 * after the lock owner dies, so the lock also records stable process-instance
 * attributes from `ps`: birth time and executable/argv identity.
 *
 * The start field is read twice around the other fields. If the PID is reused
 * during inspection, the two reads differ and the observation is discarded.
 */
function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (!processIsAlive(pid)) return null
  const startedBefore = readPsField(pid, 'lstart')
  const executable = readPsField(pid, 'comm')
  const command = readPsField(pid, 'command')
  const startedAfter = readPsField(pid, 'lstart')
  if (
    !startedBefore ||
    !executable ||
    !command ||
    !startedAfter ||
    startedBefore !== startedAfter
  ) {
    return null
  }
  return { started: startedBefore, executable, command }
}

function parseOwner(raw: string): ParsedOwner {
  const text = raw.trim()
  if (/^[1-9][0-9]*$/.test(text)) {
    const pid = Number(text)
    return Number.isSafeInteger(pid) ? { format: 'legacy', pid } : { format: 'malformed' }
  }
  try {
    const value = JSON.parse(text) as Partial<LockOwnerV1> | null
    if (
      value &&
      value.version === 1 &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.processStarted === 'string' &&
      value.processStarted.length > 0 &&
      typeof value.executable === 'string' &&
      value.executable.length > 0 &&
      typeof value.command === 'string' &&
      value.command.length > 0 &&
      typeof value.instance === 'string' &&
      value.instance.length > 0
    ) {
      return { format: 'v1', owner: value as LockOwnerV1 }
    }
  } catch {
    // A malformed/partially-written legacy lock has no provable live owner.
  }
  return { format: 'malformed' }
}

function looksLikeTelegramRuntime(identity: ProcessIdentity): boolean {
  const executable = basename(identity.executable)
  if (executable === 'telegram-runtime') {
    return /(?:^|\s)run(?:\s|$)/.test(identity.command)
  }
  if (executable === 'bun') {
    return /(?:^|\s)\S*src\/cli\.ts\s+run(?:\s|$)/.test(identity.command)
  }
  return false
}

function activePid(owner: ParsedOwner): number | null {
  if (owner.format === 'malformed') return null
  const pid = owner.format === 'legacy' ? owner.pid : owner.owner.pid
  const actual = readProcessIdentity(pid)

  // If a live PID cannot be inspected, fail closed: a transient `ps` problem
  // must not let a second poller steal a genuinely live bot token.
  if (!actual) return processIsAlive(pid) ? pid : null

  if (owner.format === 'legacy') {
    // Migration from the old PID-only file: a live telegram-runtime still
    // blocks, but a reused PID now belonging to corespeechd/sleep/etc. is stale.
    return looksLikeTelegramRuntime(actual) ? pid : null
  }

  const recorded = owner.owner
  return recorded.processStarted === actual.started &&
    recorded.executable === actual.executable &&
    recorded.command === actual.command
    ? pid
    : null
}

function readSnapshot(path: string): LockSnapshot | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const stat = fstatSync(fd)
    const raw = readFileSync(fd, 'utf8')
    return { raw, dev: stat.dev, ino: stat.ino }
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null
    throw err
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function removeSnapshot(path: string, snapshot: LockSnapshot): boolean {
  try {
    const current = lstatSync(path)
    if (current.dev !== snapshot.dev || current.ino !== snapshot.ino) return false
    unlinkSync(path)
    return true
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false
    throw err
  }
}

function publishOwner(path: string, owner: LockOwnerV1): LockSnapshot | null {
  const temp = `${path}.${process.pid}.${owner.instance}.tmp`
  const raw = `${JSON.stringify(owner)}\n`
  let tempExists = false
  try {
    let fd: number | undefined
    try {
      fd = openSync(temp, 'wx', 0o600)
      tempExists = true
      writeFileSync(fd, raw)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    const stat = statSync(temp)
    try {
      // Atomic dot-lock publication: unlike open('wx') + write, contenders
      // can never observe an empty/partially-written owner file.
      linkSync(temp, path)
      return {
        raw,
        dev: stat.dev,
        ino: stat.ino,
      }
    } catch (err) {
      if (errorCode(err) === 'EEXIST') return null
      throw err
    }
  } finally {
    if (tempExists) {
      try {
        unlinkSync(temp)
      } catch {
        // Best effort: the published hard link (if any) remains authoritative.
      }
    }
  }
}

/** Acquire an identity-aware, process-lifetime lock at `path`. */
export function acquireProcessLock(path: string, ownerLabel: string): ReleaseLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const identity = readProcessIdentity(process.pid)
  if (!identity) {
    throw new Error(`${ownerLabel} cannot identify current process ${process.pid}`)
  }
  const owner: LockOwnerV1 = {
    version: 1,
    pid: process.pid,
    processStarted: identity.started,
    executable: identity.executable,
    command: identity.command,
    instance: randomUUID(),
  }

  let owned: LockSnapshot | null = null
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      owned = publishOwner(path, owner)
    } catch (err) {
      throw new Error(`${ownerLabel} lock cannot be created at ${path}: ${formatError(err)}`)
    }
    if (owned) break

    let snapshot: LockSnapshot | null
    try {
      snapshot = readSnapshot(path)
    } catch (err) {
      throw new Error(`${ownerLabel} lock cannot be read at ${path}: ${formatError(err)}`)
    }
    if (!snapshot) continue
    const previousPid = activePid(parseOwner(snapshot.raw))
    if (previousPid !== null) {
      throw new Error(`${ownerLabel} is already owned by pid ${previousPid}`)
    }
    try {
      removeSnapshot(path, snapshot)
    } catch (err) {
      throw new Error(`${ownerLabel} stale lock cannot be removed at ${path}: ${formatError(err)}`)
    }
  }
  if (!owned) throw new Error(`${ownerLabel} lock kept changing while acquiring ${path}`)

  let released = false
  return () => {
    if (released) return
    released = true
    try {
      const snapshot = readSnapshot(path)
      if (!snapshot || snapshot.dev !== owned!.dev || snapshot.ino !== owned!.ino) return
      const current = parseOwner(snapshot.raw)
      if (current.format !== 'v1' || current.owner.instance !== owner.instance) return
      removeSnapshot(path, snapshot)
    } catch {
      // Best-effort cleanup only; identity-aware stale detection runs next time.
    }
  }
}
