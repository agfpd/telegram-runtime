import { describe, expect, test } from 'bun:test'
import { pickTranscriptFile } from '../src/cli.ts'

describe('STT fallback transcript pick', () => {
  test('finds the mlx_whisper first-dot-truncated name', () => {
    expect(pickTranscriptFile(['voice.txt'], '/tmp/x/voice.2026.07.22.ogg')).toBe('voice.txt')
  })

  test('plain name still resolves', () => {
    expect(pickTranscriptFile(['voice.txt'], '/tmp/x/voice.ogg')).toBe('voice.txt')
  })

  test('prefers the exact drop-last-extension name when both exist', () => {
    expect(pickTranscriptFile(['voice.txt', 'voice.2.8.txt'], '/tmp/x/voice.2.8.ogg')).toBe(
      'voice.2.8.txt',
    )
  })

  test('falls back to the only txt whatever it is named', () => {
    expect(pickTranscriptFile(['out-42.txt'], '/tmp/x/voice.ogg')).toBe('out-42.txt')
  })

  test('ignores non-txt output and reports nothing when no transcript', () => {
    expect(pickTranscriptFile(['voice.srt', 'voice.json'], '/tmp/x/voice.ogg')).toBeUndefined()
    expect(pickTranscriptFile([], '/tmp/x/voice.ogg')).toBeUndefined()
  })
})
