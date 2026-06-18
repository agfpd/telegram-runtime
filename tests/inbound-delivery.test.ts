import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { iapDeliveryFailureVerdict, runIapSendCommand } from '../src/cli.ts'

const tmp = mkdtempSync(join(tmpdir(), 'telegram-inbound-delivery-'))
const argvFile = join(tmp, 'argv.txt')
const bodyFile = join(tmp, 'body.txt')

function writeStub(name: string, body: string): string {
  const path = join(tmp, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function captureArgsAndBody(): string {
  return (
    `printf '%s\\n' "$*" > ${JSON.stringify(argvFile)}\n` +
    `while [ "$#" -gt 0 ]; do\n` +
    `  if [ "$1" = "--message-file" ]; then shift; cat "$1" > ${JSON.stringify(bodyFile)}; fi\n` +
    `  shift || true\n` +
    `done\n`
  )
}

describe('Telegram → IAP delivery verdicts', () => {
  test('successful CLI delivery produces no operator verdict', async () => {
    const bin = writeStub(
      'iapeer-ok',
      captureArgsAndBody() + `printf '%s\\n' 'delivered to linus (codex)'\nexit 0`,
    )

    const result = await runIapSendCommand({
      bin,
      cwd: tmp,
      env: { ...process.env, PEER_IDENTITY: 'telegram-arthur' },
      targetPersonality: 'linus',
      message: 'hello from Telegram',
      attachments: ['/tmp/a.ogg'],
      timeoutMs: 1000,
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(argvFile, 'utf8').trim()).toMatch(
      /^send linus --message-file .+ --attachment \/tmp\/a\.ogg$/,
    )
    expect(readFileSync(bodyFile, 'utf8')).toBe('hello from Telegram')
    const verdicts: string[] = []
    if (!result.ok) verdicts.push(iapDeliveryFailureVerdict(result))
    expect(verdicts).toEqual([])
  })

  test('non-zero iapeer send failure maps to dry not-delivered verdict', async () => {
    const bin = writeStub(
      'iapeer-fail',
      captureArgsAndBody() +
        `printf '%s\\n' 'iapeer send: peer "linus" offline and wake failed: never-became-ready' 1>&2\nexit 1`,
    )

    const result = await runIapSendCommand({
      bin,
      cwd: tmp,
      env: process.env,
      targetPersonality: 'linus',
      message: 'wake up',
      attachments: [],
      timeoutMs: 1000,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(iapDeliveryFailureVerdict(result)).toBe(
        'not delivered: peer "linus" offline and wake failed: never-became-ready',
      )
    }
  })

  test('ok=false + err on stdout is treated as delivery failure even with exit 0', async () => {
    const bin = writeStub(
      'iapeer-ok-false',
      captureArgsAndBody() + `printf '%s\\n' 'ok=false err="never-became-ready"'\nexit 0`,
    )

    const result = await runIapSendCommand({
      bin,
      cwd: tmp,
      env: process.env,
      targetPersonality: 'linus',
      message: 'wake up',
      attachments: [],
      timeoutMs: 1000,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(iapDeliveryFailureVerdict(result)).toBe('not delivered: never-became-ready')
  })

  test('local send timeout is surfaced as not delivered', async () => {
    const bin = writeStub('iapeer-hangs', captureArgsAndBody() + `sleep 30\nexit 0`)

    const result = await runIapSendCommand({
      bin,
      cwd: tmp,
      env: process.env,
      targetPersonality: 'linus',
      message: 'wake up',
      attachments: [],
      timeoutMs: 100,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.timedOut).toBe(true)
      expect(iapDeliveryFailureVerdict(result)).toBe(
        'not delivered: delivery timed out after 1s — check the session',
      )
    }
  })
})

process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
