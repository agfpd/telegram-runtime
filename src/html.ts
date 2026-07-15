// html — the ONE HTML-escape used by every Telegram `parse_mode: 'HTML'` payload this
// runtime builds (approval cards, notice messages).
//
// It lives alone in its own module rather than as a private copy per card renderer because
// both copies escape the SAME thing — arbitrary, untrusted runtime prose (a command, a
// diff, a model's refusal sentence) — and a fix applied to one copy while the other keeps
// the old behaviour is precisely the divergence this repo already learned to avoid the
// hard way with the IAP parser.

/** Escape the three characters Telegram's HTML parse_mode treats as markup.
 *
 *  `& < >` is the COMPLETE set for text content and for `<pre>` / `<code>` bodies, which is
 *  all this runtime emits (per Telegram's Bot API "HTML style" rules). Quotes are NOT
 *  escaped because nothing here interpolates into an attribute value — if that ever
 *  changes, `"` must be added HERE, once, rather than in a new copy. */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
