// Links from outside the app (pure). Another app, a web page or a QR code can open the app's
// scheme with any path, so a link must never stage an order: the ticket (`/order/new`), the modify
// sheet (`/order/:id/modify`), the GTT ticket (`/gtt/new`) and GTT modify (`/gtt/:id/modify`) are
// refused, and the link opens the instrument it names, or the watchlist. Only src/app/+native-intent
// calls this: router.push inside the app never passes through it, so the chart, the Option Chain,
// the tools and the held review open the ticket as before.
//
// How: the guard reads a link the way Expo Router 58 does (fork/extractPathFromURL, then
// getStateFromPath), with the same global URL parser, so whatever the parser rewrites (an empty or
// a default port dropped, IDNA, a soft hyphen, dot segments, backslashes, tabs) is already applied
// to the route it checks. It opens only a route whose first segment is a screen that sends no
// order, and it hands the router that route as a plain path, which the router routes as it is:
// what opens is exactly what was checked.
import { ALL_EXCHANGES } from './instruments/exchanges'
import { instrumentHref } from './links'

/** What the app says when it refuses a link. */
export const LINK_ORDER_REFUSED = "Orders can't be opened from a link"

const WATCHLIST = '/'

/**
 * The first route segment of every screen a link may open: none of them sends an order with
 * values from a link. Every other route is refused: `order/` and `gtt/` (every screen there sends
 * an order), a route group, a different case or spelling, and a route the app does not have. The
 * route table in linkGuard.test.ts keeps this in step with src/app.
 */
const OPEN_ROUTES: ReadonlySet<string> = new Set([
  'account',
  'chart',
  'depth',
  'feed',
  'help',
  'instrument',
  'key',
  'optionchain',
  'orders',
  'portfolio',
  'search',
  'server',
  'tools',
  'update',
])

/** The launcher's reserved query keys (`__expo_url`, `__expo_disable_fab`, ...). */
const LAUNCHER = '__expo_'

const decodeOr = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * expo-linking's unwrapDevLaunchURL, which the router runs on every link, release builds too: the
 * target the launcher names (`__expo_url`, or the legacy host's `url`), else the link without its
 * reserved params.
 */
function unwrapLaunch(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  const legacy = parsed.hostname === 'expo-development-client'
  const target =
    parsed.searchParams.get(`${LAUNCHER}url`) ?? (legacy ? parsed.searchParams.get('url') : null)
  if (target != null) return target
  if (legacy) return ''
  const reserved = Array.from(parsed.searchParams.keys()).filter((k) => k.startsWith(LAUNCHER))
  if (!reserved.length) return url
  for (const key of reserved) parsed.searchParams.delete(key)
  return parsed.toString()
}

/** The router's fromDeepLink: host and path, then the query with each value decoded once more. */
function fromDeepLink(url: string): string {
  let res: URL
  try {
    res = new URL(url)
  } catch {
    return url.startsWith('/') ? url : url.replace(/^[^:]+:\/\//, '')
  }
  const query = res.search
    ? Array.from(res.searchParams.entries(), ([k, v]) => `${k}=${decodeOr(v)}`).join('&')
    : ''
  return `${res.host}${res.pathname}${query ? `?${query}` : ''}`
}

/** Inside Expo Go the router reads Expo Go's own form, `exp://host/--/path`. */
const inExpoGo = (): boolean =>
  Boolean((globalThis as { expo?: { modules?: { ExpoGo?: unknown } } }).expo?.modules?.ExpoGo)

/**
 * The path the router reads from a link (extractExpoPathFromURL), with a leading slash as the cold
 * start and a link that comes while the app runs both route it (getInitialPath).
 */
function routerPath(url: string): string {
  const link = unwrapLaunch(url)
  let path: string
  if (/^https?:\/\//.test(link)) {
    const { origin, href, hostname } = new URL(link)
    path = hostname === 'exp.host' || hostname === 'u.expo.dev' ? '' : href.replace(origin, '')
  } else if (inExpoGo() && /^exps?:\/\//.test(link)) {
    const inner = link.match(/exps?:\/\/.*?\/--\/(.*)/)?.[1] ?? ''
    const query = link.match(/exps?:\/\/.*\?(.*)/)?.[1]
    path = inner ? fromDeepLink(`a://${inner}`) : query ? fromDeepLink(`a://?${query}`) : ''
  } else {
    path = fromDeepLink(link)
  }
  path = path.replace(/^\//, '')
  return path.startsWith('/') ? path : `/${path}`
}

/**
 * What getStateFromPath matches route patterns against: the path parsed against `file:` (dot
 * segments, backslashes, tabs resolved), its slashes trimmed and collapsed, as `a/b/` (`/` for the
 * root); the patterns match it case-sensitively and decode no static segment. Also the path's
 * query and fragment, as the URL serializes them.
 */
function routeOf(path: string): { route: string; rest: string } {
  let pathname = ''
  let rest = ''
  try {
    const parsed = new URL(path, 'file:')
    pathname = parsed.pathname
    rest = parsed.search + parsed.hash
  } catch {
    // the router reads no path either: the root
  }
  const trimmed = `${pathname.replace(/^\/+/g, '').replace(/\/+$/g, '')}/`
  const route = trimmed.replace(/\/+/g, '/').replace(/^\//, '').replace(/\?.*$/, '')
  return { route: route.endsWith('/') ? route : `${route}/`, rest }
}

/** The root, or a route whose first segment is a screen a link may open. */
const opens = (route: string): boolean =>
  route === '/' || OPEN_ROUTES.has(route.slice(0, route.indexOf('/')))

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
 * Where a link from outside the app opens. A route a link may open comes back as the plain path
 * the router reads from the link (`/chart/NSE%3ASBIN?…`), so the router routes exactly that. Any
 * other route is refused: the instrument the link names, or the watchlist. It fails closed: a link
 * it cannot read is refused, and so is one that still carries a launcher param once unwrapped (a
 * link wrapped twice).
 */
export function guardOutsideLink(url: string): OutsideLink {
  const refuse = (): OutsideLink => {
    try {
      return { path: linkedInstrument(url) ?? WATCHLIST, refused: true }
    } catch {
      return { path: WATCHLIST, refused: true }
    }
  }
  try {
    const { route, rest } = routeOf(routerPath(url))
    if (!opens(route)) return refuse()
    const params = new URL(rest, 'file:').searchParams
    if (Array.from(params.keys()).some((k) => k.startsWith(LAUNCHER))) return refuse()
    const path = `/${route === '/' ? '' : route.slice(0, -1)}${rest}`
    // The router takes a path that starts with one slash as it is (no URL to unwrap or parse) and
    // reads its route as above: at the cold start and for a link that comes while the app runs
    // (`/…`), and when it checks the route names (`…`, no slash). Both must give the route checked.
    if (routeOf(path).route !== route || routeOf(path.slice(1)).route !== route) return refuse()
    return { path, refused: false }
  } catch {
    return refuse()
  }
}
