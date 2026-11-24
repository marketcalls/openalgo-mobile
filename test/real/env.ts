// Reads the real-server check's settings from `.env.test.local` (gitignored), or null when the
// file is missing or incomplete. The key is returned to the tests and never printed.
import { existsSync, readFileSync } from 'node:fs'

export type TestEnv = { url: string; key: string; wsUrl: string | null }

/** `NAME=value` lines; blank lines, `#` comments and one pair of quotes around a value are skipped. */
function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m?.[1] || line.trimStart().startsWith('#')) continue
    out[m[1]] = (m[2] ?? '').replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

export function loadTestEnv(path = '.env.test.local'): TestEnv | null {
  if (!existsSync(path)) return null
  const v = parse(readFileSync(path, 'utf8'))
  const url = v.OPENALGO_TEST_URL
  const key = v.OPENALGO_TEST_APIKEY
  if (!url || !key) return null
  return { url, key, wsUrl: v.OPENALGO_TEST_WS_URL || null }
}
