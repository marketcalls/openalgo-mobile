// Zod pieces for the server's loose types (design 5.10): numbers that arrive as strings,
// booleans as 'true'/1, and the date formats of the books and the option chain.
import { z } from 'zod'

const NUMERIC = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/

/** A finite number, or a string that holds one. `''` is rejected. */
export const num = z.union([
  z.number(),
  z.string().regex(NUMERIC).transform(Number).pipe(z.number()),
])

/** Like `num`, but absent, `''` and null all mean undefined. */
export const optNum = z
  .union([num, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v === '' || v === null ? undefined : v))

export const int = num.pipe(z.number().int())

/** A string; a number (a token, say) becomes its decimal string. */
export const str = z.union([z.string(), z.number().transform(String)])

export const bool = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((s) => s === 'true'),
  z.union([z.literal(1), z.literal(0)]).transform((n) => n === 1),
])

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const IST_OFFSET_MS = 330 * 60_000

/** Date.UTC for a calendar date and time, or null when any part is out of range. */
function utc(y: number, mon: string, d: number, h = 0, m = 0, s = 0): number | null {
  const month = MONTHS.indexOf(mon.toUpperCase())
  if (month < 0 || h > 23 || m > 59 || s > 59) return null
  const t = Date.UTC(y, month, d, h, m, s)
  return new Date(t).getUTCDate() === d ? t : null
}

/** `'08-Apr-2025 13:58:03'`, an IST wall-clock time, as epoch ms; null if it is not one. */
export function dmyHms(s: string): number | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const [, d = '', mon = '', y = '', h = '', min = '', sec = ''] = m
  const t = utc(Number(y), mon, Number(d), Number(h), Number(min), Number(sec))
  return t === null ? null : t - IST_OFFSET_MS
}

/** An expiry such as `'28-NOV-26'` or `'28NOV26'` as `'2026-11-28'`; null if it is not one. */
export function expiryIso(s: string): string | null {
  const m = /^(\d{2})(-?)([A-Za-z]{3})\2(\d{2})$/.exec(s.trim())
  if (!m) return null
  const [, d = '', , mon = '', yy = ''] = m
  const t = utc(2000 + Number(yy), mon, Number(d))
  return t === null ? null : new Date(t).toISOString().slice(0, 10)
}
