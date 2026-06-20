// Atomic JSON write shared across the package (cli.ts + selfConfig.ts). Write to a
// unique sibling tmp in the same directory, then rename over the target — rename is
// atomic WITHIN one filesystem, so a concurrent reader never observes a half-written
// file and a repeat write overwrites in place (idempotent). Default mode 0o600: the
// files this writes (peer profiles, operator state) are private. mkdir -p the parent
// (0o700) first so a first write into a fresh tree succeeds.

import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname } from 'path'

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  renameSync(tmp, path)
}
