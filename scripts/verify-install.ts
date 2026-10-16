// Real native install proof shipped in the npm archive. No checkout, npm cache,
// network, IAP daemon, Telegram credentials or foundation/helper needed.
import { strict as assert } from 'assert'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

assert.equal(process.platform, 'darwin', 'native signature proof requires macOS')
const args = process.argv.slice(2)
const outputAt = args.indexOf('--output')
assert.ok(outputAt >= 0 && args[outputAt + 1], 'usage: bun package/scripts/verify-install.ts --output <new-directory> [--host-home <home>]')
const output = resolve(args[outputAt + 1]!)
assert.ok(!existsSync(output), 'output directory must be NEW; nothing existing is overwritten')
const hostAt = args.indexOf('--host-home')
assert.ok(hostAt < 0 || args[hostAt + 1], '--host-home requires an absolute home path')
const hostHome = hostAt >= 0 ? resolve(args[hostAt + 1]!) : undefined
if (hostHome) for (const dir of ['.local/bin', '.iapeer/docs', '.iapeer/runtimes', 'Library/LaunchAgents']) {
  const protectedDir = join(hostHome, dir)
  assert.ok(output !== protectedDir && !output.startsWith(protectedDir + '/'), 'output must be outside protected host directories')
}
mkdirSync(output, { recursive: true, mode: 0o700 })
const pkg = resolve(import.meta.dir, '..')
assert.ok(existsSync(join(pkg, 'node_modules/grammy/package.json')), 'archive must contain bundled runtime dependencies')
const { selfInstall } = await import(join(pkg, 'src/selfInstall.ts')) as typeof import('../src/selfInstall.ts')
const { runInstallCommand } = await import(join(pkg, 'src/installSignature.ts')) as typeof import('../src/installSignature.ts')
const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version as string
const sandbox = mkdtempSync(join(tmpdir(), 'telegram-artifact-proof-'))
// Allowlist, NOT inherited environment: no host identity, credentials, discovery,
// NODE_PATH, package registry or Telegram endpoint overrides reach any child.
const env: NodeJS.ProcessEnv = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: join(sandbox, 'home'), TMPDIR: sandbox,
  IAPEER_ROOT: join(sandbox, 'root'), IAPEER_BIN_DIR: join(sandbox, 'bin'),
  IAPEER_TEST_SANDBOX: '1', IAP_BIN: '/usr/bin/false',
}
const bin = join(env.IAPEER_BIN_DIR!, 'telegram-runtime')
const manifest = join(env.IAPEER_ROOT!, 'runtimes/telegram/runtime.json')
const docs = join(env.IAPEER_ROOT!, 'docs/telegram-runtime')
mkdirSync(env.HOME!, { recursive: true })
const backup = join(output, 'backup')
mkdirSync(backup)
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
function tree(path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  function walk(p: string, rel: string) {
    const st = lstatSync(p)
    assert.ok(st.isFile() || st.isDirectory(), `unexpected symlink/non-file: ${p}`)
    out[rel] = { kind: st.isDirectory() ? 'directory' : 'file', mode: st.mode & 0o777,
      ...(st.isFile() ? { sha256: hash(p), size: st.size } : {}) }
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n), rel ? `${rel}/${n}` : n)
  }
  walk(path, '')
  return out
}
function copy(source: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(source, dest, { recursive: true, preserveTimestamps: true })
  chmodSync(dest, statSync(source).mode & 0o777)
  assert.deepEqual(tree(dest), tree(source))
}
const events: Record<string, unknown>[] = []
function record(event: string, fields: Record<string, unknown> = {}): void {
  const entry = { ts: new Date().toISOString(), event, ...fields }
  events.push(entry)
  console.log(JSON.stringify(entry))
  writeFileSync(join(output, 'events.json'), JSON.stringify(events, null, 2) + '\n')
}
function command(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: env.HOME, env, encoding: 'utf8', timeout: 120_000 })
  assert.ifError(r.error)
  record('command', { command: cmd, args, status: r.status, signal: r.signal, stderr: r.stderr })
  return r
}
function success(cmd: string, args: string[]): string {
  const r = command(cmd, args)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.signal, null)
  return r.stdout
}
function verify(path = bin): void { success('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]) }
function executable(): void { assert.match(success(bin, ['--help']), /self-install/) }
function state() { return { bin: tree(bin), manifest: tree(manifest), docs: tree(docs) } }
function cleanStages(): void {
  assert.deepEqual(readdirSync(env.IAPEER_BIN_DIR!), ['telegram-runtime'])
  assert.deepEqual(readdirSync(dirname(manifest)), ['runtime.json'])
}
function protectedState(home: string) {
  const files: Record<string, unknown> = {}
  function add(path: string) {
    if (!existsSync(path)) return
    const st = lstatSync(path)
    if (st.isDirectory()) { for (const n of readdirSync(path).sort()) add(join(path, n)); return }
    assert.ok(st.isFile(), `protected surface is not a regular file: ${path}`)
    files[path] = { sha256: hash(path), mode: st.mode & 0o777, inode: st.ino, mtimeMs: st.mtimeMs, size: st.size }
  }
  for (const path of ['.iapeer/docs', '.npmrc', '.codex/config.toml', '.claude/settings.json',
    'Peers/arthur/.iapeer/peer-profile.json', '.iapeer/peers-profiles.json']) add(join(home, path))
  const runtimes = join(home, '.iapeer/runtimes')
  if (existsSync(runtimes)) for (const name of readdirSync(runtimes)) add(join(runtimes, name, 'runtime.json'))
  for (const n of ['iapeer', 'telegram-runtime', 'web-runtime', 'notifier-runtime', 'voicetalk-runtime']) add(join(home, '.local/bin', n))
  const launch = join(home, 'Library/LaunchAgents')
  if (existsSync(launch)) for (const n of readdirSync(launch).filter(n => n.startsWith('com.iapeer.'))) add(join(launch, n))
  const ps = spawnSync('/bin/ps', ['-Ao', 'pid,ppid,lstart,comm'], { encoding: 'utf8' })
  assert.equal(ps.status, 0)
  const rows = ps.stdout.split('\n').map(line => ({ line, fields: line.trim().split(/\s+/) }))
  const pids = new Set<string>()
  for (const row of rows) if (/\/.local\/bin\/(telegram-runtime|web-runtime|notifier-runtime|voicetalk-runtime|iapeer-memory)$/.test(row.line)) {
    let current: typeof row | undefined = row
    while (current && current.fields[0] !== '1' && !pids.has(current.fields[0]!)) {
      pids.add(current.fields[0]!)
      const parent: string = current.fields[1]!
      current = rows.find(r => r.fields[0] === parent)
    }
  }
  return { files, processes: rows.filter(r => pids.has(r.fields[0]!)).map(r => r.line) }
}
const receipt: Record<string, unknown> = {
  version, reserveKind: hostHome ? 'current-host-readonly-copy' : 'candidate-only-not-host-recovery',
  bun: Bun.version, platform: process.platform, arch: process.arch, package: pkg,
  boundaries: 'Native installation, signature and CLI execution only. No Telegram, HTTP, IAP, polling, launchd or host activation proof.',
}
let before: ReturnType<typeof protectedState> | undefined
try {
  if (hostHome) {
    before = protectedState(hostHome)
    writeFileSync(join(output, 'host-before.json'), JSON.stringify(before, null, 2) + '\n')
    const oldBin = join(hostHome, '.local/bin/telegram-runtime')
    const oldManifest = join(hostHome, '.iapeer/runtimes/telegram/runtime.json')
    const oldDocs = join(hostHome, '.iapeer/docs/telegram-runtime')
    verify(oldBin) // verify-only: never re-sign the live source or its backup
    assert.equal(JSON.parse(readFileSync(oldManifest, 'utf8')).runtime, 'telegram')
    copy(oldBin, join(backup, 'telegram-runtime'))
    copy(oldManifest, join(backup, 'runtime.json'))
    copy(oldDocs, join(backup, 'docs'))
    const plist = ['com.iapeer.arthur.telegram.plist', 'com.iapeer.arthur.plist']
      .map(name => join(hostHome, 'Library/LaunchAgents', name)).find(path => existsSync(path))
    if (plist) copy(plist, join(backup, 'launchd-reference.plist'))
    verify(join(backup, 'telegram-runtime'))
    copy(join(backup, 'telegram-runtime'), bin)
    copy(join(backup, 'runtime.json'), manifest)
    copy(join(backup, 'docs'), docs)
    verify(); executable()
    receipt.backup = { version: JSON.parse(readFileSync(manifest, 'utf8')).version, state: state(), plistSource: plist }
    record('current-reserve-verified-and-executed', { version: (receipt.backup as { version: string }).version })
  }

  // Actual bare npx contract and explicit CLI use the package's normal entry point.
  const entry = join(pkg, 'bin/telegram-runtime')
  assert.ok(statSync(entry).mode & 0o111, 'shipped native entry must be executable')
  assert.match(success(entry, []), /\(compiled\)/)
  verify(); executable()
  assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).version, version)
  const manifestHash = hash(manifest)
  assert.match(success(entry, ['self-install']), /\(compiled\)/)
  verify(); executable(); assert.equal(hash(manifest), manifestHash)
  assert.deepEqual(tree(docs), tree(join(pkg, 'docs')))
  if (!hostHome) {
    copy(bin, join(backup, 'telegram-runtime'))
    copy(manifest, join(backup, 'runtime.json'))
    copy(docs, join(backup, 'docs'))
    receipt.backup = { version, state: state() }
  }
  record('native-cli-install-and-idempotent-update-pass', { version, state: state() })

  const validHash = hash(bin)
  assert.match(success(bin, ['self-install']), /\(copied-self\)/)
  verify(); executable(); assert.equal(hash(bin), validHash)
  record('native-copy-self-pass', { bytesAndSignatureUnchanged: true })

  const unsigned = join(sandbox, 'unsigned-runtime')
  copyFileSync(bin, unsigned)
  success('/usr/bin/codesign', ['--remove-signature', unsigned])
  assert.notEqual(command('/usr/bin/codesign', ['--verify', '--deep', '--strict', unsigned]).status, 0)
  selfInstall({ env, sourceEntry: join(sandbox, 'missing.ts'), execPath: unsigned })
  verify(); executable(); cleanStages()
  record('real-unsigned-copy-repaired-pass')

  // Observing the real runner is NOT a mock: commands/results are unchanged.
  const run: typeof runInstallCommand = (cmd, args, childEnv) => {
    const r = runInstallCommand(cmd, args, childEnv)
    record('real-install-command', { command: cmd, args, status: r.status, signal: r.signal, stderr: r.stderr })
    return r
  }
  const bad = join(sandbox, 'truncated-mach-o')
  writeFileSync(bad, readFileSync(bin).subarray(0, 1024))
  assert.notEqual(command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bad]).status, 0)
  const previous = state()
  assert.throws(() => selfInstall({ env, sourceEntry: join(sandbox, 'missing.ts'), execPath: bad, run }), /codesign .* failed/)
  assert.deepEqual(state(), previous); verify(); executable(); cleanStages()
  record('real-codesign-refusal-preserves-pair-and-docs-pass', { preserved: previous })

  const minimal = join(sandbox, 'minimal.ts')
  const marker = 'telegram minimal native proof'
  writeFileSync(minimal, `console.log(${JSON.stringify(marker)})\n`)
  let failure: unknown
  try { selfInstall({ env, sourceEntry: minimal, execPath: process.execPath, run }) } catch (e) { failure = e }
  if (failure) {
    assert.match(String(failure), /codesign .* failed/)
    assert.deepEqual(state(), previous); verify(); executable()
    record('real-minimal-compile-refused-preserves-pair-pass', { error: String(failure) })
  } else {
    verify(); assert.equal(success(bin, []).trim(), marker)
    record('real-minimal-compile-accepted-only-after-verification-and-execution')
    success(entry, ['self-install'])
  }
  cleanStages()

  // A real filesystem refusal, not a fake codesign or mocked file operation.
  const obstruction = join(sandbox, 'not-a-root')
  writeFileSync(obstruction, 'obstruction')
  const preIO = state()
  assert.throws(() => selfInstall({ env: { ...env, IAPEER_ROOT: obstruction }, sourceEntry: join(pkg, 'src/cli.ts') }), /ENOTDIR/)
  assert.deepEqual(state(), preIO); verify(); executable(); cleanStages()
  record('real-manifest-staging-refusal-preserves-pair-pass')

  // Rehearse restoration from the ACTUAL current reserve when --host-home is given.
  // Validate ALL staged bytes/modes and old signature BEFORE the first rename.
  const restoreBin = `${bin}.restore`
  const restoreManifest = `${manifest}.restore`
  const restoreDocs = `${docs}.restore`
  copy(join(backup, 'telegram-runtime'), restoreBin)
  copy(join(backup, 'runtime.json'), restoreManifest)
  copy(join(backup, 'docs'), restoreDocs)
  verify(restoreBin)
  renameSync(restoreBin, bin)
  renameSync(restoreManifest, manifest)
  renameSync(docs, `${docs}.previous`)
  renameSync(restoreDocs, docs)
  rmSync(`${docs}.previous`, { recursive: true })
  const expected = (receipt.backup as { state: ReturnType<typeof state> }).state
  assert.deepEqual(state(), expected); verify(); executable(); cleanStages()
  record('isolated-reserve-restoration-pass', { kind: receipt.reserveKind, restored: state() })
  receipt.ok = true
} catch (error) {
  receipt.ok = false
  receipt.error = String(error)
  throw error
} finally {
  rmSync(sandbox, { recursive: true, force: true })
  try {
    if (hostHome && before) {
      const after = protectedState(hostHome)
      writeFileSync(join(output, 'host-after.json'), JSON.stringify(after, null, 2) + '\n')
      receipt.hostProtectedFileCount = Object.keys(before.files).length
      receipt.hostUnchanged = JSON.stringify(before) === JSON.stringify(after)
      if (!receipt.hostUnchanged) receipt.ok = false
      assert.deepEqual(after, before, 'protected host files/processes changed during proof')
    }
  } finally {
    receipt.sandboxRemoved = !existsSync(sandbox)
    writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
}
record('proof-pass', { version, output, reserveKind: receipt.reserveKind })
