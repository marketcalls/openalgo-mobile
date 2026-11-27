// The tool pages' symbol searches, answered on the phone from POST /api/v1/search:
// - GET /chartink/search (blueprints/chartink.py:822-840 at openalgo.ref), which the Portfolio
//   and SIP backtesters call through api/chartink.ts searchSymbols;
// - GET /search/api/search (blueprints/search.py:133-224), which Sector Rotation's
//   InstrumentSearch.tsx calls with one exchange.
// Each answers the rows as its web route shapes them: symbol, name and exchange. An empty query
// answers no results and asks nothing, as both routes do; at most MAX_RESULTS rows are kept.
import type { SymbolSearchResult } from '@/types/chartink'
import { SearchSchema } from '~/core/http/schemas'
import type { RouteDeps, RouteOptions } from './deps'

export const MAX_RESULTS = 100

/**
 * A /chartink/search row: the three fields the route sends (chartink.py:833-839), though the
 * web's SymbolSearchResult also declares brsymbol, token and lotsize.
 */
export type ChartinkHit = Pick<SymbolSearchResult, 'symbol' | 'name' | 'exchange'>
/** A /search/api/search row as the page reads it (InstrumentSearch.tsx:19-23 SearchHit). */
export type SiteSearchHit = { symbol: string; name: string; exchange: string }

async function search(
  q: string,
  exchange: string | undefined,
  d: RouteDeps,
  o: RouteOptions,
): Promise<{ results: SiteSearchHit[] }> {
  const query = q.trim()
  if (!query) return { results: [] }
  // The shared SearchSchema: a read the app's own search makes at the same time is shared with it.
  const rows = await d.api.call(
    'search',
    exchange ? { query, exchange } : { query },
    SearchSchema,
    { signal: o.signal },
  )
  return {
    results: rows
      .slice(0, MAX_RESULTS)
      .map((r) => ({ symbol: r.symbol, name: r.name ?? '', exchange: r.exchange })),
  }
}

export function chartinkSearch(
  q: string,
  exchange: string | undefined,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<{ results: ChartinkHit[] }> {
  return search(q, exchange || undefined, d, o)
}

/** One exchange, upper-cased as the route's `_parse_multi` does (search.py:108-112). */
export function siteSearch(
  q: string,
  exchange: string | undefined,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<{ results: SiteSearchHit[] }> {
  return search(q, exchange?.trim().toUpperCase() || undefined, d, o)
}
