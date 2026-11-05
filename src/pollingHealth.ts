import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

const PREFIX = 'telegram-runtime polling '
const MAX_TAIL_BYTES = 8 * 1024 * 1024
export const DEFAULT_POLL_MAX_AGE_MS = 360_000

/** Read only complete lines from a bounded snapshot; never load an unbounded log. */
export function readPollingLogTail(path: string, maxBytes = MAX_TAIL_BYTES): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read)
      if (n === 0) break
      read += n
    }
    const text = buffer.subarray(0, read).toString('utf8')
    // The first line may have been cut mid-UTF8/JSON; the last may still be in flight.
    const first = start > 0 ? text.indexOf('\n') + 1 : 0
    const last = text.lastIndexOf('\n')
    return last >= first ? text.slice(first, last + 1) : ''
  } finally {
    closeSync(fd)
  }
}

export type PollingHealth = {
  botKey: string
  status: 'unknown' | 'starting' | 'degraded' | 'stale' | 'healthy'
  generation: number | null
  lastEvent: string | null
  lastEventAt: string | null
  heartbeatAt: string | null
  heartbeatAgeMs: number | null
}

const EVENTS = new Set([
  'poll.boot', 'poll.start', 'poll.heartbeat', 'poll.error', 'poll.bootstrap.error',
  'poll.start.timeout', 'poll.stalled', 'poll.failed', 'poll.degraded', 'poll.fatal',
])

/** Health is evidence of completed polling, never of a live process or outbound. */
export function pollingHealth(
  text: string,
  expectedBots: readonly string[],
  now = Date.now(),
  maxAgeMs = DEFAULT_POLL_MAX_AGE_MS,
): PollingHealth[] {
  const states = new Map<string, PollingHealth>(expectedBots.map(botKey => [botKey, {
    botKey, status: 'unknown', generation: null, lastEvent: null, lastEventAt: null,
    heartbeatAt: null, heartbeatAgeMs: null,
  }]))
  for (const line of text.split('\n')) {
    if (!line.startsWith(PREFIX)) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line.slice(PREFIX.length)) } catch { continue }
    if (!e || typeof e !== 'object' || typeof e.botKey !== 'string' || typeof e.evt !== 'string') continue
    const state = states.get(e.botKey)
    if (!state || !EVENTS.has(e.evt) || typeof e.ts !== 'string' ||
        typeof e.generation !== 'number' || !Number.isSafeInteger(e.generation) || e.generation < 1) continue
    const at = Date.parse(e.ts)
    if (!Number.isFinite(at)) continue
    // Append order is authoritative, including a process restart at generation 1.
    if (state.generation !== e.generation || e.evt === 'poll.boot') {
      state.heartbeatAt = null
      state.status = 'starting'
    }
    state.generation = e.generation
    state.lastEvent = e.evt
    state.lastEventAt = e.ts
    if (e.evt === 'poll.heartbeat') {
      if (typeof e.cycles === 'number' && e.cycles > 0) {
        state.heartbeatAt = e.ts
        state.status = 'healthy'
      } else state.status = 'unknown'
    } else if (e.evt !== 'poll.start' && e.evt !== 'poll.boot') state.status = 'degraded'
  }
  return [...states.values()].map(state => {
    if (state.heartbeatAt !== null) state.heartbeatAgeMs = now - Date.parse(state.heartbeatAt)
    // Future evidence cannot establish liveness; do not silently clamp clock skew.
    if (state.lastEventAt !== null && Date.parse(state.lastEventAt) > now + 5000) state.status = 'unknown'
    else if (state.status === 'healthy' && state.heartbeatAgeMs! > maxAgeMs) state.status = 'stale'
    return state
  })
}
