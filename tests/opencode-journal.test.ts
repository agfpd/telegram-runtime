import { describe, expect, test } from 'bun:test'
import { createOpencodeJournalParser, opencodeDir, opencodeStateBusy, opencodeToolName } from '../src/cli'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Consumer of the core-produced OpenCode journal (iapeer docs/20 «Observability
// ABI»). Fixtures follow the native OpenCode 1.19.3 ToolPart / AssistantMessage
// schema (packages/sdk/js/src/gen/types.gen.ts). Unit proof only — not a proof of
// the core producer.
const line = (seq: number, type: string, properties: unknown) => ({
  schema: 1, seq, time: 1, identity: 'opencode-p', launchID: 'l1', sessionID: 'ses_1', type, properties, nativeID: null,
})
const tool = (id: string, name: string, status: string, input: Record<string, unknown> = {}) =>
  ({ part: { id, sessionID: 'ses_1', messageID: 'm1', type: 'tool', callID: 'c' + id, tool: name, state: { status, input } } })

describe('createOpencodeJournalParser', () => {
  test('one gesture per part id across pending→running→completed and repeated snapshots', () => {
    const p = createOpencodeJournalParser()
    expect(p.events(line(1, 'message.part.updated', tool('prt_1', 'read', 'pending')))).toEqual([])
    expect(p.events(line(2, 'message.part.updated', tool('prt_1', 'read', 'running', { filePath: '/a/b/notes.md' })))).toEqual([
      { tool: 'read', label: 'notes.md' },
    ])
    expect(p.events(line(3, 'message.part.updated', tool('prt_1', 'read', 'completed', { filePath: '/a/b/notes.md' })))).toEqual([])
    expect(p.events(line(4, 'message.part.updated', tool('prt_1', 'read', 'completed', { filePath: '/a/b/notes.md' })))).toEqual([])
  })

  test('dedups by seq (replayed lines are ignored)', () => {
    const p = createOpencodeJournalParser()
    expect(p.events(line(5, 'message.part.updated', tool('prt_a', 'bash', 'running', { command: 'ls -la', description: 'List files' })))).toEqual([
      { tool: 'bash', label: 'List files' },
    ])
    expect(p.events(line(5, 'message.part.updated', tool('prt_b', 'bash', 'running', { command: 'pwd' })))).toEqual([])
    expect(p.events(line(4, 'message.part.updated', tool('prt_c', 'bash', 'running', { command: 'pwd' })))).toEqual([])
  })

  test('MCP send_to_peer: operator-bound hidden, agent→agent kept', () => {
    const isOp = (x: string) => x === 'arthur'
    const p = createOpencodeJournalParser(isOp)
    expect(p.events(line(1, 'message.part.updated', tool('s1', 'iapeer_send_to_peer', 'running', { personality: 'arthur' })))).toEqual([])
    expect(p.events(line(2, 'message.part.updated', tool('s2', 'iapeer_send_to_peer', 'running', { personality: 'boris' })))).toEqual([
      { tool: 'send_to_peer', label: 'boris' },
    ])
  })

  test('task/skill labels never leak the prompt', () => {
    const p = createOpencodeJournalParser()
    expect(p.events(line(1, 'message.part.updated', tool('t1', 'task', 'running', { prompt: 'SECRET', subagent_type: 'general' })))).toEqual([
      { tool: 'task', label: 'general' },
    ])
  })

  test('non-tool parts and foreign lines yield nothing', () => {
    const p = createOpencodeJournalParser()
    expect(p.events(line(1, 'message.part.updated', { part: { id: 'x', type: 'text', text: 'hi' } }))).toEqual([])
    expect(p.events(line(2, 'session.status', { sessionID: 'ses_1', status: { type: 'busy' } }))).toEqual([])
    expect(p.events({ type: 'message.part.updated' })).toEqual([])
  })

  test('context tokens from the latest assistant message.updated', () => {
    const p = createOpencodeJournalParser()
    const upd = line(7, 'message.updated', {
      info: { id: 'm1', role: 'assistant', tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 9000, write: 200 } } },
    })
    p.events(upd)
    expect(p.tokens(upd)).toBe(10200)
    const user = line(8, 'message.updated', { info: { id: 'm2', role: 'user' } })
    p.events(user)
    expect(p.tokens(user)).toBeNull()
    p.events(upd) // replayed seq 7
    expect(p.tokens(upd)).toBeNull()
  })
})

