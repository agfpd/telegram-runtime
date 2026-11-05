import { describe, expect, test } from 'bun:test'
import { provePollingCursor } from '../scripts/verify-polling-cursor.ts'
import { createPollingCursor } from '../src/pollingSupervisor.ts'

describe('polling cursor across generations', () => {
  test('without the cursor a lost offset ack re-delivers the update (bug fixture)', async () => {
    const r = await provePollingCursor(false, () => {})
    expect(r.received).toEqual([41, 41, 42])
  }, 20_000)

  test('with the cursor the next generation resumes past the handled update', async () => {
    const r = await provePollingCursor(true, () => {})
    expect(r.received).toEqual([41, 42])
    const gen2 = r.requests.filter(x => x.generation === 2 && !x.stop)
    expect(gen2[0]?.offset).toBe(42)
  }, 20_000)

  test('transformer never lowers an offset and ignores other methods', async () => {
    const cursor = createPollingCursor()
    let transformer: any, middleware: any
    cursor.install({ api: { config: { use: t => { transformer = t } } }, use: m => { middleware = m } })
    const seen: any[] = []
    const prev = (method: string, payload: any) => { seen.push([method, payload]); return Promise.resolve() }
    await transformer(prev, 'getUpdates', { offset: 1 })
    await middleware({ update: { update_id: 7 } }, async () => {})
    await transformer(prev, 'getUpdates', { offset: 1, limit: 1 })
    await transformer(prev, 'getUpdates', { offset: 20 })
    await transformer(prev, 'sendMessage', { chat_id: 1 })
    expect(seen).toEqual([
      ['getUpdates', { offset: 1 }],
      ['getUpdates', { offset: 8, limit: 1 }],
      ['getUpdates', { offset: 20 }],
      ['sendMessage', { chat_id: 1 }],
    ])
    expect(cursor.lastTried).toBe(7)
  })
})
