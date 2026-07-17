import { describe, expect, test } from 'bun:test'
import {
  shortToolName,
  toolLabel,
  claudeLineEvents,
  codexLineEvents,
  claudeContextTokens,
  codexContextTokens,
  renderActivity,
  skipStatusFlush,
  pastTenseVerb,
  formatTurnDuration,
  pickSplash,
  claudeProjectDirName,
  parseActivityCommand,
  freshestRuntime,
  pickVerifiedRuntime,
  shouldRebindTranscript,
} from '../src/cli.ts'

describe('shortToolName — MCP prefix stripped to the bare gesture', () => {
  test('mcp__<server>__<tool> → <tool>', () => {
    expect(shortToolName('mcp__plugin_Inter-Agent-Protocol_iap__send_to_peer')).toBe('send_to_peer')
    expect(shortToolName('mcp__plugin_spawned-peer_spawned-peer__spawn')).toBe('spawn')
  })
  test('non-MCP names pass through unchanged', () => {
    expect(shortToolName('Bash')).toBe('Bash')
    expect(shortToolName('Read')).toBe('Read')
  })
})

describe('toolLabel — a gesture, not content', () => {
  test('Bash uses the agent description, not the command body', () => {
    expect(toolLabel('Bash', { command: 'rm -rf /tmp/x', description: 'чистка логов' })).toBe(
      'чистка логов',
    )
  })
  test('Bash without description falls back to the command verb only', () => {
    expect(toolLabel('Bash', { command: 'git status --porcelain' })).toBe('git')
  })
  test('Read/Edit/Write reduce to the file basename (no full path leak)', () => {
    expect(toolLabel('Read', { file_path: '/Users/macmini/Peers/boris/CLAUDE.md' })).toBe(
      'CLAUDE.md',
    )
    expect(toolLabel('Write', { file_path: '/a/b/c.ts' })).toBe('c.ts')
  })
  test('send_to_peer labels with the target personality', () => {
    expect(toolLabel('mcp__x__send_to_peer', { personality: 'natalya', message: 'secret' })).toBe(
      'natalya',
    )
  })
  test('Skill labels with the skill name, not its (private) args (v0.7)', () => {
    expect(toolLabel('Skill', { skill: 'skill-creator', args: 'big private task text' })).toBe(
      'skill-creator',
    )
    expect(toolLabel('Skill', { skill: 'plugin-dev:hook-development' })).toBe(
      'plugin-dev:hook-development',
    )
    expect(toolLabel('Skill', { name: 'image-gen' })).toBe('image-gen') // name fallback
  })
  test('Agent (subagent spawn) labels with the subagent type, not the prompt (v0.7)', () => {
    expect(
      toolLabel('Agent', {
        subagent_type: 'claude-code-guide',
        description: 'SessionStart hook limits',
        prompt: 'long private prompt…',
      }),
    ).toBe('claude-code-guide')
  })
  test('Agent without a subagent_type falls back to its short description (v0.7)', () => {
    expect(toolLabel('Agent', { description: 'Find MergeMind hook scripts' })).toBe(
      'Find MergeMind hook scripts',
    )
  })
  test('Task (legacy harness name for the subagent spawn) is still handled', () => {
    expect(toolLabel('Task', { subagent_type: 'Explore', description: 'recon' })).toBe('Explore')
  })
  test('labels are NOT truncated — full text, only normalized to one line (v0.6)', () => {
    const long = 'a'.repeat(100)
    expect(toolLabel('Grep', { pattern: long })).toBe(long) // no clip, no "…"
    expect(toolLabel('Bash', { description: 'строка с\nпереносом   и   пробелами' })).toBe(
      'строка с переносом и пробелами',
    )
  })
  test('unknown tool with no useful field → no label', () => {
    expect(toolLabel('SomeTool', { foo: 'bar' })).toBeUndefined()
  })
})

