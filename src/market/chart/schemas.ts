// The chart's server reads (design 7.9): history (contract K1, through the gateway), and the
// intervals and the session calendar (K2) that native builds the chart from. The client adds the
// key, and a reply reaches these schemas only after it has been classified a success.
import { z } from 'zod'
import { int, num, str } from '~/core/http/coerce'
import { envelope } from '~/core/http/schemas'
import { lenientRows, optValue } from '../books/schemas'

/**
 * One candle, as services/history_service.py sends it: `timestamp` in epoch seconds. A row
 * without a readable time or price cannot be drawn and is dropped; an unreadable volume or oi is
 * left unset.
 */
const HistoryRow = z.object({
  timestamp: int,
  open: num,
  high: num,
  low: num,
  close: num,
  volume: optValue,
  oi: optValue,
})
export const HistorySchema = envelope(lenientRows(HistoryRow).transform((r) => r.rows))

/** services/intervals_service.py: the codes the broker offers, grouped by unit. */
const codes = z.array(z.string()).optional()
export const IntervalsSchema = envelope(
  z.object({
    seconds: codes,
    minutes: codes,
    hours: codes,
    days: codes,
    weeks: codes,
    months: codes,
  }),
)

/** An exchange's session on one date, in epoch ms (database/market_calendar_db.py:665-760). */
const Timing = z.object({ exchange: str, start_time: int, end_time: int })
export const TimingsSchema = envelope(z.array(Timing))

/** One holiday of a year. An exchange list that cannot be read counts as none. */
const HolidayRow = z.object({
  date: z.string(),
  holiday_type: z.string(),
  closed_exchanges: z.array(str).catch([]),
  open_exchanges: z.array(Timing).catch([]),
})
export const HolidaysSchema = envelope(z.array(HolidayRow))

export type HistoryRow = z.output<typeof HistoryRow>
export type Timing = z.output<typeof Timing>
export type HolidayRow = z.output<typeof HolidayRow>
