// Reads files from the pinned openalgo source (openalgo.ref) without touching its checkout, and
// extracts the web frontend to ./openalgo, where Metro, tsc and jest resolve `@/`.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

// The entry names (files and folders) directly under `rel` at the pinned ref.
export function listOpenalgoDir(rel, { repoRoot = process.cwd(), env = process.env } = {}) {
  const dir = rel.replace(/\/+$/, '')
  const ref = readRef(repoRoot)
  if (env.OPENALGO_DIR) {
    const root = resolve(env.OPENALGO_DIR)
    const head = git(root, 'rev-parse', 'HEAD').trim()
    if (head !== ref) throw new Error(`OPENALGO_DIR is at ${head}, openalgo.ref wants ${ref}`)
    return readdirSync(join(root, dir)).sort()
  }
  const repo = repoDir(repoRoot, env)
  if (!ensureCommit(repo, ref)) {
    throw new Error(`openalgo commit ${ref} is not available in ${repo}`)
  }
  return git(repo, 'ls-tree', '--name-only', ref, `${dir}/`)
    .split('\n')
    .filter(Boolean)
    .map((p) => p.slice(dir.length + 1))
    .sort()
}

// What ./openalgo holds: the frontend source and its lockfile (the DOM packages' versions).
const FRONTEND_PATHS = ['frontend/src', 'frontend/package-lock.json']

// Extract the frontend at `ref` from `repo` into <repoRoot>/openalgo, replacing an earlier
// extract, and record the commit in openalgo/.ref. A git checkout there (CI's) is left alone.
export function extractFrontend({ repoRoot, ref, repo }) {
  const dest = join(repoRoot, 'openalgo')
  if (existsSync(join(dest, '.git'))) {
    throw new Error(`openalgo/ is a git checkout: check out ${ref} there instead of extracting`)
  }
  if (!ensureCommit(repo, ref)) {
    throw new Error(`openalgo commit ${ref} is not available in ${repo}`)
  }
  const tar = execFileSync('git', ['-C', repo, 'archive', '--format=tar', ref, ...FRONTEND_PATHS], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  })
  // staged in the git-ignored .cache/ and moved into place whole
  const cache = join(repoRoot, '.cache')
  mkdirSync(cache, { recursive: true })
  const staging = mkdtempSync(join(cache, 'openalgo-frontend-'))
  try {
    execFileSync('tar', ['-x', '-f', '-', '-C', staging], {
      input: tar,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    writeFileSync(join(staging, '.ref'), `${ref}\n`)
    // mkdtemp made it owner-only; the extract is an ordinary folder
    chmodSync(staging, 0o755)
    rmSync(dest, { recursive: true, force: true })
    renameSync(staging, dest)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

// Whether <repoRoot>/openalgo holds the frontend at openalgo.ref: an extract's .ref, or the
// HEAD of a git checkout (CI checks the frontend out there).
export function frontendDirOk(repoRoot) {
  const ref = readRef(repoRoot)
  const dir = join(repoRoot, 'openalgo')
  if (!existsSync(dir)) return { ok: false, reason: 'openalgo/ is missing' }
  let at
  if (existsSync(join(dir, '.ref'))) {
    at = readFileSync(join(dir, '.ref'), 'utf8').trim()
    if (at !== ref) return { ok: false, reason: `openalgo/ holds ${at}, openalgo.ref wants ${ref}` }
  } else if (existsSync(join(dir, '.git'))) {
    at = git(dir, 'rev-parse', 'HEAD').trim()
    if (at !== ref) {
      return { ok: false, reason: `openalgo/ is checked out at ${at}, openalgo.ref wants ${ref}` }
    }
  } else {
    return { ok: false, reason: 'openalgo/ has no .ref and is not a git checkout' }
  }
  if (!existsSync(join(dir, 'frontend', 'src'))) {
    return { ok: false, reason: 'openalgo/frontend/src is missing' }
  }
  return { ok: true }
}
