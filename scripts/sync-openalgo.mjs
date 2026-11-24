// Prints whether the pinned openalgo commit is available locally, fetching it once if needed.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureCommit, readRef, repoDir } from './openalgo-src.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ref = readRef(root)
const repo = repoDir(root)
const ok = ensureCommit(repo, ref)
console.log(`openalgo.ref ${ref} — available in ${repo}: ${ok ? 'yes' : 'no'}`)
process.exit(ok ? 0 : 1)