describe('opencodeStateBusy', () => {
  test('busy-gate from state.json status', () => {
    for (const s of ['starting', 'busy', 'approval']) expect(opencodeStateBusy({ status: s })).toBe(true)
    for (const s of ['idle', 'stopped', 'error']) expect(opencodeStateBusy({ status: s })).toBe(false)
    expect(opencodeStateBusy(null)).toBeNull()
    expect(opencodeStateBusy({})).toBeNull()
  })
})

test('opencodeToolName', () => {
  expect(opencodeToolName('iapeer_send_to_peer')).toBe('send_to_peer')
  expect(opencodeToolName('bash')).toBe('bash')
})

// Real producer output: iapeer c11d6e4 `scripts/opencode-native-harness.ts --keep`
// (OpenCode 1.19.3 serve, synthetic provider, fresh → 2 deliveries → interrupt →
// resume). The synthetic provider makes NO tool calls, so this proves the ABI
// envelope, seq handling and token extraction against the live producer — tool
// gestures stay unit-only until a tool-calling harness run exists.
describe('replay of the real core-produced journal (iapeer c11d6e4 harness)', () => {
  const lines = readFileSync(join(import.meta.dir, 'fixtures/opencode-harness-c11d6e4.events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l))

  test('every line is accepted by the ABI envelope gate, seq contiguous across resume', () => {
    expect(lines.length).toBe(80)
    lines.forEach((o, i) => expect(o.seq).toBe(i + 1))
    const p = createOpencodeJournalParser()
    let accepted = 0
    let lastTokens: number | null = null
    for (const o of lines) {
      expect(p.events(o)).toEqual([]) // no tool parts in this run
      const t = p.tokens(o)
      if (t !== null) { accepted++; lastTokens = t }
    }
    expect(accepted).toBeGreaterThan(0)
    expect(lastTokens).toBe(10) // synthetic provider: prompt_tokens 10
  })

  test('a full second pass (reader re-tail from byte 0) is fully deduped by seq', () => {
    const p = createOpencodeJournalParser()
    for (const o of lines) { p.events(o); p.tokens(o) }
    for (const o of lines) {
      expect(p.events(o)).toEqual([])
      expect(p.tokens(o)).toBeNull()
    }
  })

  test('state.json shape is read by the busy gate', () => {
    const st = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/opencode-harness-c11d6e4.state.json'), 'utf8'))
    expect(st.schema).toBe(1)
    // The harness SIGTERMs mid-turn: dispose does not run on a signal (docs/20), so the
    // file is left `busy`. The state file alone cannot end that turn — see liveness.
    expect(opencodeStateBusy(st)).toBe(true)
  })
})

test('opencodeDir follows the docs/20 path <IAPEER_ROOT>/state/opencode/<p>', () => {
  const prev = process.env.IAPEER_ROOT
  process.env.IAPEER_ROOT = '/tmp/iap-root'
  try {
    expect(opencodeDir({ personality: 'probe' } as any)).toBe('/tmp/iap-root/state/opencode/probe')
  } finally {
    if (prev === undefined) delete process.env.IAPEER_ROOT
    else process.env.IAPEER_ROOT = prev
  }
})

// Real producer output WITH tool calls: iapeer 30e6b13 `scripts/opencode-mcp-harness.ts
// --keep`, sender `ocsend` (native bash, then iapeer_send_to_peer → ocrecv). Proves the
// gesture path against the live producer: pending→running→completed upserted to ONE
// gesture per part id, MCP name normalised, operator-bound sends hidden.
describe('replay of the real core-produced journal with tool calls (iapeer 30e6b13)', () => {
  const lines = readFileSync(join(import.meta.dir, 'fixtures/opencode-mcp-30e6b13.events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l))
  const run = (isOp?: (p: string) => boolean) => {
    const p = createOpencodeJournalParser(isOp)
    return lines.flatMap(o => p.events(o))
  }
  test('one gesture per tool part, agent→agent send kept', () => {
    expect(run(x => x === 'arthur')).toEqual([
      { tool: 'bash', label: 'write marker' },
      { tool: 'send_to_peer', label: 'ocrecv' },
    ])
  })
  test('operator-bound send is hidden; no classifier → hidden (fail-safe)', () => {
    expect(run(x => x === 'ocrecv')).toEqual([{ tool: 'bash', label: 'write marker' }])
    expect(run()).toEqual([{ tool: 'bash', label: 'write marker' }])
  })
})
