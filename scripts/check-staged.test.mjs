import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const script = resolve('scripts/check-staged.mjs')
const KEY = 'a1b2c3d4'.repeat(8)

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'staged-'))
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  writeFileSync(join(dir, '.env.test.local'), `OPENALGO_TEST_APIKEY=${KEY}\n`)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return {
    dir,
    stage: (...names) => git('add', '-f', ...names),
    run: () => spawnSync('node', [script], { cwd: dir, encoding: 'utf8' }),
  }
}

test('staging .env.test.local is refused', () => {
  const r = repo({})
  r.stage('.env.test.local')
  const out = r.run()
  assert.equal(out.status, 1)
  assert.match(out.stderr, /refusing to commit \.env\.test\.local/)
})

test('content holding the local test key is refused', () => {
  const r = repo({ 'notes.txt': `the key is ${KEY} ok\n` })
  r.stage('notes.txt')
  const out = r.run()
  assert.equal(out.status, 1)
  assert.match(out.stderr, /notes\.txt/)
  assert.doesNotMatch(out.stderr, new RegExp(KEY))
})

test('.env.test.example is allowed', () => {
  const r = repo({ '.env.test.example': 'OPENALGO_TEST_URL=\nOPENALGO_TEST_APIKEY=\n' })
  r.stage('.env.test.example')
  assert.equal(r.run().status, 0)
})
