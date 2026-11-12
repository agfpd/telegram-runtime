import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLineTail, createOpencodeJournalParser } from '../src/cli'

// iapeer 0.4.169: OpenCode events.jsonl rotates by rename to events.jsonl.1.
const withDir = (fn: (p: string) => void) => {
  const d = mkdtempSync(join(tmpdir(), 'tail-'))
  try {
    fn(join(d, 'events.jsonl'))
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}
const ln = (seq: number) => JSON.stringify({ schema: 1, seq }) + '\n'
const seqs = (lines: string[]) => lines.filter((l) => l.trim()).map((l) => JSON.parse(l).seq)

describe('createLineTail', () => {
  test('starts at EOF, reads appended complete lines, keeps a partial for later', () => withDir((p) => {
    writeFileSync(p, ln(1))
    const t = createLineTail(p)!
    appendFileSync(p, ln(2) + '{"schema":1,"se')
    expect(seqs(t.poll())).toEqual([2])
    appendFileSync(p, 'q":3}\n')
    expect(seqs(t.poll())).toEqual([3])
  }))

  test('rotation where the new file already outgrew the old offset: drains .1 tail, reads new file from 0', () => withDir((p) => {
    writeFileSync(p, ln(1))
    const t = createLineTail(p)!
    appendFileSync(p, ln(2))
    renameSync(p, p + '.1')
    writeFileSync(p, ln(3) + ln(4) + ln(5) + ln(6)) // larger than the old offset
    expect(seqs(t.poll())).toEqual([2, 3, 4, 5, 6])
    appendFileSync(p, ln(7))
    expect(seqs(t.poll())).toEqual([7])
  }))

  test('rotation to a smaller new file is handled the same way', () => withDir((p) => {
    writeFileSync(p, ln(1) + ln(2) + ln(3))
    const t = createLineTail(p)!
    renameSync(p, p + '.1')
    writeFileSync(p, ln(4))
    expect(seqs(t.poll())).toEqual([4])
  }))

  test('in-place truncation restarts at 0; parser seq-dedup drops the replay', () => withDir((p) => {
    const toolLn = (seq: number, id: string) => JSON.stringify({
      schema: 1, seq, type: 'message.part.updated',
      properties: { part: { id, type: 'tool', tool: 'bash', state: { status: 'running', input: { description: id } } } },
    }) + '\n'
    writeFileSync(p, toolLn(1, 'a') + toolLn(2, 'b'))
    const t = createLineTail(p, true)!
    const parser = createOpencodeJournalParser()
    const run = (lines: string[]) => lines.filter((l) => l.trim()).flatMap((l) => parser.events(JSON.parse(l)))
    expect(run(t.poll()).map((e) => e.label)).toEqual(['a', 'b'])
    writeFileSync(p, toolLn(2, 'b-replayed')) // shrinks in place, replays seq 2
    expect(run(t.poll())).toEqual([])
    appendFileSync(p, toolLn(3, 'c'))
    expect(run(t.poll()).map((e) => e.label)).toEqual(['c'])
  }))

  test('missing file → null', () => withDir((p) => {
    expect(createLineTail(p)).toBeNull()
  }))
})