describe('claudeLineEvents — tool_use extraction from a JSONL line', () => {
  test('extracts tool_use blocks from an assistant message', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/x/CLAUDE.md' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'list' } },
        ],
      },
    }
    expect(claudeLineEvents(line)).toEqual([
      { tool: 'Read', label: 'CLAUDE.md' },
      { tool: 'Bash', label: 'list' },
    ])
  })
  const sendLine = (target: string) => ({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/x/a.ts' } },
        { type: 'tool_use', name: 'mcp__plugin_iap__send_to_peer', input: { personality: target } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'list' } },
      ],
    },
  })
  test('no operator predicate → ALL send_to_peer hidden (conservative v0.8.1 default)', () => {
    expect(claudeLineEvents(sendLine('arthur'))).toEqual([
      { tool: 'Read', label: 'a.ts' },
      { tool: 'Bash', label: 'list' },
    ])
  })
  test('target-aware (v0.8.2): operator-bound send hidden, agent→agent send shown', () => {
    const isOperator = (p: string) => p === 'arthur'
    // → operator (arthur): send hidden, only Read+Bash
    expect(claudeLineEvents(sendLine('arthur'), isOperator)).toEqual([
      { tool: 'Read', label: 'a.ts' },
      { tool: 'Bash', label: 'list' },
    ])
    // → agent (linus): send KEPT as a gesture, labelled with the target
    expect(claudeLineEvents(sendLine('linus'), isOperator)).toEqual([
      { tool: 'Read', label: 'a.ts' },
      { tool: 'send_to_peer', label: 'linus' },
      { tool: 'Bash', label: 'list' },
    ])
  })
  test('skips sidechain (subagent) lines', () => {
    const line = {
      type: 'assistant',
      isSidechain: true,
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] },
    }
    expect(claudeLineEvents(line)).toEqual([])
  })
  test('ignores non-assistant lines and malformed input', () => {
    expect(claudeLineEvents({ type: 'user', message: { content: 'hi' } })).toEqual([])
    expect(claudeLineEvents({ type: 'summary' })).toEqual([])
    expect(claudeLineEvents(null)).toEqual([])
  })
})

describe('codexLineEvents — tool calls from a rollout line', () => {
  test('function_call with a shell command → verb label', () => {
    const line = {
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"sed -n 1,5p f"}' },
    }
    expect(codexLineEvents(line)).toEqual([{ tool: 'exec_command', label: 'sed' }])
  })
  test('custom_tool_call (apply_patch) → bare tool name', () => {
    const line = {
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', status: 'completed' },
    }
    expect(codexLineEvents(line)).toEqual([{ tool: 'apply_patch' }])
  })
  test('tool_search_call → tool_search gesture', () => {
    expect(codexLineEvents({ type: 'response_item', payload: { type: 'tool_search_call' } })).toEqual(
      [{ tool: 'tool_search' }],
    )
  })
  test('non tool-call response items are ignored', () => {
    expect(codexLineEvents({ type: 'response_item', payload: { type: 'message' } })).toEqual([])
    expect(codexLineEvents({ type: 'event_msg', payload: { type: 'token_count' } })).toEqual([])
  })
  const codexSend = (target: string) => ({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'mcp__iap__send_to_peer',
      arguments: JSON.stringify({ personality: target, message: 'hi' }),
    },
  })
  test('no operator predicate → send_to_peer function_call hidden (v0.8.1 default)', () => {
    expect(codexLineEvents(codexSend('arthur'))).toEqual([])
  })
  test('target-aware (v0.8.2): operator send hidden, agent send shown with target label', () => {
    const isOperator = (p: string) => p === 'arthur'
    expect(codexLineEvents(codexSend('arthur'), isOperator)).toEqual([])
    expect(codexLineEvents(codexSend('darwin'), isOperator)).toEqual([
      { tool: 'send_to_peer', label: 'darwin' },
    ])
  })
})

