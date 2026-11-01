// Isolated socket-level acceptance. Never contacts Telegram or reads credentials.
import { Bot } from 'grammy'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { appendFileSync, writeFileSync } from 'node:fs'

const { values } = parseArgs({ options: { supervisor: { type: 'string' }, output: { type: 'string' } } })
if (!values.output) throw new Error('--output required (new evidence file)')
const output = values.output
writeFileSync(output, '', { flag: 'wx' })
const implementation = values.supervisor
  ? pathToFileURL(values.supervisor).href
  : new URL('../src/pollingSupervisor.ts', import.meta.url).href
const { createGuardedPollingFetch, guardPollingBootstrap, supervisePolling } = await import(implementation)
const startedAt = Date.now()
const controller = new AbortController()
const log = (evt: string, fields = {}) => appendFileSync(output, JSON.stringify({ ts: new Date().toISOString(), elapsedMs: Date.now() - startedAt, evt, ...fields }) + '\n')
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const method = new URL(request.url).pathname.split('/').pop()
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: 'Probe', username: 'probe_bot' } })
    if (method === 'deleteWebhook') return Response.json({ ok: true, result: true })
    if (method === 'getUpdates') {
      const payload = await request.json() as { limit?: number }
      if (payload.limit === 1) return Response.json({ ok: true, result: [] })
      // Server receives the request but never returns its response.
      return new Promise<Response>(() => {})
    }
    return Response.json({ ok: false }, { status: 404 })
  },
})
try {
  await supervisePolling({
    botKey: 'probe_bot', pollTimeoutSeconds: 30, signal: controller.signal,
    makeGeneration(generation: number) {
      const guarded = createGuardedPollingFetch({ botKey: 'probe_bot', generation,
        fetch: (url: string, init: RequestInit) => fetch(url, init), log,
        stallMs: 100, stopStallMs: 100, heartbeatMs: 1000 })
      const bot = new Bot('1:probe', { client: { apiRoot: server.url.origin, fetch: guarded.fetch } })
      guardPollingBootstrap(bot, { botKey: 'probe_bot', generation, timeoutMs: 1000, log })
      return { bot, stalled: guarded.stalled, healthy: guarded.healthy }
    },
    publish() {},
    onStart(_info: unknown, generation: number) { if (generation === 4) controller.abort() },
    log, stopWaitMs: 1000,
  })
  log('probe.done')
} finally {
  server.stop(true)
}
