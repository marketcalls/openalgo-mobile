// The chart page's allowlist (design 7.9.1): openalgo-charts' OpenAlgoDataFeed calls only history
// and search (openalgo-rest.ts:157,180 at 2.7.3). Each goes through Api.call, on its lane and
// with the request's signal, so a superseded load leaves the history lane. Only the fields below
// are forwarded, each bounded: the bridge caps a body's size, not its strings.
import { z } from 'zod'
import type { Api } from '~/core/http/api'
import { SearchSchema } from '~/core/http/schemas'
import type { JSONValue } from '~/dom/bridge/protocol'
import { HistorySchema } from '~/market/chart/schemas'
import { ALL_EXCHANGES } from '~/market/instruments/exchanges'
import { ok, pickFields, type Route, refused } from './requests'

const MAX_TEXT = 64
/** The pattern alone allows any run of digits. */
const MAX_INTERVAL = 8
const EXCHANGES: ReadonlySet<string> = new Set(ALL_EXCHANGES)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const HistoryBody = z.object({
  symbol: z.string().min(1).max(MAX_TEXT),
  exchange: z.string().refine((x) => EXCHANGES.has(x)),
  interval: z
    .string()
    .max(MAX_INTERVAL)
    .regex(/^[0-9]*[A-Za-z]{1,2}$/),
  start_date: date,
  end_date: date,
})
const SearchBody = z.object({ query: z.string().min(1).max(MAX_TEXT) })

/** A POST route that sends the body's `fields` and answers the result as a success envelope. */
function post<S extends z.ZodType>(
  path: string,
  fields: S,
  send: (body: z.output<S>, signal: AbortSignal) => Promise<JSONValue>,
): Route {
  return {
    method: 'POST',
    path,
    async handle(r, signal) {
      const body = pickFields(r.body, fields)
      return body === null ? refused() : ok(await send(body, signal))
    },
  }
}

export function createChartRoutes(api: Pick<Api, 'call'>): Route[] {
  return [
    post('/api/v1/history', HistoryBody, (body, signal) =>
      api.call('history', body, HistorySchema, { signal }),
    ),
    post('/api/v1/search', SearchBody, (body, signal) =>
      api.call('search', body, SearchSchema, { signal }),
    ),
  ]
}