describe('context tokens — current occupancy, window-independent (v0.8)', () => {
  test('claude: input + cache_read + cache_creation of a main-chain assistant turn', () => {
    const line = {
      type: 'assistant',
      message: {
        usage: { input_tokens: 2, cache_read_input_tokens: 682333, cache_creation_input_tokens: 2381 },
      },
    }
    expect(claudeContextTokens(line)).toBe(684716)
  })
  test('claude: skips sidechain (subagent) usage and lines without usage', () => {
    expect(
      claudeContextTokens({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 999 } } }),
    ).toBeNull()
    expect(claudeContextTokens({ type: 'assistant', message: {} })).toBeNull()
    expect(claudeContextTokens({ type: 'user' })).toBeNull()
    expect(claudeContextTokens(null)).toBeNull()
  })
  test('codex: last_token_usage.input_tokens from a token_count payload', () => {
    const line = {
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 28119, total_tokens: 28345 },
          last_token_usage: { input_tokens: 16864, cached_input_tokens: 4992, total_tokens: 16973 },
          model_context_window: 258400,
        },
      },
    }
    expect(codexContextTokens(line)).toBe(16864)
  })
  test('codex: non-token_count payloads and malformed input → null', () => {
    expect(codexContextTokens({ payload: { type: 'function_call' } })).toBeNull()
    expect(codexContextTokens({ payload: { type: 'token_count', info: {} } })).toBeNull()
    expect(codexContextTokens(null)).toBeNull()
  })
})

describe('renderActivity — splash header, per-line gestures, full collapse (v0.5)', () => {
  const events = [
    { tool: 'Bash', label: 'чистка логов' },
    { tool: 'vault_search' },
    { tool: 'Read', label: 'CLAUDE.md' },
  ]
  test('active: static splash on top, one gesture per line, labels after a colon', () => {
    expect(renderActivity('Pondering', events, true)).toBe(
      'Pondering…\n▸ Bash: чистка логов\n▸ vault_search\n▸ Read: CLAUDE.md',
    )
  })
  test('no gear and no peer name anywhere in the active frame', () => {
    const out = renderActivity('Pondering', events, true)
    expect(out.includes('⚙️')).toBe(false)
    expect(out.includes('boris')).toBe(false)
  })
  test('active with no tools yet is just the splash header (shown instantly at turn start, v0.6)', () => {
    expect(renderActivity('Spinning', [], true)).toBe('Spinning…')
  })
  test('final: collapse to claude-code finish "<past verb> for <duration>" (v0.8)', () => {
    expect(renderActivity('Pondering', events, false, 32000)).toBe('Pondered for 32s')
    expect(renderActivity('Churning', events, false, 82000)).toBe('Churned for 1m 22s')
    // verb + time only — no step count, no "✓" (matches the owner's sample)
    expect(renderActivity('Honking', events, false, 5000)).not.toContain('шаг')
    expect(renderActivity('Honking', events, false, 5000)).not.toContain('✓')
  })
  test('final duration is independent of the step count', () => {
    expect(renderActivity('Brewing', [{ tool: 'A' }], false, 45000)).toBe('Brewed for 45s')
    expect(renderActivity('Brewing', [], false, 45000)).toBe('Brewed for 45s')
  })
  test('final appends context tokens when known, omits when null (v0.8)', () => {
    expect(renderActivity('Churning', events, false, 82000, 680958)).toBe(
      'Churned for 1m 22s · 680958 tokens',
    )
    expect(renderActivity('Pondering', events, false, 32000, null)).toBe('Pondered for 32s')
    // active frame ignores duration/tokens entirely
    expect(renderActivity('Honking', [{ tool: 'A' }], true, 99000, 12345)).toBe('Honking…\n▸ A')
  })
  test('long active histories collapse older lines behind a leading "⋯"', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ tool: `T${i}` }))
    const out = renderActivity('Vibing', many, true)
    const lines = out.split('\n')
    expect(lines[0]).toBe('Vibing…')
    expect(lines[1]).toBe('⋯')
    expect(out.includes('▸ T0\n') || out.endsWith('▸ T0')).toBe(false) // oldest dropped
    expect(out.endsWith('▸ T39')).toBe(true) // newest kept
  })
})

