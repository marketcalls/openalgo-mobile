// Reads the real-server settings from `.env.test.local` (git-ignored), or null when the file is
// missing or incomplete: test/real/env.ts for the scripts. The key is returned, never printed.
import { existsSync, readFileSync } from 'node:fs'

/** `NAME=value` lines; blank lines, `#` comments and one pair of quotes around a value are skipped. */
function parse(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m?.[1] || line.trimStart().startsWith('#')) continue
    out[m[1]] = (m[2] ?? '').replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

/** @returns {{ url: string, key: string, wsUrl: string | null } | null} */
export function loadTestEnv(path = '.env.test.local') {
  if (!existsSync(path)) return null
  const v = parse(readFileSync(path, 'utf8'))
  const url = v.OPENALGO_TEST_URL
  const key = v.OPENALGO_TEST_APIKEY
  if (!url || !key) return null
  return { url, key, wsUrl: v.OPENALGO_TEST_WS_URL || null }
}
