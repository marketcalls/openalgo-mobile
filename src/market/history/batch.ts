// History for the tools (design 7.8, "history queue"): many /history reads at once go through the
// scheduler's history lane (section 7.5: at most 3 in flight, 3 starts a second), so a batch never
// crowds out the app's other reads. Each request settles on its own: a failed one is its error.
import type { Api } from '~/core/http/api'
import { noReplyError } from '~/core/http/client'
import { ApiError } from '~/core/http/errors'
import { log } from '~/core/log/logger'
import { istDate } from '~/core/realtime/marketHours'
import { type HistoryRow, HistorySchema } from '~/market/chart/schemas'

export type HistoryRequest = {
  symbol: string
  exchange: string
  interval: string
  start_date: string
  end_date: string
}

export type HistoryResult = HistoryRow[] | ApiError

/** The scheduler's history lane (historyMaxInFlight): a gated batch hands it this many at once. */
const LANE = 3
const NEVER_ABORTED = new AbortController().signal

/**
 * Reads every request, in its order: the candles that parse, or the request's ApiError (an
 * abort gives each one still out or queued a Network error at once). `onProgress` sees each
 * settle, and `onSettle` which one it was and what it came to. Any other error is a bug and
 * rejects the batch.
 *
 * `gate` (preflight F conflict 22) is awaited before each read is sent: a batch with one hands
 * the lane only as many reads as it runs, so a read that waits never goes while the gate is shut
 * (OI Profile's daily reads while its screen is hidden, design 7.5). A gate that rejects, as on
 * an abort, settles that read unsent with the abort's Network error.
 */
export async function fetchHistoryBatch(
  api: Pick<Api, 'call'>,
  reqs: readonly HistoryRequest[],
  o: {
    onProgress?: (done: number, total: number) => void
    onSettle?: (index: number, result: HistoryResult) => void
    signal?: AbortSignal
    gate?: (signal: AbortSignal) => Promise<void>
  } = {},
): Promise<HistoryResult[]> {
  let done = 0
  const settled = (i: number, r: HistoryResult): HistoryResult => {
    done++
    o.onProgress?.(done, reqs.length)
    o.onSettle?.(i, r)
    return r
  }
  const read = async (i: number): Promise<HistoryResult> => {
    const req = reqs[i] as HistoryRequest
    try {
      const { rows, dropped } = await api.call('history', { ...req }, HistorySchema, {
        signal: o.signal,
      })
      if (dropped > 0) log.warn('history', `${req.exchange}:${req.symbol} dropped ${dropped} rows`)
      return settled(i, rows)
    } catch (e) {
      if (!(e instanceof ApiError)) throw e
      return settled(i, e)
    }
  }
  const { gate } = o
  if (!gate) return Promise.all(reqs.map((_, i) => read(i)))

  const out: HistoryResult[] = new Array(reqs.length)
  let next = 0
  const run = async (): Promise<void> => {
    while (next < reqs.length) {
      const i = next++
      let open = true
      try {
        await gate(o.signal ?? NEVER_ABORTED)
      } catch {
        open = false
      }
      out[i] = open ? await read(i) : settled(i, noReplyError('history'))
    }
  }
  await Promise.all(Array.from({ length: Math.min(LANE, reqs.length) }, run))
  return out
}

/**
 * The IST date of the last completed daily candle: `rows[-2]`, since the last row is today's,
 * still forming (design 7.8). null with fewer than two rows.
 */
export function lastCompletedDay(rows: readonly HistoryRow[]): string | null {
  const row = rows.length >= 2 ? rows[rows.length - 2] : undefined
  return row ? istDate(row.timestamp * 1000) : null
}
