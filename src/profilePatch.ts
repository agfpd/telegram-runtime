import { patchPeerProfile } from '../vendor/peer-profile.js'
import { basename } from 'node:path'
import { NAME_RE } from './constants.ts'

/** Only Telegram-owned leaves are patched; all reads happen under the core lock. */
export function patchTelegramInterface(
  cwd: string,
  patch: { user_id?: string; bot_username?: string; activity?: boolean },
  requireExisting = false,
): void {
  patchPeerProfile(cwd, raw => {
    if (requireExisting && typeof raw.personality !== 'string') {
      throw new Error(`profile missing personality at ${cwd}`)
    }
    const interfaces = object(raw.interfaces)
    const telegram = object(interfaces.telegram)
    Object.assign(telegram, patch)
    interfaces.telegram = telegram
    raw.interfaces = interfaces
  })
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** prepare may scaffold identity, but must never re-persist a pre-lock snapshot. */
export function ensureTelegramProfile(cwd: string): void {
  patchPeerProfile(cwd, raw => {
    if (Object.keys(raw).length === 0) {
      const personality = basename(cwd).trim().toLowerCase()
      if (!NAME_RE.test(personality)) throw new Error(`invalid cwd basename: ${personality}`)
      Object.assign(raw, {
        personality, default_runtime: 'telegram', runtimes: ['telegram'],
        description: '', intelligence: 'natural',
      })
      return
    }
    if (typeof raw.personality !== 'string' || !raw.personality) {
      throw new Error(`profile missing personality at ${cwd}`)
    }
    const runtime = typeof raw.default_runtime === 'string' && raw.default_runtime
      ? raw.default_runtime : raw.runtime
    if (typeof runtime !== 'string' || !runtime) {
      throw new Error(`profile missing default_runtime (or legacy runtime) at ${cwd}`)
    }
    const runtimes = Array.isArray(raw.runtimes) ? raw.runtimes : [runtime]
    if (!runtimes.includes('telegram')) raw.runtimes = [...runtimes, 'telegram']
  })
}
