import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scanExport } from './check-bundle-keys.mjs'

const HASH_A = 'ce76a3946102b2f69a501150f6cb6bad'
const HASH_B = '20e71bdf79e3a97bf55fd9e164041578'

/** An export dir: two assets named by their hash, metadata naming them, and `bundle` as JS. */
function exportDir(bundle) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-keys-'))
  mkdirSync(join(dir, 'assets'))
  mkdirSync(join(dir, '_expo/static/js/android'), { recursive: true })
  for (const h of [HASH_A, HASH_B]) writeFileSync(join(dir, 'assets', h), '0101'.repeat(40))
  writeFileSync(
    join(dir, 'metadata.json'),
    JSON.stringify({ fileMetadata: { android: { assets: [{ path: `assets/${HASH_A}` }] } } }),
  )
  writeFileSync(join(dir, '_expo/static/js/android/entry.hbc'), bundle)
  return dir
}

const key = () => randomBytes(32).toString('hex')

test('a key in a Hermes-style string table is found, though no separator follows it', () => {
  const k = key()
  // Hermes stores strings back to back: the key runs straight into "cfglobal", hex at the start
  const r = scanExport(exportDir(Buffer.from(`\u0000iVM[${k}cfglobalapikeyprint\u0000`, 'latin1')))
  assert.equal(r.length, 1)
  assert.match(r[0], /entry\.hbc: a run of 66 hex characters at byte \d+/)
  assert.ok(!r[0].includes(k.slice(0, 16)), 'the report never prints the key')
})

test('asset hashes back to back, and a key-length run in an asset, are not keys', () => {
  const dir = exportDir(`x${HASH_A}${HASH_B}${HASH_A}fe y`)
  assert.deepEqual(scanExport(dir), [])
})

test('a key next to an asset hash is still found', () => {
  assert.equal(scanExport(exportDir(`"${HASH_A}${key()}"`)).length, 1)
})

test('63 hex characters are not a key', () => {
  assert.deepEqual(scanExport(exportDir(`"${key().slice(1)}"`)), [])
})

test('the CLI exits 1 on a key, 0 on a clean export, 2 without a directory', () => {
  const cli = fileURLToPath(new URL('./check-bundle-keys.mjs', import.meta.url))
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  assert.equal(run(exportDir(`a${key()}b`)).status, 1)
  assert.equal(run(exportDir('clean')).status, 0)
  assert.equal(run().status, 2)
})

// The real thing: a key compiled by the repo's own hermesc, which gitleaks' rule misses.
const HERMESC = fileURLToPath(
  new URL(
    `../node_modules/hermes-compiler/hermesc/${process.platform === 'darwin' ? 'osx-bin' : 'linux64-bin'}/hermesc`,
    import.meta.url,
  ),
)
test('a key in a bundle compiled by hermesc is found', { skip: !existsSync(HERMESC) }, () => {
  const src = mkdtempSync(join(tmpdir(), 'bundle-keys-src-'))
  writeFileSync(join(src, 'in.js'), `var cfg = { apikey: '${key()}' }; print(cfg.apikey)\n`)
  const dir = exportDir('')
  const out = join(dir, '_expo/static/js/android/entry.hbc')
  const r = spawnSync(HERMESC, ['-emit-binary', '-out', out, join(src, 'in.js')])
  assert.equal(r.status, 0, String(r.stderr))
  assert.equal(scanExport(dir).length, 1)
})
