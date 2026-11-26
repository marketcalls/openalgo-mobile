// Reads files from the pinned openalgo source (openalgo.ref) without touching its checkout.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SHA = /^[0-9a-f]{40}$/

const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })

export function readRef(repoRoot) {
  const ref = readFileSync(join(repoRoot, 'openalgo.ref'), 'utf8').trim()
  if (!SHA.test(ref))
    throw new Error(`openalgo.ref must be a 40-character commit SHA, got "${ref}"`)
  return ref
}

export function repoDir(repoRoot, env = process.env) {
  return resolve(env.OPENALGO_REPO ?? join(repoRoot, '..', 'openalgo'))
}

export function hasCommit(repo, ref) {
  try {
    git(repo, 'cat-file', '-e', `${ref}^{commit}`)
    return true
  } catch {
    return false
  }
}

// Make the pinned commit available in `repo`, fetching it once if it is missing.
export function ensureCommit(repo, ref) {
  if (hasCommit(repo, ref)) return true
  try {
    git(repo, 'fetch', '--quiet', 'origin', ref)
  } catch {
    return false
  }
  return hasCommit(repo, ref)
}

export function readOpenalgoFile(relPath, { repoRoot = process.cwd(), env = process.env } = {}) {
  const ref = readRef(repoRoot)
  if (env.OPENALGO_DIR) {
    const dir = resolve(env.OPENALGO_DIR)
    const head = git(dir, 'rev-parse', 'HEAD').trim()
    if (head !== ref) {
      throw new Error(`OPENALGO_DIR is at ${head}, openalgo.ref wants ${ref}`)
    }
    return readFileSync(join(dir, relPath), 'utf8')
  }
  const repo = repoDir(repoRoot, env)
  if (!ensureCommit(repo, ref)) {
    throw new Error(`openalgo commit ${ref} is not available in ${repo}`)
  }
  return git(repo, 'show', `${ref}:${relPath}`)
}
