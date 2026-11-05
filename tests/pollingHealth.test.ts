import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pollingHealth, readPollingLogTail } from '../src/pollingHealth.ts'

const now = Date.parse('2026-11-05T10:00:00Z')
const event = (evt: string, generation = 1, age = 0, fields = {}) =>
  'telegram-runtime polling ' + JSON.stringify({
    ts: new Date(now - age).toISOString(), evt, botKey: 'probe_bot', generation, cycles: 1, ...fields,
  }) + '\r\n'
const state = (text: string) => pollingHealth(text, ['probe_bot'], now)[0]!

describe('read-only polling health', () => {
  test('all expected bots are included even before boot/start (bootstrap blind spot)', () => {
    expect(pollingHealth('', ['probe_bot', 'other_bot'], now).map(s => s.status)).toEqual(['unknown', 'unknown'])
    expect(state(event('poll.boot')).status).toBe('starting')
    expect(state(event('poll.start')).status).toBe('starting')
  })
  test('only a fresh completed cycle establishes health; idle empty cycles count', () => {
    expect(state(event('poll.heartbeat')).status).toBe('healthy')
    expect(state(event('poll.heartbeat', 1, 360_001)).status).toBe('stale')
    expect(state(event('poll.heartbeat', 1, 360_000)).status).toBe('healthy')
    expect(state(event('poll.heartbeat', 1, 0, { cycles: 0 })).status).toBe('unknown')
  })
  test('new generation cannot borrow a previous heartbeat', () => {
    const s = state(event('poll.heartbeat', 4, 10) + event('poll.boot', 5))
    expect(s.status).toBe('starting')
    expect(s.heartbeatAt).toBeNull()
    expect(s.generation).toBe(5)
    expect(state(event('poll.heartbeat', 4, 10) + event('poll.start', 5)).status).toBe('starting')
  })
  test('process restart at generation 1 (including 1→1) invalidates old evidence', () => {
    for (const generation of [1, 7]) {
      expect(state(event('poll.heartbeat', generation, 10) + event('poll.boot', 1)).status).toBe('starting')
    }
  })
  test('error wins until a newer heartbeat, not merely a poll.start', () => {
    const log = event('poll.heartbeat', 1, 100) + event('poll.error', 1, 50)
    expect(state(log).status).toBe('degraded')
    expect(state(log + event('poll.start')).status).toBe('degraded')
    expect(state(log + event('poll.heartbeat')).status).toBe('healthy')
  })
  test('bootstrap failure, timeout and fatal are unhealthy without a poll.start', () => {
    for (const evt of ['poll.bootstrap.error', 'poll.start.timeout', 'poll.fatal', 'poll.degraded', 'poll.stalled']) {
      expect(state(event(evt)).status).toBe('degraded')
    }
  })
  test('unrelated/outbound/malformed/future events do not prove health', () => {
    expect(state('bad\nnull\n' + event('poll.heartbeat', 1, 0, { botKey: 'foreign_bot' })).status).toBe('unknown')
    expect(state(event('chunk.receipt')).status).toBe('unknown')
    expect(state(event('poll.heartbeat', 1, -6000)).status).toBe('unknown')
    expect(state(event('poll.heartbeat', 1, 0, { ts: 'nope' })).status).toBe('unknown')
    expect(state(event('poll.heartbeat', NaN)).status).toBe('unknown')
    expect(state(event('poll.heartbeat', 0)).status).toBe('unknown')
    expect(state('telegram-runtime polling null\n').status).toBe('unknown')
  })
})

describe('bounded polling log snapshot', () => {
  test('drops partial leading/trailing lines, retains complete CRLF + UTF8 records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-poll-health-'))
    try {
      const path = join(dir, 'runtime.log')
      const full = event('poll.heartbeat')
      writeFileSync(path, 'Ж'.repeat(100) + '\n' + full + 'unfinished')
      expect(readPollingLogTail(path, Buffer.byteLength(full) + 15)).toBe(full)
      writeFileSync(path, full)
      expect(readPollingLogTail(path)).toBe(full)
      writeFileSync(path, 'unfinished')
      expect(readPollingLogTail(path)).toBe('')
      writeFileSync(path, '')
      expect(readPollingLogTail(path)).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
