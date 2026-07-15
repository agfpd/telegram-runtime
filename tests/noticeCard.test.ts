import { describe, expect, test } from 'bun:test'
import { buildNoticeText, formatDuration, formatResetLine, formatStamp } from '../src/noticeCard.ts'
import type { FleetNotice } from '../src/fleetClient.ts'

/** The REAL notice the daemon served at 18:22 on 15.07.2026, when the fable bucket was
 *  genuinely empty (GET /fleet/v1/notices, iapeer 0.4.94) — copied field-for-field rather
 *  than invented, so the renderer is pinned against bytes the daemon actually produced.
 *  Note what is NOT here: `resetsAtMs`. That absence is the fixture's whole point. */
const LIVE_FABLE_NOTICE: FleetNotice = {
  personality: 'iapeer',
  runtime: 'claude',
  kind: 'peer-mute',
  errorType: 'rate_limit',
  model: 'Fable 5',
  content: "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
  sessionId: '89655ffc-32ea-44bb-9fee-5652694c2ef4',
  summary: 'iapeer · claude — rate_limit (Fable 5)',
  id: 'n1',
  createdMs: 1784139401263,
  lastMs: 1784139441259,
  expiresMs: 1784143001263,
  count: 3,
}

function notice(over: Partial<FleetNotice> = {}): FleetNotice {
  return { ...LIVE_FABLE_NOTICE, ...over }
}

const NOW = 1784139500000 // during the live notice's TTL

describe('formatDuration', () => {
  test('sub-minute', () => {
    expect(formatDuration(20_000)).toBe('меньше минуты')
  })
  test('minutes', () => {
    expect(formatDuration(40 * 60_000)).toBe('40 мин')
  })
  test('hours + minutes', () => {
    expect(formatDuration((2 * 60 + 5) * 60_000)).toBe('2 ч 5 мин')
  })
  test('days drop the minutes as noise', () => {
    expect(formatDuration((3 * 1440 + 2 * 60 + 7) * 60_000)).toBe('3 д 2 ч')
  })
})

describe('formatStamp', () => {
  test('same day → time only', () => {
    const at = new Date(NOW).setHours(23, 40, 0, 0)
    expect(formatStamp(at, NOW)).toBe('23:40')
  })
  test('another day → date + time (a multi-day wall cannot read as tonight)', () => {
    const at = new Date(NOW).setHours(23, 40, 0, 0) + 3 * 86_400_000
    expect(formatStamp(at, NOW)).toMatch(/^\d{2}\.\d{2} 23:40$/)
  })
})

describe('formatResetLine — the honest-omission contract (docs/19 obligation 2)', () => {
  test('ABSENT resetsAtMs renders an explicit unknown, naming the runtime as the reason', () => {
    const line = formatResetLine(undefined, NOW)
    expect(line).toContain('время сброса неизвестно')
    expect(line).toContain('рантайм его не сообщил')
  })

  test('ABSENT resetsAtMs never renders a clock time, a date or a "через" estimate', () => {
    const line = formatResetLine(undefined, NOW)
    // The failure this guards is substituting the 5h/7d statusline reset for a model
    // bucket that states none — measured live 15.07.2026 at 5h 11 % / 7d 66 % while fable
    // was fully exhausted. Any digit here would be that lie.
    expect(line).not.toMatch(/\d/)
    expect(line).not.toContain('через')
  })

  test('PRESENT resetsAtMs renders the stamp and the wait', () => {
    const line = formatResetLine(NOW + 40 * 60_000, NOW)
    expect(line).toContain('через 40 мин')
  })

  test('a reset already in the past says so instead of a negative wait', () => {
    const line = formatResetLine(NOW - 5 * 60_000, NOW)
    expect(line).toContain('уже прошёл')
    expect(line).not.toContain('-')
  })
})

describe('buildNoticeText', () => {
  test('the live fable notice renders who / runtime / errorType / model / honest reset', () => {
    const text = buildNoticeText(notice(), NOW)
    expect(text).toContain('Пир онемел')
    expect(text).toContain('<b>iapeer</b>') // кто
    expect(text).toContain('claude') // какой рантайм
    expect(text).toContain('<code>rate_limit</code>') // тип ошибки, verbatim
    expect(text).toContain('Fable 5') // модель
    expect(text).toContain('время сброса неизвестно') // честная омиссия
    expect(text).toContain("You've reached your Fable 5 limit") // verbatim refusal
  })

  test('count > 1 renders ×N (the board dedups; the face only reports)', () => {
    expect(buildNoticeText(notice({ count: 3 }), NOW)).toContain('×3')
  })

  test('count == 1 renders no multiplier', () => {
    expect(buildNoticeText(notice({ count: 1 }), NOW)).not.toContain('×')
  })

  test('an absent model is stated as unstated, not silently dropped (codex always)', () => {
    const text = buildNoticeText(notice({ model: undefined }), NOW)
    expect(text).toContain('модель не указана')
  })

  test('an unknown kind renders its raw name and is still a usable message', () => {
    const text = buildNoticeText(notice({ kind: 'peer-possessed' }), NOW)
    expect(text).toContain('peer-possessed')
    expect(text).toContain('<b>iapeer</b>')
  })

  test('an unknown errorType is passed through verbatim', () => {
    expect(buildNoticeText(notice({ errorType: 'brand_new_wall' }), NOW)).toContain('<code>brand_new_wall</code>')
  })

  test('a codex-shaped notice (reset stated, model unstated) renders both correctly', () => {
    const text = buildNoticeText(
      notice({
        personality: 'linus',
        runtime: 'codex',
        errorType: 'rate_limit_reached',
        model: undefined,
        resetsAtMs: NOW + 90 * 60_000,
        content: 'primary: 100% (5h), secondary: 17% (7d)',
      }),
      NOW,
    )
    expect(text).toContain('модель не указана')
    expect(text).toContain('через 1 ч 30 мин')
    expect(text).not.toContain('неизвестно')
  })

  test('HTML metacharacters in runtime prose are escaped (content is arbitrary)', () => {
    const text = buildNoticeText(notice({ content: '<script>alert(1)</script> & done' }), NOW)
    expect(text).toContain('&lt;script&gt;')
    expect(text).toContain('&amp; done')
    expect(text).not.toContain('<script>')
  })

  test('a hostile personality/model cannot inject markup', () => {
    const text = buildNoticeText(notice({ personality: '<b>evil', model: '<i>x' }), NOW)
    expect(text).toContain('&lt;b&gt;evil')
    expect(text).toContain('&lt;i&gt;x')
  })

  test('long content is truncated well under the 4096 Telegram cap, pointing at the CLI', () => {
    const text = buildNoticeText(notice({ content: 'x'.repeat(9000) }), NOW)
    expect(text.length).toBeLessThan(4096)
    expect(text).toContain('iapeer notices')
  })
})
