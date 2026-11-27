// History for the tools (design 7.8, "history queue"): many /history reads at once go through the
// scheduler's history lane (section 7.5: at most 3 in flight, 3 starts a second), so a batch never
// crowds out the app's other reads. Each request settles on its own: a failed one is its error.
import type { Api } from '~/core/http/api'
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

/**
 * Reads every request, in its order: the candles that parse, or the request's ApiError (an
 * abort gives each one still out or queued a Network error at once). `onProgress` sees each
 * settle. Any other error is a bug and rejects the batch.
 */
export async function fetchHistoryBatch(
  api: Pick<Api, 'call'>,
  reqs: readonly HistoryRequest[],
  o: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<Array<HistoryRow[] | ApiError>> {
  let done = 0
  const settled = (): void => {
    done++
    o.onProgress?.(done, reqs.length)
  }
  return Promise.all(
    reqs.map(async (req): Promise<HistoryRow[] | ApiError> => {
      try {
        const { rows, dropped } = await api.call('history', { ...req }, HistorySchema, {
          signal: o.signal,
        })
        if (dropped > 0)
          log.warn('history', `${req.exchange}:${req.symbol} dropped ${dropped} rows`)
        settled()
        return rows
      } catch (e) {
        if (!(e instanceof ApiError)) throw e
        settled()
        return e
      }
    }),
  )
}

/**
 * The IST date of the last completed daily candle: `rows[-2]`, since the last row is today's,
 * still forming (design 7.8). null with fewer than two rows.
 */
export function lastCompletedDay(rows: readonly HistoryRow[]): string | null {
  const row = rows.length >= 2 ? rows[rows.length - 2] : undefined
  return row ? istDate(row.timestamp * 1000) : null
}