describe('pastTenseVerb — splash gerund → completion verb (v0.8)', () => {
  test('regular -ing → -ed', () => {
    expect(pastTenseVerb('Pondering')).toBe('Pondered')
    expect(pastTenseVerb('Churning')).toBe('Churned')
    expect(pastTenseVerb('Honking')).toBe('Honked')
    expect(pastTenseVerb('Brewing')).toBe('Brewed')
    expect(pastTenseVerb('Working')).toBe('Worked')
  })
  test('silent-e stems restore correctly ("+ed" re-adds the e)', () => {
    expect(pastTenseVerb('Baking')).toBe('Baked')
    expect(pastTenseVerb('Forging')).toBe('Forged')
    expect(pastTenseVerb('Creating')).toBe('Created')
    expect(pastTenseVerb('Ruminating')).toBe('Ruminated')
    expect(pastTenseVerb('Vibing')).toBe('Vibed')
  })
  test('consonant+y → -ied, vowel+y → -ed', () => {
    expect(pastTenseVerb('Shimmying')).toBe('Shimmied')
    expect(pastTenseVerb('Moseying')).toBe('Moseyed')
  })
  test('irregulars overridden by hand', () => {
    expect(pastTenseVerb('Thinking')).toBe('Thought')
    expect(pastTenseVerb('Spinning')).toBe('Spun')
    expect(pastTenseVerb('Doing')).toBe('Did')
  })
  test('result never keeps the "-ing" gerund suffix', () => {
    for (let i = 0; i < 60; i++) {
      expect(pastTenseVerb(pickSplash()).endsWith('ing')).toBe(false)
    }
  })
})

describe('formatTurnDuration — claude-code style elapsed (v0.8)', () => {
  test('seconds, minutes, hours', () => {
    expect(formatTurnDuration(5000)).toBe('5s')
    expect(formatTurnDuration(45000)).toBe('45s')
    expect(formatTurnDuration(82000)).toBe('1m 22s')
    expect(formatTurnDuration(60000)).toBe('1m 0s')
    expect(formatTurnDuration(3 * 3600_000 + 5 * 60_000 + 3000)).toBe('3h 5m 3s')
  })
  test('floors to whole seconds, never below 1s', () => {
    expect(formatTurnDuration(1500)).toBe('1s')
    expect(formatTurnDuration(0)).toBe('1s')
    expect(formatTurnDuration(999)).toBe('1s')
  })
})

describe('skipStatusFlush — v0.7 status-message gates', () => {
  // signature: (active, hasStatus, hasEvents, allowSplashOnly)
  test('final collapse with no status open is skipped (no orphan "✓ 0 шагов")', () => {
    expect(skipStatusFlush(false, false, false, false)).toBe(true)
    expect(skipStatusFlush(false, false, true, true)).toBe(true) // even if events linger, nothing to edit
  })
  test('final collapse WITH a status open is NOT skipped (it edits in place)', () => {
    expect(skipStatusFlush(false, true, true, false)).toBe(false)
    expect(skipStatusFlush(false, true, false, false)).toBe(false) // collapse to ✓ 0 only if a status was open
  })
  test('turn-start splash (no status, no events, splash allowed) is NOT skipped', () => {
    expect(skipStatusFlush(true, false, false, true)).toBe(false)
  })
  test('post-checkpoint bare splash (no status, no events, splash disallowed) IS skipped', () => {
    expect(skipStatusFlush(true, false, false, false)).toBe(true)
  })
  test('post-checkpoint with a real tool call opens статус2 (not skipped)', () => {
    expect(skipStatusFlush(true, false, true, false)).toBe(false)
  })
  test('an already-open status keeps editing regardless of splash policy', () => {
    expect(skipStatusFlush(true, true, false, false)).toBe(false)
    expect(skipStatusFlush(true, true, true, false)).toBe(false)
  })
})

