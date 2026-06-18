import { describe, expect, test } from 'bun:test'
import { extractIapEnvelopes, parseIapEnvelope } from '../src/cli.ts'

describe('IAP envelope stream shape', () => {
  test('extracts concatenated envelopes from one tmux paste stream', () => {
    const first =
      '<iap from-personality="boris" from-runtime="claude" from-intelligence="artificial">\n<message><![CDATA[one]]></message>\n</iap>'
    const second =
      '<iap from-personality="index" from-runtime="codex" from-intelligence="artificial">\n<message><![CDATA[two]]></message>\n</iap>'
    const stream = `${first}${second}\n`
    const result = extractIapEnvelopes(stream)

    expect(result.envelopes).toEqual([first, second])
    expect(result.rest).toBe('\n')
    expect(parseIapEnvelope(result.envelopes[0])).toMatchObject({
      fromPersonality: 'boris',
      fromRuntime: 'claude',
      fromIntelligence: 'artificial',
      message: 'one',
    })
    expect(parseIapEnvelope(result.envelopes[1])).toMatchObject({
      fromPersonality: 'index',
      fromRuntime: 'codex',
      fromIntelligence: 'artificial',
      message: 'two',
    })
  })

  test('parses optional topic and newline-separated attachments', () => {
    const envelope = [
      '<iap from-personality="boris" from-runtime="claude" from-intelligence="artificial" topic="report">',
      '<attachments><![CDATA[/tmp/a.txt',
      '/tmp/b.pdf]]></attachments>',
      '<message><![CDATA[done]]></message>',
      '</iap>',
    ].join('\n')

    expect(parseIapEnvelope(envelope)).toEqual({
      fromPersonality: 'boris',
      fromRuntime: 'claude',
      fromIntelligence: 'artificial',
      topic: 'report',
      attachments: ['/tmp/a.txt', '/tmp/b.pdf'],
      message: 'done',
    })
  })

  test('normalizes tmux-paste CRs to LF in the message', () => {
    // tmux paste rewrites every LF→CR; the raw-mode reader sees bare \r. The
    // message must come out with \n so Telegram renders the line breaks.
    const envelope =
      '<iap from-personality="boris" from-runtime="claude" from-intelligence="artificial">\r<message><![CDATA[para one\r\rline a\rline b]]></message>\r</iap>'
    const parsed = parseIapEnvelope(envelope)
    expect(parsed.message).toBe('para one\n\nline a\nline b')
    expect(parsed.message.includes('\r')).toBe(false)
  })

  test('folds CRLF pairs to a single LF (no doubled blank lines)', () => {
    const envelope =
      '<iap from-personality="boris" from-runtime="claude">\r\n<message><![CDATA[a\r\n\r\nb]]></message>\r\n</iap>'
    expect(parseIapEnvelope(envelope).message).toBe('a\n\nb')
  })

  test('CR-separated attachments still split after normalization', () => {
    const envelope =
      '<iap from-personality="boris" from-runtime="claude" from-intelligence="artificial" topic="t">\r<attachments><![CDATA[/tmp/a.txt\r/tmp/b.pdf]]></attachments>\r<message><![CDATA[m]]></message>\r</iap>'
    expect(parseIapEnvelope(envelope).attachments).toEqual(['/tmp/a.txt', '/tmp/b.pdf'])
  })

  test('tolerates legacy envelope without from-intelligence', () => {
    const envelope =
      '<iap from-personality="legacy" from-runtime="claude">\n<message><![CDATA[legacy peer]]></message>\n</iap>'
    expect(parseIapEnvelope(envelope)).toMatchObject({
      fromPersonality: 'legacy',
      fromRuntime: 'claude',
      message: 'legacy peer',
    })
    expect(parseIapEnvelope(envelope).fromIntelligence).toBeUndefined()
  })
})

describe('tag-like message bodies survive the CDATA boundary', () => {
  // The sender CDATA-wraps the body. An agent quoting the envelope's own tag
  // names ("</iap>", "</message>") used to truncate the envelope at the receiver
  // because the parser matched those literals as structural tags. The parser is
  // now CDATA-aware: tag text inside the body must round-trip verbatim.
  const wrap = (body: string) =>
    `<iap from-personality="boris" from-runtime="claude" from-intelligence="artificial">\n` +
    `<message><![CDATA[${body.replaceAll(']]>', ']]]]><![CDATA[>')}]]></message>\n</iap>`

  test('body containing the literal </iap> is not truncated', () => {
    const body = 'the IAP envelope ends with the </iap> tag'
    expect(parseIapEnvelope(wrap(body)).message).toBe(body)
  })

  test('body containing the literal </message> is not truncated', () => {
    const body = 'the body lives inside <message>...</message>'
    expect(parseIapEnvelope(wrap(body)).message).toBe(body)
  })

  test('body quoting a full envelope round-trips verbatim', () => {
    const body =
      'envelope shape: <iap from-personality="x"><message>hi</message></iap>; math a<b>c; html <br/>'
    expect(parseIapEnvelope(wrap(body)).message).toBe(body)
  })

  test('body containing the CDATA terminator ]]> survives escaping', () => {
    const body = 'tricky sequence ]]> inside the body'
    expect(parseIapEnvelope(wrap(body)).message).toBe(body)
  })

  test('extractIapEnvelopes splits a stream when a body contains </iap>', () => {
    const first = wrap('first body mentions </iap> mid-text')
    const second = wrap('second body')
    const { envelopes } = extractIapEnvelopes(`${first}${second}`)
    expect(envelopes).toEqual([first, second])
    expect(parseIapEnvelope(envelopes[0]).message).toBe('first body mentions </iap> mid-text')
    expect(parseIapEnvelope(envelopes[1]).message).toBe('second body')
  })

  test('attachments with a </iap>-bearing message still parse', () => {
    const envelope =
      '<iap from-personality="boris" from-runtime="claude" from-intelligence="artificial">\n' +
      '<attachments><![CDATA[/tmp/a.txt]]></attachments>\n' +
      '<message><![CDATA[see </iap> and </message> tags]]></message>\n</iap>'
    const parsed = parseIapEnvelope(envelope)
    expect(parsed.attachments).toEqual(['/tmp/a.txt'])
    expect(parsed.message).toBe('see </iap> and </message> tags')
  })
})
