// The chart's data (design 7.9.1, 7.9.2): openalgo-charts' own OpenAlgo feed, unchanged, over the
// bridge. History and search go through the bridged fetch to native's two allowlisted routes; the
// socket is native's emulation over the app's own feed. The page sends the placeholder key and
// URLs that resolve nowhere, so it never holds the key, the server address or a real socket.
import { type BarCache, OpenAlgoLiveDataFeed, withBarCache } from 'openalgo-charts'
import { DOM_ORIGIN, DOM_WS_URL, NATIVE_KEY } from '~/dom/bridge/protocol'
import type { DomClient } from '~/dom/web/client'
import { createBridgedFetch } from '~/dom/web/fetch'
import { createBridgedSocketFactory } from '~/dom/web/socket'

/** The web terminal's warm-load cache (terminal.ts withBarCache, 10 minutes). */
const BAR_CACHE_TTL_MS = 600_000

// frontend/src/lib/trading/openInterest.ts (c8b2896): open interest by segment. Another exchange
// (CRYPTO) is unknown, and the library keeps whatever finite column the server sends.
const DERIVATIVE_SEGMENTS: ReadonlySet<string> = new Set([
  'NFO',
  'BFO',
  'CDS',
  'BCD',
  'MCX',
  'NCO',
  'NCDEX',
])
const CASH_SEGMENTS: ReadonlySet<string> = new Set([
  'NSE',
  'BSE',
  'NSE_INDEX',
  'BSE_INDEX',
  'MCX_INDEX',
  'GLOBAL_INDEX',
])

function hasOpenInterest(r: { exchange: string }): boolean | undefined {
  if (DERIVATIVE_SEGMENTS.has(r.exchange)) return true
  return CASH_SEGMENTS.has(r.exchange) ? false : undefined
}

export function createChartFeeds(client: DomClient): {
  live: OpenAlgoLiveDataFeed
  cached: BarCache
} {
  const live = new OpenAlgoLiveDataFeed({
    // Exactly DOM_ORIGIN: the library appends /api/v1/history and /api/v1/search, which native's
    // router matches exactly.
    baseUrl: DOM_ORIGIN,
    apiKey: NATIVE_KEY,
    wsUrl: DOM_WS_URL,
    fetchImpl: createBridgedFetch(client),
    socketFactory: createBridgedSocketFactory(client),
    timezone: 'Asia/Kolkata',
    hasOpenInterest,
  })
  return { live, cached: withBarCache(live, { ttlMs: BAR_CACHE_TTL_MS }) }
}
