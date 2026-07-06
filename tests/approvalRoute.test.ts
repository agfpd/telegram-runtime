import { describe, expect, test } from 'bun:test'
import { pickApprovalRoute } from '../src/cli.ts'

type Dir = Map<string, { interfaces?: { telegram?: { bot_username?: string; bot?: string } } }>

function dir(entries: Record<string, string | null>): Dir {
  const m: Dir = new Map()
  for (const [personality, botUsername] of Object.entries(entries)) {
    m.set(personality, botUsername ? { interfaces: { telegram: { bot_username: botUsername } } } : {})
  }
  return m
}

describe('pickApprovalRoute — faced / faceless / no-route (criterion #3/#4)', () => {
  test('FACED: peer with its own loaded bot routes to that bot', () => {
    const d = dir({ boris: 'boris_bot' })
    const route = pickApprovalRoute('boris', d, k => k === 'boris_bot')
    expect(route).toEqual({ botKey: 'boris_bot', kind: 'faced' })
  })

  test('FACELESS: peer with no own bot routes to the shared approval bot', () => {
    const d = dir({ iapeer: null, approval: 'appr_bot' })
    const route = pickApprovalRoute('iapeer', d, k => k === 'appr_bot')
    expect(route).toEqual({ botKey: 'appr_bot', kind: 'faceless' })
  })

  test('FACELESS: peer whose own bot is NOT loaded falls back to the approval bot', () => {
    // has a bot_username on paper but that credential is not loaded in this process
    const d = dir({ somepeer: 'unloaded_bot', approval: 'appr_bot' })
    const route = pickApprovalRoute('somepeer', d, k => k === 'appr_bot')
    expect(route).toEqual({ botKey: 'appr_bot', kind: 'faceless' })
  })

  test('NO ROUTE: faceless peer + no approval bot provisioned → null (bar/CLI hold it)', () => {
    const d = dir({ iapeer: null })
    expect(pickApprovalRoute('iapeer', d, () => false)).toBeNull()
  })

  test('NO ROUTE: faceless peer + approval bot present but its credential not loaded → null', () => {
    const d = dir({ iapeer: null, approval: 'appr_bot' })
    expect(pickApprovalRoute('iapeer', d, () => false)).toBeNull()
  })

  test('unknown peer with an approval bot still routes faceless (defensive)', () => {
    const d = dir({ approval: 'appr_bot' })
    expect(pickApprovalRoute('ghost', d, k => k === 'appr_bot')).toEqual({ botKey: 'appr_bot', kind: 'faceless' })
  })

  test('FACED wins over the approval bot when the peer has its own loaded bot', () => {
    const d = dir({ boris: 'boris_bot', approval: 'appr_bot' })
    const route = pickApprovalRoute('boris', d, () => true)
    expect(route).toEqual({ botKey: 'boris_bot', kind: 'faced' })
  })
})
