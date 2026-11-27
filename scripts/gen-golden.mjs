// Regenerates test/golden/expected from test/golden/inputs by running the server's own Python
// (design 9.2): npm run gen-golden [-- --server <dir>] [--dry-run]
// Without --server, the server at openalgo.ref is extracted once to .cache/openalgo-server-<ref>
// with git archive. Its frontend is left out: no Python reads it, and its *.test.tsx files
// would join the app's jest run. Then the server's own uv.lock is synced and the harness runs
// in that environment on uv's own CPython 3.12, the interpreter CI regenerates with too.
// --dry-run prints the commands.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ensureCommit, readRef, repoDir } from './openalgo-src.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HARNESS = join(ROOT, 'scripts/golden/harness.py')
const INPUTS = join(ROOT, 'test/golden/inputs')
const EXPECTED = join(ROOT, 'test/golden/expected')
const PYTHON = '3.12'
const ARCHIVE_PATHS = ['--', '.', ':(exclude)frontend']

function fail(message) {
  console.error(`gen-golden: ${message}`)
  process.exit(1)
}

let values
try {
  ;({ values } = parseArgs({
    options: { server: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  }))
} catch (e) {
  fail(`${e.message}\nusage: gen-golden [--server <dir>] [--dry-run]`)
}
const dryRun = values['dry-run'] === true

let server
if (values.server) {
  server = resolve(values.server)
} else {
  const ref = readRef(ROOT)
  const repo = repoDir(ROOT)
  server = join(ROOT, '.cache', `openalgo-server-${ref}`)
  const archive = ['-C', repo, 'archive', '--format=tar', ref, ...ARCHIVE_PATHS]
  const marker = join(server, '.ref')
  const extracted = existsSync(marker) && readFileSync(marker, 'utf8').trim() === ref
  if (dryRun) {
    console.log(
      `git ${archive.join(' ')} | tar -x -C ${server}${extracted ? '  (already extracted)' : ''}`,
    )
  } else if (!extracted) {
    if (!ensureCommit(repo, ref)) fail(`openalgo commit ${ref} is not available in ${repo}`)
    const tar = execFileSync('git', archive, {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 512 * 1024 * 1024,
    })
    // staged beside the target and moved into place whole
    mkdirSync(join(ROOT, '.cache'), { recursive: true })
    const staging = mkdtempSync(join(ROOT, '.cache', 'openalgo-server-'))
    try {
      execFileSync('tar', ['-x', '-f', '-', '-C', staging], {
        input: tar,
        stdio: ['pipe', 'ignore', 'pipe'],
      })
      writeFileSync(join(staging, '.ref'), `${ref}\n`)
      rmSync(server, { recursive: true, force: true })
      renameSync(staging, server)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
}

const uv = (...args) => [...args, '--project', server, '--python', PYTHON, '--managed-python']
const commands = [
  uv('sync', '--frozen', '--no-dev'),
  [
    ...uv('run', '--frozen', '--no-sync'),
    'python',
    HARNESS,
    '--server',
    server,
    '--in',
    INPUTS,
    '--out',
    EXPECTED,
  ],
]
for (const args of commands) {
  if (dryRun) {
    console.log(`uv ${args.join(' ')}`)
    continue
  }
  try {
    execFileSync('uv', args, { cwd: ROOT, stdio: 'inherit' })
  } catch (e) {
    fail(e.code === 'ENOENT' ? 'uv is not installed (CI uses uv 0.11.3)' : `uv ${args[0]} failed`)
  }
}
