// Pre-commit guard: refuse a staged .env.test.local and any staged content that holds the
// local test API key. Reports file names only, never the key.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

const git = (args, opts = {}) => execFileSync('git', args, { maxBuffer: 1 << 28, ...opts })

function localKey() {
  const fromEnv = process.env.OPENALGO_TEST_APIKEY?.trim()
  if (fromEnv) return fromEnv
  if (!existsSync('.env.test.local')) return ''
  const m = readFileSync('.env.test.local', 'utf8').match(/^\s*OPENALGO_TEST_APIKEY\s*=\s*(\S+)/m)
  return m?.[1]?.replace(/^["']|["']$/g, '') ?? ''
}

const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)

const key = localKey()
let failed = false
for (const file of staged) {
  if (basename(file) === '.env.test.local') {
    console.error('refusing to commit .env.test.local')
    failed = true
    continue
  }
  if (key.length >= 16 && git(['show', `:${file}`]).includes(key)) {
    console.error(`refusing to commit ${file}: it contains the local OPENALGO_TEST_APIKEY`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
