// Links from outside the app (pure). Another app, a web page or a QR code can open the app's
// scheme with any path, so a link must never stage an order: the ticket (`/order/new`), the modify
// sheet (`/order/:id/modify`), the GTT ticket (`/gtt/new`) and GTT modify (`/gtt/:id/modify`) are
// refused, and the link opens the instrument it names, or the watchlist. Only src/app/+native-intent
// calls this: router.push inside the app never passes through it, so the chart, the Option Chain,
// the tools and the held review open the ticket as before.
import { ALL_EXCHANGES } from './instruments/exchanges'
import { instrumentHref } from './links'

/** What the app says when it refuses a link. */
export const LINK_ORDER_REFUSED = "Orders can't be opened from a link"

const WATCHLIST = '/'

/**
 * A route under `order/` or `gtt/` (every screen there sends an order), wherever a router could
 * read the path from: the start, after a scheme's colon or slash, user info's `@`, or a query
 * value (the launcher's `__expo_url`), past any route groups. Matched on `flatten`ed text, so it
 * is wider than the router, which is case-sensitive and decodes no static segment.
 */
const ORDER_ROUTE = /(?:^|[/@:=?&#;])(?:\([^/]*\)\/+)*(?:order|gtt)\/+[^/?#&]/

/**
 * The link as the most lenient parser could read it: percent-decoded until it stops changing (a
 * malformed sequence decoded byte by byte), without the characters a URL parser drops (tabs,
 * newlines, spaces, other controls), backslashes as slashes, lower case.
 */
function flatten(url: string): string {
  let s = url
  for (let i = 0; i < 8; i++) {
    let next: string
    try {
      next = decodeURIComponent(s)
    } catch {
      next = s.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
    }
    if (next === s) break
    s = next
  }
  // every control, the space and DEL (U+0000 to U+0020, U+007F)
  const shown = Array.from(s, (ch) => (ch <= ' ' || ch === '\u007f' ? '' : ch)).join('')
  return shown.replace(/\\/g, '/').toLowerCase()
}

/** One component of a query, or null when it does not decode. */
function decode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/** The link's own query (before any fragment): the first value of each key. */
function queryOf(url: string): Map<string, string> {
  const out = new Map<string, string>()
  const q = url.split('#')[0] ?? ''
  const at = q.indexOf('?')
  if (at < 0) return out
  for (const part of q.slice(at + 1).split('&')) {
    const eq = part.indexOf('=')
    const k = decode(eq < 0 ? part : part.slice(0, eq))
    const v = decode(eq < 0 ? '' : part.slice(eq + 1))
    if (k !== null && v !== null && !out.has(k)) out.set(k, v)
  }
  return out
}

/** A symbol as the server lists one (`SBIN`, `M&M`, `BAJAJ-AUTO`, `NIFTY28NOV2524000CE`). */
const SYMBOL = /^[A-Z0-9][A-Z0-9&_.-]{0,59}$/

/** The instrument sheet of the exchange and symbol the link names, when both are real ones. */
function linkedInstrument(url: string): string | null {
  const q = queryOf(url)
  const exchange = q.get('exchange')
  const symbol = q.get('symbol')
  if (!exchange || !ALL_EXCHANGES.includes(exchange) || !symbol || !SYMBOL.test(symbol)) {
    return null
  }
  return instrumentHref(exchange, symbol)
}

export type OutsideLink = { path: string; refused: boolean }

/**
 * Where a link from outside the app opens: its own path, or, for an order screen, the instrument
 * it names or the watchlist (`refused`). It fails closed: a link it cannot read is refused.
 */
export function guardOutsideLink(url: string): OutsideLink {
  try {
    if (!ORDER_ROUTE.test(flatten(url))) return { path: url, refused: false }
    return { path: linkedInstrument(url) ?? WATCHLIST, refused: true }
  } catch {
    return { path: WATCHLIST, refused: true }
  }
}
