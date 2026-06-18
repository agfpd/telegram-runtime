import { describe, expect, test } from 'bun:test'
import { isStopCommand } from '../src/cli.ts'

describe('isStopCommand — single-word stop CONTROL detection', () => {
  test('matches the exact one-word stop tokens (case-insensitive)', () => {
    for (const t of ['стоп', 'СТОП', 'Стоп', 'sToP', 'stop', 'STOP', 'Stop', '/stop']) {
      expect(isStopCommand(t)).toBe(true)
    }
  })

  test('tolerates surrounding whitespace and trailing !/./? punctuation', () => {
    for (const t of ['стоп ', ' стоп', '  стоп  ', '\nстоп\n', 'стоп!', 'стоп.', 'стоп?', 'стоп!!!', 'стоп ?!', 'stop.']) {
      expect(isStopCommand(t)).toBe(true)
    }
  })

  test('tolerates the @botname suffix on /stop (Telegram slash-command form)', () => {
    expect(isStopCommand('/stop@arthur_bot')).toBe(true)
  })

  // FLEET-SAFETY: these must NOT be classified as control — they are normal
  // messages and MUST flow through the unchanged envelope/delivery path.
  test('does NOT match multi-word phrases that merely start with stop', () => {
    for (const t of [
      'стоп подожди',
      'стоп!! что ты делаешь',
      'стоп, не надо',
      'stop it',
      'the /stop command',
      'стоп.подожди',
    ]) {
      expect(isStopCommand(t)).toBe(false)
    }
  })

  test('does NOT match near-misses, empties, or bare punctuation', () => {
    for (const t of ['стопэ', 'стопп', 'остановись', '/stopit', 'стоп,', '', '   ', '!', '.', '?']) {
      expect(isStopCommand(t)).toBe(false)
    }
  })
})
