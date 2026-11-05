// Bundle the upstream leaf, never a handwritten fork. Run from any working directory.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dir, '..')
const source = 'node_modules/@agfpd/iapeer/src/identity/patchPeerProfile.ts'
const bundle = join(root, 'vendor/peer-profile.js')
const provenancePath = join(root, 'vendor/peer-profile.provenance.json')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pin: string = pkg.devDependencies['@agfpd/iapeer']
assert.ok(!pkg.dependencies['@agfpd/iapeer'], 'core must be build-only')
assert.ok(!pkg.bundleDependencies.includes('@agfpd/iapeer'), 'never bundle the core dependency graph')
const gitSha = /^git\+https:\/\/github.com\/agfpd\/iapeer.git#([a-f0-9]{40})$/.exec(pin)?.[1]
assert.ok(gitSha || /^\d+\.\d+\.\d+$/.test(pin), 'core devDependency must be an immutable SHA or exact registry version')
const previous = (() => {
  try { return JSON.parse(readFileSync(provenancePath, 'utf8')) } catch { return undefined }
})()
const coreCommit = gitSha ?? previous?.coreCommit
assert.match(coreCommit ?? '', /^[a-f0-9]{40}$/, 'registry build needs recorded upstream provenance')
const corePkg = JSON.parse(readFileSync(join(root, 'node_modules/@agfpd/iapeer/package.json'), 'utf8'))
if (!gitSha) assert.equal(corePkg.version, pin, 'installed core must match exact registry pin')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const temp = mkdtempSync(join(tmpdir(), 'tg-profile-vendor-'))
try {
  const output = join(temp, 'peer-profile.js')
  const run = Bun.spawnSync([process.execPath, 'build', source, '--target', 'bun', '--outfile', output], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
  })
  assert.equal(run.exitCode, 0, run.stderr.toString())
  const bytes = readFileSync(output)
  const upstream = await import(join(root, 'node_modules/@agfpd/iapeer/src/identity/patchPeerProfile.ts'))
  assert.equal(upstream.PEER_PROFILE_PATCH_PROTOCOL, 1, 'review declarations and migration before changing protocol')
  const provenance = JSON.stringify({
    package: '@agfpd/iapeer', version: corePkg.version, coreCommit,
    source: 'src/identity/patchPeerProfile.ts',
    sourceSha256: hash(readFileSync(join(root, source))),
    protocol: upstream.PEER_PROFILE_PATCH_PROTOCOL,
    bunVersion: Bun.version, bundleSha256: hash(bytes), license: 'Apache-2.0',
  }, null, 2) + '\n'
  if (process.argv.includes('--check')) {
    assert.deepEqual(readFileSync(bundle), bytes, 'vendor bundle drift: run bun run vendor:generate')
    assert.equal(readFileSync(provenancePath, 'utf8'), provenance, 'vendor provenance drift')
    console.log('core profile vendor: reproducible, protocol=1')
  } else {
    writeFileSync(bundle, bytes)
    writeFileSync(provenancePath, provenance)
  }
} finally { rmSync(temp, { recursive: true, force: true }) }