describe('shouldRebindTranscript — fresh-wake stale-binding self-heal gate', () => {
  // signature: (boundPath, boundMtimeMs, candidatePath, candidateMtimeMs, turnStartedMs, graceMs?)
  const T = 1_800_000_000_000 // turn start
  const GRACE = 15_000

  test('the repro: bound to the previous session corpse, fresh file born after turn start → rebind', () => {
    // mrmechanic 17.07: bound df0c984b (mtime 15.07), 138d6530 born ~1s into the turn
    expect(shouldRebindTranscript('/p/dead.jsonl', T - 2 * 86_400_000, '/p/live.jsonl', T + 1_000, T, GRACE)).toBe(true)
  })
  test('no reader at turn start (first-ever session, reader.none) + fresh candidate → bind', () => {
    expect(shouldRebindTranscript(null, null, '/p/live.jsonl', T + 2_000, T, GRACE)).toBe(true)
  })
  test('bound file advanced since turn start → proved live, never swapped', () => {
    expect(shouldRebindTranscript('/p/live.jsonl', T + 5_000, '/p/other.jsonl', T + 6_000, T, GRACE)).toBe(false)
  })
  test('candidate is the bound file itself → no-op', () => {
    expect(shouldRebindTranscript('/p/a.jsonl', T - 1_000, '/p/a.jsonl', T + 1_000, T, GRACE)).toBe(false)
  })
  test('no candidate at all → keep whatever is bound', () => {
    expect(shouldRebindTranscript('/p/dead.jsonl', T - 86_400_000, null, null, T, GRACE)).toBe(false)
  })
  test('stale candidate (older than turnStart − grace) is a dead file, not a rebind target', () => {
    expect(shouldRebindTranscript('/p/dead.jsonl', T - 86_400_000, '/p/older.jsonl', T - GRACE - 1, T, GRACE)).toBe(false)
    expect(shouldRebindTranscript(null, null, '/p/older.jsonl', T - GRACE - 1, T, GRACE)).toBe(false)
  })
  test('grace boundary: candidate mtime exactly at turnStart − grace counts as live', () => {
    expect(shouldRebindTranscript('/p/dead.jsonl', T - 86_400_000, '/p/edge.jsonl', T - GRACE, T, GRACE)).toBe(true)
  })
  test('unstat-able candidate (mtime null) is never a rebind target', () => {
    expect(shouldRebindTranscript('/p/dead.jsonl', T - 86_400_000, '/p/gone.jsonl', null, T, GRACE)).toBe(false)
  })
  test('bound file unstat-able (vanished) + fresh candidate → rebind', () => {
    expect(shouldRebindTranscript('/p/gone.jsonl', null, '/p/live.jsonl', T + 1_000, T, GRACE)).toBe(true)
  })
})

describe('pickSplash — a claude-code working verb, one per turn', () => {
  test('returns a non-empty capitalized verb every call', () => {
    for (let i = 0; i < 30; i++) {
      const w = pickSplash()
      expect(typeof w).toBe('string')
      expect(w.length).toBeGreaterThan(0)
      expect(w[0]).toBe(w[0].toUpperCase())
    }
  })
})

describe('claudeProjectDirName — cwd → ~/.claude/projects dir', () => {
  test('non-alphanumerics become dashes, case preserved, no run-collapsing', () => {
    expect(claudeProjectDirName('/Users/macmini/Peers/boris')).toBe('-Users-macmini-Peers-boris')
    expect(claudeProjectDirName('/Users/macmini/.mergemind-dreamer')).toBe(
      '-Users-macmini--mergemind-dreamer',
    )
  })
})

describe('freshestRuntime — the peer’s LIVE runtime = its freshest pane-log', () => {
  test('codex live, claude pane-log absent → codex (the linus case: default_runtime=claude, running codex)', () => {
    expect(
      freshestRuntime([{ runtime: 'claude', mtimeMs: null }, { runtime: 'codex', mtimeMs: 1000 }], 'claude'),
    ).toBe('codex')
  })
  test('both pane-logs exist → the freshest (active turn repaints the live one ~1Hz)', () => {
    expect(
      freshestRuntime([{ runtime: 'claude', mtimeMs: 500 }, { runtime: 'codex', mtimeMs: 900 }], 'claude'),
    ).toBe('codex')
    expect(
      freshestRuntime([{ runtime: 'claude', mtimeMs: 900 }, { runtime: 'codex', mtimeMs: 500 }], 'claude'),
    ).toBe('claude')
  })
  test('no pane-log exists yet (never-run peer) → fall back to the declared default', () => {
    expect(
      freshestRuntime([{ runtime: 'claude', mtimeMs: null }, { runtime: 'codex', mtimeMs: null }], 'claude'),
    ).toBe('claude')
    expect(freshestRuntime([], 'codex')).toBe('codex')
  })
  test('single candidate present → it', () => {
    expect(freshestRuntime([{ runtime: 'codex', mtimeMs: 42 }], 'claude')).toBe('codex')
  })
})

