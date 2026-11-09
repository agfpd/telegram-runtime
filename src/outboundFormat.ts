// outboundFormat — peer message text → (visible text, Telegram MessageEntity[]).
//
// Contract (0.29.0, supersedes "literal only" of 0.28.11 without weakening it):
// the message is sent with an explicit `entities` array and NO parse_mode, so the
// Telegram server never interprets a single character. Formatting comes only from
// a deliberately STRICT subset of Markdown that this module recognises itself:
//
//   ```lang … ```  fenced block   → pre (language kept)   content byte-exact
//   `code`          inline code    → code                  content byte-exact
//   **bold**        same line      → bold
//   ~~strike~~      same line      → strikethrough
//   [text](https://…)              → text_link (http/https/tg/mailto only)
//   # Heading       line start     → bold (the "#… " prefix is the markup)
//
// Every other character is delivered verbatim: there is NO backslash-escape
// processing, NO `_`/`*` italics (SQL '%_%@%', snake_case, globs), NO `__bold__`
// (Python dunders), NO spoiler `||` (shell). A delimiter that does not form a
// complete, well-flanked span stays literal text. The only characters ever removed
// are the delimiters of a span that WAS recognised — so the visible text equals
// the source minus recognised markup, and code/pre content is never touched.

export type OutEntity =
  | { type: 'bold' | 'strikethrough' | 'code'; offset: number; length: number }
  | { type: 'pre'; offset: number; length: number; language?: string }
  | { type: 'text_link'; offset: number; length: number; url: string }

export interface Formatted {
  text: string
  entities: OutEntity[]
}

/** Telegram silently drops entities beyond this many per message (probed live 09.11.2026). */
export const MAX_ENTITIES_PER_MESSAGE = 100

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/
const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const LINK_URL = /^(?:https?:\/\/[^\s]+|tg:\/\/[^\s]+|mailto:[^\s]+)$/i
const LANG = /^[A-Za-z0-9_+#.-]{1,32}$/

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
}
function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch)
}
// Path/glob/escape characters cannot sit just inside a ** or ~~ span: `**/*.ts … src/**`
// and `~~/a … b/~~` stay literal (GFM would bold them — stricter on purpose).
function isEdgeHostile(ch: string | undefined): boolean {
  return isSpace(ch) || (ch !== undefined && '/\\*_~|%$'.includes(ch))
}

class Builder {
  text = ''
  entities: OutEntity[] = []
  push(s: string): void {
    this.text += s
  }
  wrap(type: 'bold' | 'strikethrough' | 'code', start: number): void {
    const length = this.text.length - start
    if (length > 0) this.entities.push({ type, offset: start, length })
  }
}

// Find the closing delimiter `delim` (** or ~~) for an opener at `i` on `line`.
// Opener: not preceded by a word char or the delimiter char, followed by non-space.
// Closer: preceded by non-space (not the delimiter char), not followed by a word char
// or the delimiter char. `2**3` / `a~~b` therefore never open a span.
function findPairClose(line: string, i: number, delim: string): number {
  const ch = delim[0]
  const prev = line[i - 1]
  const next = line[i + 2]
  if (isWordChar(prev) || prev === ch || isEdgeHostile(next)) return -1
  for (let j = line.indexOf(delim, i + 3); j !== -1; j = line.indexOf(delim, j + 1)) {
    const before = line[j - 1]
    const after = line[j + 2]
    if (!isEdgeHostile(before) && !isWordChar(after) && after !== ch) return j
  }
  return -1
}

