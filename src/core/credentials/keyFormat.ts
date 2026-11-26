/** An OpenAlgo API key: 64 lowercase hex characters (`secrets.token_hex(32)`). */
export const KEY_RE = /^[0-9a-f]{64}$/

/**
 * Strips whitespace (scan-text spaces and line breaks) and lowercases, and nothing more, so a
 * pasted `api key: <key>` stays invalid and is refused before anything is sent.
 */
export function normalizeKeyInput(raw: string): { key: string; ok: boolean } {
  const key = raw.replace(/\s+/g, '').toLowerCase()
  return { key, ok: KEY_RE.test(key) }
}

/** True when one change added at least 32 characters, which typing never does. */
export function looksPasted(prev: string, next: string): boolean {
  return next.length - prev.length >= 32
}