describe('pickVerifiedRuntime — verb-first resolution, closing the flip-race', () => {
  test('verb wins over the fallback, including when they disagree', () => {
    expect(
      pickVerifiedRuntime({ status: 0, stdout: 'codex' }, ['claude', 'codex'], 'claude'),
    ).toEqual({ runtime: 'codex', source: 'verb', verbBroken: false })
    // Agreement is also a "verb wins" case — the verb's verdict is still what's cached.
    expect(
      pickVerifiedRuntime({ status: 0, stdout: 'claude' }, ['claude', 'codex'], 'claude'),
    ).toEqual({ runtime: 'claude', source: 'verb', verbBroken: false })
  })

  test('exit 1 (no live session) → fallback, not a verb breakage', () => {
    expect(
      pickVerifiedRuntime({ status: 1, stdout: '' }, ['claude', 'codex'], 'claude'),
    ).toEqual({ runtime: 'claude', source: 'fallback', verbBroken: false })
  })

  test('empty stdout (status 0) → fallback, not a verb breakage', () => {
    expect(
      pickVerifiedRuntime({ status: 0, stdout: '   ' }, ['claude', 'codex'], 'claude'),
    ).toEqual({ runtime: 'claude', source: 'fallback', verbBroken: false })
  })

  test('error → fallback, verbBroken=true', () => {
    expect(
      pickVerifiedRuntime(
        { status: null, stdout: '', error: new Error('spawn ENOENT') },
        ['claude', 'codex'],
        'claude',
      ),
    ).toEqual({ runtime: 'claude', source: 'fallback', verbBroken: true })
  })

  test('timedOut → fallback, verbBroken=true', () => {
    expect(
      pickVerifiedRuntime({ status: null, stdout: '', timedOut: true }, ['claude', 'codex'], 'claude'),
    ).toEqual({ runtime: 'claude', source: 'fallback', verbBroken: true })
  })

  test('unexpected non-0/1 exit code → fallback, verbBroken=true', () => {
    expect(
      pickVerifiedRuntime({ status: 2, stdout: '' }, ['claude', 'codex'], 'claude'),
    ).toEqual({ runtime: 'claude', source: 'fallback', verbBroken: true })
  })

  test('verb answers a runtime OUTSIDE the peer\'s declared set → fallback (defensive), not a verb breakage', () => {
    expect(
      pickVerifiedRuntime({ status: 0, stdout: 'gemini' }, ['claude', 'codex'], 'claude'),
    ).toEqual({ runtime: 'claude', source: 'fallback', verbBroken: false })
  })

  test('stdout whitespace is trimmed before comparison', () => {
    expect(
      pickVerifiedRuntime({ status: 0, stdout: '  codex\n' }, ['claude', 'codex'], 'claude'),
    ).toEqual({ runtime: 'codex', source: 'verb', verbBroken: false })
  })
})

describe('parseActivityCommand — operator toggle grammar', () => {
  test('on/off/status and bare /activity (= status)', () => {
    expect(parseActivityCommand('/activity on')).toBe('on')
    expect(parseActivityCommand('  /activity off ')).toBe('off')
    expect(parseActivityCommand('/activity status')).toBe('status')
    expect(parseActivityCommand('/activity')).toBe('status')
    expect(parseActivityCommand('/activity@boris_bot on')).toBe('on')
  })
  test('non-commands and prose are not intercepted', () => {
    expect(parseActivityCommand('activity on')).toBeNull()
    expect(parseActivityCommand('/activitys')).toBeNull()
    expect(parseActivityCommand('что там по activity')).toBeNull()
    expect(parseActivityCommand('/activity please turn on')).toBeNull()
  })
})
