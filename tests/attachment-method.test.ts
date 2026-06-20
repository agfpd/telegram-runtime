import { describe, expect, test } from 'bun:test'
import { selectSendMethod } from '../src/cli.ts'

describe('selectSendMethod — outbound attachment routing by extension', () => {
  test('.ogg / .oga (opus) → sendVoice', () => {
    expect(selectSendMethod('.ogg')).toEqual({ method: 'sendVoice', field: 'voice' })
    expect(selectSendMethod('.oga')).toEqual({ method: 'sendVoice', field: 'voice' })
  })

  test('compressed/lossless audio → sendAudio', () => {
    for (const ext of ['.mp3', '.m4a', '.wav', '.aac', '.flac']) {
      expect(selectSendMethod(ext)).toEqual({ method: 'sendAudio', field: 'audio' })
    }
  })

  test('.gif → sendAnimation (NOT sendPhoto — Telegram rejects GIF-as-photo)', () => {
    expect(selectSendMethod('.gif')).toEqual({ method: 'sendAnimation', field: 'animation' })
  })

  test('static images stay sendPhoto (no regression)', () => {
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      expect(selectSendMethod(ext)).toEqual({ method: 'sendPhoto', field: 'photo' })
    }
  })

  test('everything else falls back to sendDocument (no regression)', () => {
    for (const ext of ['.pdf', '.txt', '.zip', '.docx', '']) {
      expect(selectSendMethod(ext)).toEqual({ method: 'sendDocument', field: 'document' })
    }
  })
})