// Inline pass over ONE line (spans never cross a newline).
function inline(line: string, b: Builder, opts: { allowCode: boolean; allowLink: boolean }): void {
  let i = 0
  let lit = ''
  const flush = () => {
    if (lit) b.push(lit)
    lit = ''
  }
  while (i < line.length) {
    const c = line[i]

    if (c === '`' && opts.allowCode) {
      let n = 1
      while (line[i + n] === '`') n++
      const fence = '`'.repeat(n)
      let close = -1
      for (let k = line.indexOf(fence, i + n); k !== -1; k = line.indexOf(fence, k + 1)) {
        if (line[k - 1] !== '`' && line[k + n] !== '`') {
          close = k
          break
        }
      }
      if (close !== -1 && close > i + n) {
        let content = line.slice(i + n, close)
        // CommonMark: one space each side is padding when both are present and the
        // content is not all spaces (lets an agent write `` `x` `` around a backtick).
        if (content.length > 2 && content[0] === ' ' && content.at(-1) === ' ' && content.trim()) {
          content = content.slice(1, -1)
        }
        flush()
        const start = b.text.length
        b.push(content)
        b.wrap('code', start)
        i = close + n
        continue
      }
      lit += fence
      i += n
      continue
    }

    if (c === '[' && opts.allowLink) {
      const rb = line.indexOf(']', i + 1)
      if (rb > i + 1 && line[rb + 1] === '(' && !line.slice(i + 1, rb).includes('[')) {
        let depth = 1
        let j = rb + 2
        for (; j < line.length; j++) {
          if (line[j] === '(') depth++
          else if (line[j] === ')' && --depth === 0) break
        }
        const url = depth === 0 ? line.slice(rb + 2, j) : ''
        if (url && LINK_URL.test(url)) {
          flush()
          const start = b.text.length
          // Telegram drops code nested in a text_link — keep backticks literal there.
          inline(line.slice(i + 1, rb), b, { allowCode: false, allowLink: false })
          const length = b.text.length - start
          if (length > 0) b.entities.push({ type: 'text_link', offset: start, length, url })
          i = j + 1
          continue
        }
      }
    }

    if ((c === '*' || c === '~') && line[i + 1] === c) {
      const delim = c + c
      const close = findPairClose(line, i, delim)
      if (close !== -1) {
        flush()
        const start = b.text.length
        inline(line.slice(i + 2, close), b, opts)
        b.wrap(c === '*' ? 'bold' : 'strikethrough', start)
        i = close + 2
        continue
      }
      lit += delim
      i += 2
      continue
    }

    lit += c
    i++
  }
  flush()
}

function textLine(line: string, b: Builder): void {
  const h = HEADING.exec(line)
  if (h) {
    const start = b.text.length
    inline(h[1], b, { allowCode: true, allowLink: true })
    b.wrap('bold', start)
    return
  }
  inline(line, b, { allowCode: true, allowLink: true })
}

/** Parse peer text into visible text + entities. Pure; never throws. */
export function formatOutbound(source: string): Formatted {
  const b = new Builder()
  const lines = source.split('\n')
  let first = true
  const newline = () => {
    if (!first) b.push('\n')
    first = false
  }
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const open = FENCE_OPEN.exec(line)
    if (open) {
      const indent = open[1].length
      const fch = open[2][0]
      const flen = open[2].length
      let close = -1
      for (let k = li + 1; k < lines.length; k++) {
        const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(lines[k])
        if (m && m[1][0] === fch && m[1].length >= flen) {
          close = k
          break
        }
      }
      // An unclosed fence is NOT a block: the line stays literal (nothing swallowed).
      if (close !== -1) {
        const body = lines
          .slice(li + 1, close)
          .map(l => {
            let k = 0
            while (k < indent && (l[k] === ' ' || l[k] === '\t')) k++
            return l.slice(k)
          })
          .join('\n')
        newline()
        const start = b.text.length
        b.push(body)
        if (body.length > 0) {
          const lang = open[3]
          b.entities.push(
            LANG.test(lang)
              ? { type: 'pre', offset: start, length: body.length, language: lang }
              : { type: 'pre', offset: start, length: body.length },
          )
        }
        li = close
        continue
      }
    }
    newline()
    textLine(line, b)
  }
  b.entities.sort((x, y) => x.offset - y.offset || y.length - x.length)
  return { text: b.text, entities: b.entities }
}

// ── chunking ─────────────────────────────────────────────────────────────────

const EDGE_WS = /[ \t\n\r]/

function clip(entities: OutEntity[], from: number, to: number): OutEntity[] {
  const out: OutEntity[] = []
  for (const e of entities) {
    const s = Math.max(e.offset, from)
    const t = Math.min(e.offset + e.length, to)
    if (t > s) out.push({ ...e, offset: s - from, length: t - s })
  }
  return out
}

