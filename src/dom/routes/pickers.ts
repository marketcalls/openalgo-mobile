// The tool pages' underlying and expiry pickers, answered on the phone: GET
// /search/api/underlyings and GET /search/api/expiries (blueprints/search.py:227-273 at
// openalgo.ref), which the pages call through their API modules (api/oi-tracker.ts getUnderlyings
// and getExpiries, alike in gex.ts, iv-smile.ts and gamma-density.ts).
// - Underlyings come from the symbol master and never wait for its download: today's master, an
//   earlier one, else the web's defaults (design 7.8). The master already drops the exchange
//   test symbols, as the route does (:270-271).
// - Expiries are /api/v1/expiry's DD-MMM-YY list, read once per IST day (OptionsData).
import type { ExpiriesResponse, UnderlyingsResponse } from '@/api/oi-tracker'
import type { RouteDeps } from './deps'

export async function underlyings(exchange: string, d: RouteDeps): Promise<UnderlyingsResponse> {
  const { list } = await d.master.underlyingsNow(exchange.trim())
  return { status: 'success', underlyings: list }
}

/**
 * `type` is the page's `instrumenttype`. The pages send `options`; without one the web lists both
 * calendars, which /api/v1/expiry cannot, so the phone lists the options expiries
 * (database/symbol.py:320-325 reads "future", "futures" and "fut" as futures). With no exchange
 * or underlying nothing is asked.
 */
export async function expiries(
  exchange: string,
  underlying: string,
  type: string | undefined,
  d: RouteDeps,
): Promise<ExpiriesResponse> {
  const ex = exchange.trim()
  const u = underlying.trim().toUpperCase()
  if (!ex || !u) return { status: 'success', expiries: [] }
  const wanted = (type ?? '').trim().toLowerCase()
  const kind = ['futures', 'future', 'fut'].includes(wanted) ? 'futures' : 'options'
  return { status: 'success', expiries: await d.options.expiries(ex, u, kind) }
}
