// noticeCard — pure rendering for the Telegram peer-mute notice (docs/19). A notice is
// INFORMATION, not a request: no buttons, no callback_data, no resolution. That asymmetry
// against approvalCard.ts is the contract (docs/19 §1), not an omission — there is nothing
// for the owner to decide, only something to know.
//
// Kept pure and dependency-free so the grammy run-loop wires it (cli.ts) while the
// formatting and — above all — the HONESTY RULES are unit-tested here in isolation:
//
//   1. A field the runtime did not state is rendered as UNSTATED, never guessed. The
//      standing temptation is `resetsAtMs`: claude never says when a per-model bucket
//      lifts, and the 5h/7d reset sitting right there in the statusline blob belongs to a
//      DIFFERENT limit. Measured live 15.07.2026: 5h read 11 %, 7d read 66 %, while fable
//      was fully exhausted — "сброс в 23:40" would have been a confident, checkable lie
//      and the owner would have waited for a wall that was not the wall. Same for `model`.
//   2. `kind` and `errorType` are GROWTH SEAMS: render what arrives, including values this
//      code has never heard of. No exhaustive switch — an unknown kind still produces a
//      readable message rather than nothing (which is the failure this whole feature
//      exists to prevent).
//   3. `count` comes from the board, which dedups on the runtime event's own timestamp. We
//      render it and never count for ourselves.

import type { FleetNotice } from './fleetClient.ts'
import { escHtml } from './html.ts'

/** Max chars of `content` embedded in the message (Telegram caps a message at 4096; the
 *  HTML wrapper + header take a slice). Mirrors approvalCard's CARD_CONTENT_MAX. */
export const NOTICE_CONTENT_MAX = 3500

function truncate(content: string, max = NOTICE_CONTENT_MAX): string {
  if (content.length <= max) return content
  return `${content.slice(0, max)}\n… (усечено, полностью: iapeer notices)`
}

/** Human-readable duration, coarse on purpose: an owner needs "≈40 минут", not 40:12. */
export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 1) return 'меньше минуты'
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  const parts: string[] = []
  if (days) parts.push(`${days} д`)
  if (hours) parts.push(`${hours} ч`)
  // Minutes are noise next to a multi-day wait; keep them only at day-0 resolution.
  if (mins && !days) parts.push(`${mins} мин`)
  return parts.join(' ') || 'меньше минуты'
}

/** Wall-clock stamp in the HOST's timezone (the owner's — this runtime runs on his box).
 *  The date is included only when the reset is not today, so the common "in 40 minutes"
 *  case stays short while a multi-day wall can never be misread as tonight. */
export function formatStamp(atMs: number, now: number): string {
  const at = new Date(atMs)
  const sameDay = new Date(now).toDateString() === at.toDateString()
  const time = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return time
  return `${at.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`
}

/**
 * The reset line — the single most dangerous field on this card.
 *
 * ABSENT is a first-class, LOAD-BEARING answer: it means "the runtime did not say", which
 * is NOT "there is no limit" and NOT an invitation to substitute a reset from anywhere
 * else. The wording says WHY the value is missing so the owner reads a known-unknown
 * rather than suspecting a bug in this renderer.
 */
export function formatResetLine(resetsAtMs: number | undefined, now: number): string {
  if (resetsAtMs === undefined) return '⏳ Сброс: <b>время сброса неизвестно</b> — рантайм его не сообщил'
  const delta = resetsAtMs - now
  const stamp = formatStamp(resetsAtMs, now)
  // A reset already in the past (a notice read after its wall lifted) must not render as
  // "через -5 мин" — say it plainly instead.
  if (delta <= 0) return `⏳ Сброс: ${stamp} (уже прошёл)`
  return `⏳ Сброс: ${stamp} (через ${formatDuration(delta)})`
}

/** Header per `kind`. A LOOKUP WITH A FALLBACK, deliberately not a switch: `peer-mute` is
 *  merely v1 and new kinds ride this same surface (docs/19 obligation 4). An unknown kind
 *  renders its own raw name — informative and, more to the point, still DELIVERED. */
function headerFor(kind: string, personality: string): string {
  const who = `<b>${escHtml(personality)}</b>`
  if (kind === 'peer-mute') return `🔇 <b>Пир онемел</b> — ${who}`
  return `⚠️ <b>${escHtml(kind)}</b> — ${who}`
}

/**
 * The notice message body (HTML parse_mode — same reasoning as approvalCard: `content` is
 * arbitrary runtime prose, and inside <pre> only `& < >` need escaping).
 *
 * `now` is injected rather than read from the clock so the reset arithmetic is testable.
 */
export function buildNoticeText(item: FleetNotice, now: number = Date.now()): string {
  const header = headerFor(item.kind, item.personality)
  const repeat = item.count > 1 ? ` ×${item.count}` : ''
  // errorType verbatim in <code> — it is the runtime's OWN token and the thing to quote
  // when asking anyone about it; we neither translate nor normalize it.
  const model = item.model ? escHtml(item.model) : '<i>модель не указана</i>'
  const meta = `${escHtml(item.runtime)} · <code>${escHtml(item.errorType)}</code> · ${model}`
  const reset = formatResetLine(item.resetsAtMs, now)
  const body = escHtml(truncate(item.content))
  return `${header}${repeat}\n${meta}\n${reset}\n\n<pre>${body}</pre>`
}
