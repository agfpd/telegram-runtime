// approvalCard — pure rendering + callback-data helpers for the Telegram approval card
// (Ф3 U3, docs/17). The card shows the CONCRETE action content (criterion #7) with two
// inline buttons; a tap posts a resolution to the broker. Kept pure and dependency-free so
// the grammy run-loop wires it (cli.ts) but the formatting/escaping and the 64-byte
// callback_data contract are unit-tested here in isolation.

import type { PendingApproval } from './fleetClient.ts'
import { escHtml } from './html.ts'

/** callback_data schema: `apv:<id>:<a|d>`. Only id + action travel (the 64-byte Telegram
 *  limit); the full action content lives in the message + the broker queue. */
export const CB_PREFIX = 'apv'
export type CardAction = 'approve' | 'deny'

export function buildCallbackData(id: string, action: CardAction): string {
  return `${CB_PREFIX}:${id}:${action === 'approve' ? 'a' : 'd'}`
}

/** Parse our callback_data. Returns null for anything not ours (other buttons on other
 *  bots share the callback_query channel — we must ignore them cleanly). */
export function parseCallbackData(data: string | undefined): { id: string; action: CardAction } | null {
  if (!data) return null
  const parts = data.split(':')
  if (parts.length !== 3 || parts[0] !== CB_PREFIX) return null
  const id = parts[1]!
  const a = parts[2]
  if (!id || (a !== 'a' && a !== 'd')) return null
  return { id, action: a === 'a' ? 'approve' : 'deny' }
}

/** Max chars of `content` embedded in the card. Telegram's message cap is 4096; the HTML
 *  wrapper + header take a slice, so the content body is bounded well under it. */
export const CARD_CONTENT_MAX = 3500

/** Truncate long content (a big diff / a Write body) with an explicit marker pointing at
 *  the CLI where the full text is always available. */
export function truncateContent(content: string, max = CARD_CONTENT_MAX): string {
  if (content.length <= max) return content
  return `${content.slice(0, max)}\n… (усечено, полностью: iapeer approvals)`
}

/** The default deny reason when the owner taps ⛔ (v1 — a fixed reason; a free-form
 *  reason via force_reply is v1.1). The broker delivers this to the model. */
export const DENY_REASON = 'Отклонено человеком из Telegram'

/** The card body (HTML parse_mode). HTML is used over MarkdownV2 because the action
 *  content is arbitrary (commands, diffs) and only `& < >` need escaping inside <pre> —
 *  MarkdownV2 would need fragile whole-string escaping. */
export function buildCardText(item: PendingApproval): string {
  const header = escHtml(item.title || `${item.personality} · ${item.tool}`)
  const sub = escHtml(`${item.runtime} · ${item.kind}`)
  const body = escHtml(truncateContent(item.content))
  return `🔒 <b>Требуется подтверждение</b>\n<b>${header}</b>\n${sub}\n\n<pre>${body}</pre>`
}

/** The card after resolution (any channel): keep the header + content, append the outcome,
 *  drop the buttons. Rebuilt from the stored item so every face converges on the same edit. */
export function buildResolvedText(
  item: PendingApproval,
  info: { decision?: string; reason?: string; by?: string; via?: string },
): string {
  const allow = info.decision === 'allow'
  const glyph = allow ? '✅' : info.via === 'timeout' ? '⏳' : '⛔'
  const verdict = allow ? 'Разрешено' : info.via === 'timeout' ? 'Истекло — отклонено' : 'Отклонено'
  const header = escHtml(item.title || `${item.personality} · ${item.tool}`)
  const sub = escHtml(`${item.runtime} · ${item.kind}`)
  const body = escHtml(truncateContent(item.content))
  const meta: string[] = []
  if (info.by) meta.push(`by ${escHtml(info.by)}`)
  if (info.via) meta.push(`via ${escHtml(info.via)}`)
  const metaLine = meta.length ? `\n<i>${meta.join(' · ')}</i>` : ''
  const reasonLine = !allow && info.reason ? `\n${escHtml(info.reason)}` : ''
  return (
    `${glyph} <b>${verdict}</b> — <b>${header}</b>\n${sub}\n\n<pre>${body}</pre>` +
    `${reasonLine}${metaLine}`
  )
}

/** The two-button inline keyboard for a pending card. */
export function buildKeyboard(id: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [
      [
        { text: '✅ Разрешить', callback_data: buildCallbackData(id, 'approve') },
        { text: '⛔ Отклонить', callback_data: buildCallbackData(id, 'deny') },
      ],
    ],
  }
}