/**
 * Split formatted text into Telegram-sized messages. Prefers to break BEFORE a
 * code/pre block that would straddle the limit (so the block arrives whole), then
 * at a newline; never splits a surrogate pair; keeps ≤ MAX_ENTITIES_PER_MESSAGE
 * entities per message. Edge whitespace is trimmed per chunk (the Bot API trims it
 * anyway — sending it would make the receipt text differ) with entity offsets
 * shifted to match. Chunks that are whitespace-only are dropped.
 */
export function chunkFormatted(f: Formatted, limit = 4096): Formatted[] {
  const { text, entities } = f
  const out: Formatted[] = []
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(offset + limit, text.length)
    if (end < text.length) {
      let forced = false
      // Entity budget: the (MAX+1)-th entity starting in this window ends the chunk.
      const starting = entities.filter(e => e.offset >= offset && e.offset < end)
      if (starting.length > MAX_ENTITIES_PER_MESSAGE) {
        const cut = starting[MAX_ENTITIES_PER_MESSAGE].offset
        if (cut > offset) {
          end = cut
          forced = true
        }
      }
      if (!forced) {
        const straddle = entities.find(
          e => (e.type === 'pre' || e.type === 'code') && e.offset > offset && e.offset < end && e.offset + e.length > end,
        )
        if (straddle && straddle.length <= limit) {
          end = straddle.offset
        } else {
          const floor = offset + Math.floor(limit / 2)
          const nl = text.lastIndexOf('\n', end - 1)
          if (nl > floor) end = nl
          else {
            const sp = text.lastIndexOf(' ', end - 1)
            if (sp > floor) end = sp
          }
        }
      }
      if (/[\uD800-\uDBFF]/.test(text[end - 1]) && end - 1 > offset) end--
    } else if (entities.filter(e => e.offset >= offset).length > MAX_ENTITIES_PER_MESSAGE) {
      const cut = entities.filter(e => e.offset >= offset)[MAX_ENTITIES_PER_MESSAGE].offset
      if (cut > offset) end = cut
    }
    let s = offset
    let t = end
    while (s < t && EDGE_WS.test(text[s])) s++
    while (t > s && EDGE_WS.test(text[t - 1])) t--
    if (t > s) out.push({ text: text.slice(s, t), entities: clip(entities, s, t) })
    offset = end
  }
  return out
}

/**
 * Did Telegram keep what we asked for? The server normalises (splits bold around a
 * nested code span, appends `/` to bare-host URLs, adds auto-detected url/mention
 * entities), so this is a coverage check, not equality: every requested code/pre/
 * text_link span exists with the same type, offset and length, and every character
 * of a requested bold/strikethrough span is covered by a span of that type unless
 * it sits inside a requested code/pre span.
 */
export function entitiesDelivered(expected: OutEntity[], received: Array<{ type: string; offset: number; length: number }>): boolean {
  const opaque = new Set<number>()
  for (const e of expected) {
    if (e.type === 'code' || e.type === 'pre') for (let k = e.offset; k < e.offset + e.length; k++) opaque.add(k)
  }
  for (const e of expected) {
    if (e.type === 'code' || e.type === 'pre' || e.type === 'text_link') {
      if (!received.some(r => r.type === e.type && r.offset === e.offset && r.length === e.length)) return false
      continue
    }
    for (let k = e.offset; k < e.offset + e.length; k++) {
      if (opaque.has(k)) continue
      if (!received.some(r => r.type === e.type && r.offset <= k && k < r.offset + r.length)) return false
    }
  }
  return true
}

/**
 * Plain-text degradation of a formatted chunk, used when Telegram rejects its
 * entities: styling is dropped, but a link's URL is kept inline as `text (url)` so
 * no content the agent wrote disappears with the styling.
 */
export function plainFallback(f: Formatted): string {
  let text = f.text
  const links = f.entities.filter(e => e.type === 'text_link').sort((a, b) => b.offset - a.offset)
  for (const l of links) {
    const at = l.offset + l.length
    text = text.slice(0, at) + ` (${(l as { url: string }).url})` + text.slice(at)
  }
  return text
}
