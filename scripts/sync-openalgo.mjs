// Prints whether the pinned openalgo commit is available locally, fetching it once if needed.
// With --extract, also extracts its frontend source to ./openalgo (Metro, tsc and jest read it).
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureCommit, extractFrontend, readRef, repoDir } from './openalgo-src.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ref = readRef(root)
const repo = repoDir(root)
const ok = ensureCommit(repo, ref)
console.log(`openalgo.ref ${ref} — available in ${repo}: ${ok ? 'yes' : 'no'}`)
if (ok && process.argv.includes('--extract')) {
  extractFrontend({ repoRoot: root, ref, repo })
  console.log(`openalgo/ holds frontend/src at ${ref}`)
}
process.exit(ok ? 0 : 1)
