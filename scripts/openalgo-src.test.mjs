import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  extractFrontend,
  frontendDirOk,
  listOpenalgoDir,
  readOpenalgoFile,
  readRef,
} from './openalgo-src.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

// A throwaway server repo with commit A (file = "a") then B (file = "b"), and a repo root
// whose openalgo.ref is set to `ref`.
function fixture(ref) {
  const base = mkdtempSync(join(tmpdir(), 'oa-src-'))
  const server = join(base, 'server')
  mkdirSync(server)
  git(server, 'init', '-q')
  git(server, 'config', 'user.email', 't@t')
  git(server, 'config', 'user.name', 't')
  writeFileSync(join(server, 'f.txt'), 'a')
  git(server, 'add', '.')
  git(server, 'commit', '-qm', 'A')
  const a = git(server, 'rev-parse', 'HEAD')
  writeFileSync(join(server, 'f.txt'), 'b')
  git(server, 'commit', '-qam', 'B')
  const root = join(base, 'app')
  mkdirSync(root)
  writeFileSync(join(root, 'openalgo.ref'), `${ref === 'A' ? a : ref}\n`)
  return { server, root, a }
}

test('OPENALGO_REPO reads the pinned ref and leaves HEAD alone', () => {
  const { server, root, a } = fixture('A')
  assert.equal(readRef(root), a)
  const env = { OPENALGO_REPO: server }
  assert.equal(readOpenalgoFile('f.txt', { repoRoot: root, env }), 'a')
  assert.notEqual(git(server, 'rev-parse', 'HEAD'), a)
  assert.equal(git(server, 'show', 'HEAD:f.txt'), 'b')
})

test('OPENALGO_DIR at a different commit than the ref throws', () => {
  const { server, root } = fixture('A')
  const env = { OPENALGO_DIR: server }
  assert.throws(
    () => readOpenalgoFile('f.txt', { repoRoot: root, env }),
    /OPENALGO_DIR is at .* openalgo.ref wants/,
  )
})

test('OPENALGO_DIR at the ref reads the working file', () => {
  const { server, root } = fixture('A')
  git(server, 'checkout', '-q', 'HEAD~1')
  const env = { OPENALGO_DIR: server }
  assert.equal(readOpenalgoFile('f.txt', { repoRoot: root, env }), 'a')
})

test('a non-SHA ref is refused', () => {
  const { root } = fixture('main')
  assert.throws(() => readRef(root), /40-character commit SHA/)
})

// A server repo with a frontend: commit A (x.ts = "a") then B (x.ts = "b", plus only-b.ts), each
// with server code and frontend files beside src/. The app root's openalgo.ref is A.
function frontendFixture() {
  const base = mkdtempSync(join(tmpdir(), 'oa-fe-'))
  const server = join(base, 'server')
  mkdirSync(join(server, 'frontend', 'src', 'lib'), { recursive: true })
  git(server, 'init', '-q')
  git(server, 'config', 'user.email', 't@t')
  git(server, 'config', 'user.name', 't')
  writeFileSync(join(server, 'app.py'), '')
  writeFileSync(join(server, 'frontend', 'package.json'), '{}')
  writeFileSync(join(server, 'frontend', 'package-lock.json'), '{"lockfileVersion":3}')
  writeFileSync(join(server, 'frontend', 'src', 'lib', 'x.ts'), 'a')
  git(server, 'add', '.')
  git(server, 'commit', '-qm', 'A')
  const a = git(server, 'rev-parse', 'HEAD')
  writeFileSync(join(server, 'frontend', 'src', 'lib', 'x.ts'), 'b')
  writeFileSync(join(server, 'frontend', 'src', 'lib', 'only-b.ts'), 'b')
  git(server, 'add', '.')
  git(server, 'commit', '-qm', 'B')
  const b = git(server, 'rev-parse', 'HEAD')
  const root = join(base, 'app')
  mkdirSync(root)
  writeFileSync(join(root, 'openalgo.ref'), `${a}\n`)
  return { server, root, a, b, dir: join(root, 'openalgo') }
}

test('extractFrontend writes frontend/src at the ref and frontendDirOk accepts it; another .ref is refused', () => {
  const { server, root, a, b, dir } = frontendFixture()
  assert.deepEqual(frontendDirOk(root), { ok: false, reason: 'openalgo/ is missing' })
  extractFrontend({ repoRoot: root, ref: b, repo: server })
  // a second extract replaces the first: nothing of B is left
  extractFrontend({ repoRoot: root, ref: a, repo: server })
  assert.equal(readFileSync(join(dir, 'frontend', 'src', 'lib', 'x.ts'), 'utf8'), 'a')
  assert.equal(existsSync(join(dir, 'frontend', 'src', 'lib', 'only-b.ts')), false)
  assert.equal(
    readFileSync(join(dir, 'frontend', 'package-lock.json'), 'utf8'),
    '{"lockfileVersion":3}',
  )
  // only frontend/src and the lockfile
  assert.equal(existsSync(join(dir, 'frontend', 'package.json')), false)
  assert.equal(existsSync(join(dir, 'app.py')), false)
  assert.equal(readFileSync(join(dir, '.ref'), 'utf8'), `${a}\n`)
  assert.deepEqual(frontendDirOk(root), { ok: true })

  writeFileSync(join(dir, '.ref'), `${b}\n`)
  assert.deepEqual(frontendDirOk(root), {
    ok: false,
    reason: `openalgo/ holds ${b}, openalgo.ref wants ${a}`,
  })
})

test('frontendDirOk accepts a git checkout at the ref (as CI has), and extractFrontend leaves it alone', () => {
  const { server, root, a, b, dir } = frontendFixture()
  execFileSync('git', ['clone', '-q', server, dir])
  assert.deepEqual(frontendDirOk(root), {
    ok: false,
    reason: `openalgo/ is checked out at ${b}, openalgo.ref wants ${a}`,
  })
  git(dir, 'checkout', '-q', a)
  assert.deepEqual(frontendDirOk(root), { ok: true })
  assert.throws(
    () => extractFrontend({ repoRoot: root, ref: a, repo: server }),
    /openalgo\/ is a git checkout/,
  )
  assert.equal(readFileSync(join(dir, 'app.py'), 'utf8'), '')
})

test('extractFrontend refuses a commit the server repo does not have', () => {
  const { server, root } = frontendFixture()
  const missing = 'f'.repeat(40)
  assert.throws(
    () => extractFrontend({ repoRoot: root, ref: missing, repo: server }),
    new RegExp(`openalgo commit ${missing} is not available in`),
  )
  assert.equal(existsSync(join(root, 'openalgo')), false)
})

test('listOpenalgoDir lists a folder at the ref from git and from OPENALGO_DIR', () => {
  const { server, root } = frontendFixture()
  // the fixture's ref is A: only-b.ts exists at B alone
  assert.deepEqual(
    listOpenalgoDir('frontend/src/lib', { repoRoot: root, env: { OPENALGO_REPO: server } }),
    ['x.ts'],
  )
  assert.deepEqual(
    listOpenalgoDir('frontend/src/lib/', { repoRoot: root, env: { OPENALGO_REPO: server } }),
    ['x.ts'],
  )
  git(server, 'checkout', '-q', 'HEAD~1')
  assert.deepEqual(
    listOpenalgoDir('frontend/src/lib', { repoRoot: root, env: { OPENALGO_DIR: server } }),
    ['x.ts'],
  )
})
