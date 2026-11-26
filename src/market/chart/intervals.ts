// The intervals the chart's picker offers (design 7.9, ruling 6): what the server lists, in the
// web's order, limited to the codes `history` accepts.
import type { z } from 'zod'
import type { IntervalsSchema } from './schemas'

/** The web's list when the server's cannot be read (terminal.ts:7869). */
export const FALLBACK_INTERVALS = ['1m', '5m', '15m', '1h', 'D']

/**
 * The codes `history` accepts (2.0.0.0's OneOf). Before 2.0.2.2 `intervals` also lists the broker's
 * aliases, such as Zerodha's `60m`, which `history` refuses with a 400.
 */
const HISTORY_INTERVALS = new Set([
  '1s',
  '5s',
  '10s',
  '15s',
  '30s',
  '45s',
  '1m',
  '2m',
  '3m',
  '5m',
  '10m',
  '15m',
  '20m',
  '30m',
  '1h',
  '2h',
  '3h',
  '4h',
  'D',
  'W',
  'M',
])

/**
 * Seconds, minutes, hours, days, weeks, months, without repeats or codes `history` refuses. Seconds
 * go when `polling` (the forming bar then comes from a poll, too slow for them). A null read gives
 * the fallback.
 */
export function chartIntervals(
  data: z.output<typeof IntervalsSchema> | null,
  polling: boolean,
): string[] {
  if (!data) return FALLBACK_INTERVALS
  const groups = [
    polling ? [] : data.seconds,
    data.minutes,
    data.hours,
    data.days,
    data.weeks,
    data.months,
  ]
  const out = [...new Set(groups.flatMap((g) => g ?? []))].filter((c) => HISTORY_INTERVALS.has(c))
  return out.length ? out : FALLBACK_INTERVALS
}
