import { describe, expect, test } from 'bun:test'
import { pickApprovalRoute } from '../src/cli.ts'

type Dir = Map<string, { interfaces?: { telegram?: { bot_username?: string } } }>

function dir(entries: Record<string, string | null>): Dir {
  const m: Dir = new Map()
  for (const [personality, botUsername] of Object.entries(entries)) {
    m.set(personality, botUsername ? { interfaces: { telegram: { bot_username: botUsername } } } : {})
  }
  return m
}

// The shared approval bot is now a role-marked SERVICE-bot (its botKey passed in), NOT a
// foundation peer looked up in the directory (decoupled per the 2026-07-06 iapeer validation).
describe('pickApprovalRoute — faced / faceless / no-route (criterion #3/#4)', () => {
  test('FACED: peer with its own loaded bot routes to that bot', () => {
    const d = dir({ boris: 'boris_bot' })
    const route = pickApprovalRoute('boris', d, k => k === 'boris_bot', 'appr_bot')
    expect(route).toEqual({ botKey: 'boris_bot', kind: 'faced' })
  })

  test('FACELESS: peer with no own bot routes to the shared approval service-bot', () => {
    const d = dir({ iapeer: null })
    const route = pickApprovalRoute('iapeer', d, k => k === 'appr_bot', 'appr_bot')
    expect(route).toEqual({ botKey: 'appr_bot', kind: 'faceless' })
  })

  test('FACELESS: peer whose own bot is NOT loaded falls back to the approval bot', () => {
    // has a bot_username on paper but that credential is not loaded in this process
    const d = dir({ somepeer: 'unloaded_bot' })
    const route = pickApprovalRoute('somepeer', d, k => k === 'appr_bot', 'appr_bot')
    expect(route).toEqual({ botKey: 'appr_bot', kind: 'faceless' })
  })

  test('NO ROUTE: faceless peer + approval bot declined/unprovisioned (undefined key) → null', () => {
    const d = dir({ iapeer: null })
    expect(pickApprovalRoute('iapeer', d, () => false, undefined)).toBeNull()
  })

  test('NO ROUTE: faceless peer + approval bot key given but its credential not loaded → null', () => {
    const d = dir({ iapeer: null })
    expect(pickApprovalRoute('iapeer', d, () => false, 'appr_bot')).toBeNull()
  })

  test('unknown peer with an approval bot still routes faceless (defensive)', () => {
    const d = dir({})
    expect(pickApprovalRoute('ghost', d, k => k === 'appr_bot', 'appr_bot')).toEqual({
      botKey: 'appr_bot',
      kind: 'faceless',
    })
  })

  test('FACED wins over the approval bot when the peer has its own loaded bot', () => {
    const d = dir({ boris: 'boris_bot' })
    const route = pickApprovalRoute('boris', d, () => true, 'appr_bot')
    expect(route).toEqual({ botKey: 'boris_bot', kind: 'faced' })
  })
})
