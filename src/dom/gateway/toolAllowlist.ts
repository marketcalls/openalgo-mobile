// What each tool page may call (design 7.7; the plan's tool contract, from each page's API modules
// at openalgo.ref), matched by method and exact path. Anything else gets plan D's JSON 403, and
// nothing is sent. No row is an order write: every page has those through the held path
// (heldWrites.ts), whatever its list. The kinds:
// - device: a session route ported to the phone (dom/routes), never sent;
// - pass: an /api/v1 POST, sent with the page's body less its key placeholder;
// - lookup: a GET-only /api/v1 route, with the real key in its query only where KEYED_GETS says;
// - download: an /api/v1 POST whose file native saves itself (the tearsheet);
// - optionchain: /api/v1/optionchain, its Greeks priced on the phone when the server has none.
// How a page's body and the server's reply cross on a pass-through is here as well.
import { z } from 'zod'
import { isRecord } from '~/core/http/errors'
import type { ToolPageId } from '~/dom/bridge/protocol'

export type ToolRouteSpec = {
  method: 'GET' | 'POST'
  path: string
  kind: 'device' | 'pass' | 'lookup' | 'download' | 'optionchain'
}

const route = (method: ToolRouteSpec['method'], kind: ToolRouteSpec['kind'], path: string) => ({
  method,
  path,
  kind,
})
/** The underlying and expiry pickers of the six option tools. */
const PICKERS: readonly ToolRouteSpec[] = [
  route('GET', 'device', '/search/api/underlyings'),
  route('GET', 'device', '/search/api/expiries'),
]
const BENCHMARKS = route('GET', 'lookup', '/api/v1/portfolio/benchmarks')
/** The backtesters' symbol picker (components/portfolio/SymbolSearchInput.tsx). */
const CHARTINK = route('GET', 'device', '/chartink/search')

export const TOOL_ALLOWLIST: Readonly<Record<ToolPageId, readonly ToolRouteSpec[]>> = {
  oitracker: [...PICKERS, route('POST', 'device', '/oitracker/api/oi-data')],
  oirange: [...PICKERS, route('POST', 'device', '/oitracker/api/oi-data')],
  maxpain: [...PICKERS, route('POST', 'device', '/oitracker/api/maxpain')],
  ivsmile: [...PICKERS, route('POST', 'device', '/ivsmile/api/iv-smile-data')],
  gex: [...PICKERS, route('POST', 'device', '/gex/api/gex-data')],
  gammadensity: [...PICKERS, route('POST', 'device', '/gammadensity/api/gamma-data')],
  'portfolio-backtester': [
    BENCHMARKS,
    route('POST', 'pass', '/api/v1/portfolio/backtest'),
    route('POST', 'download', '/api/v1/portfolio/tearsheet'),
    CHARTINK,
  ],
  'sip-backtester': [
    BENCHMARKS,
    route('POST', 'pass', '/api/v1/sip/backtest'),
    route('GET', 'lookup', '/api/v1/sip/frequencies'),
    CHARTINK,
  ],
  'portfolio-analyzer': [route('POST', 'pass', '/api/v1/portfolio/holdings')],
  'sector-rotation': [
    route('GET', 'lookup', '/api/v1/sectorrotation/options'),
    route('POST', 'pass', '/api/v1/sectorrotation'),
    // the instrument picker (components/sector-rotation/InstrumentSearch.tsx)
    route('GET', 'device', '/search/api/search'),
  ],
}

/** The server's body on a pass-through: any JSON object with a string `status`, kept whole. */
export const PassThroughSchema = z.looseObject({ status: z.string() })

/** The longest body a page may pass through, as JSON text. */
export const MAX_PAGE_BODY = 200_000

/**
 * A page's body as a pass-through sends it: an object of at most MAX_PAGE_BODY characters, less
 * the page's `apikey` placeholder (the HTTP client adds the real key). Null when it is not one.
 */
export function pageBody(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || JSON.stringify(body).length > MAX_PAGE_BODY) return null
  const { apikey: _placeholder, ...rest } = body
  return rest
}
