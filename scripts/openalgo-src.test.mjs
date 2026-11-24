import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readOpenalgoFile, readRef } from './openalgo-src.mjs'

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
