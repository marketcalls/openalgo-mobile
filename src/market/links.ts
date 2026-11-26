// Route links (pure). Features link to each other only through these, never by importing.
// Hrefs are plain strings: the routes they name are declared by the screens that own them.
import { ALL_EXCHANGES } from './instruments/exchanges'
import {
  PRICE_TYPES,
  PRODUCTS,
  type PriceType,
  type Product,
  SIDES,
  type Side,
  type TicketParams,
} from './types'

const enc = encodeURIComponent

/** The `[key]` route segment: `exchange:symbol`, percent-encoded. */
const keySegment = (ex: string, sym: string) => enc(`${ex}:${sym}`)

export const instrumentHref = (ex: string, sym: string) => `/instrument/${keySegment(ex, sym)}`
export const depthHref = (ex: string, sym: string) => `/depth/${keySegment(ex, sym)}`
export const chartHref = (ex: string, sym: string) => `/chart/${keySegment(ex, sym)}`
/** The chain of an underlying, such as `optionChainTarget` names. */
export const optionChainHref = (ex: string, sym: string) => `/optionchain/${keySegment(ex, sym)}`

/** The exchange and symbol of a `[key]` param, split at the first colon; null if malformed. */
export function parseKey(param: string): { exchange: string; symbol: string } | null {
  let raw: string
  try {
    raw = decodeURIComponent(param)
  } catch {
    return null
  }
  const i = raw.indexOf(':')
  if (i <= 0 || i === raw.length - 1) return null
  return { exchange: raw.slice(0, i), symbol: raw.slice(i + 1) }
}

export const searchHref = (o: { addTo?: string } = {}) =>
  o.addTo === undefined ? '/search' : `/search?addTo=${enc(o.addTo)}`

/** `path?k=v&…` with the params that are set, each value encoded. */
function withQuery(path: string, q: [string, string | number | undefined][]): string {
  const parts = q.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${enc(String(v))}`)
  return `${path}?${parts.join('&')}`
}

export function ticketHref(p: TicketParams): string {
  return withQuery('/order/new', [
    ['exchange', p.exchange],
    ['symbol', p.symbol],
    ['action', p.action],
    ['pricetype', p.pricetype],
    ['price', p.price],
    ['product', p.product],
    ['quantity', p.quantity],
    ['trigger', p.trigger],
    ['source', p.source],
  ])
}

/** What a link into the modify sheet can preset: a new price or trigger for the order. */
export type ModifyPreset = { price?: number; trigger_price?: number }

/** The sheet only fills its fields from a preset; `source: 'chart'` sends the change as 'mobile-chart'. */
export function modifyHref(orderid: string, o: ModifyPreset & { source?: 'chart' } = {}): string {
  const path = `/order/${enc(orderid)}/modify`
  const q: [string, number | string | undefined][] = [
    ['price', o.price],
    ['trigger_price', o.trigger_price],
    ['source', o.source],
  ]
  return q.some(([, v]) => v !== undefined) ? withQuery(path, q) : path
}

/** What a link into the GTT ticket can preset. `quantity` is in units, whatever the exchange. */
export type GttParams = { exchange: string; symbol: string; action?: Side; quantity?: number }

export function gttHref(p: GttParams): string {
  return withQuery('/gtt/new', [
    ['exchange', p.exchange],
    ['symbol', p.symbol],
    ['action', p.action],
    ['quantity', p.quantity],
  ])
}

export const gttModifyHref = (triggerId: string) => `/gtt/${enc(triggerId)}/modify`

export const toolHref = (toolId: string, o: { u?: string } = {}) =>
  o.u === undefined ? `/tools/${enc(toolId)}` : `/tools/${enc(toolId)}?u=${enc(o.u)}`

/**
 * The Orders tab; `segment` 'all' opens All orders, where a filled or rejected order shows, and
 * 'gtt' the GTT list.
 */
export const ordersHref = (o: { segment?: 'open' | 'all' | 'trades' | 'gtt' } = {}) =>
  o.segment === undefined ? '/orders' : `/orders?segment=${o.segment}`
export const backupHref = () => '/account/backup'

type Raw = Record<string, string | string[] | undefined>

/** One value of a route param, or undefined when absent or blank. */
const one = (raw: Raw, k: string): string | undefined => {
  const v = raw[k]
  const s = Array.isArray(v) ? v[0] : v
  return s === undefined || s === '' ? undefined : s
}

const oneOf = <T extends string>(set: readonly T[], v: string): T | undefined =>
  set.find((x) => x === v)

/** A quantity param: a whole number of at least 1, else null. */
function quantityOf(v: string): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 ? n : null
}

/** A price param that an order can carry: finite and above 0, else null. */
function positiveOf(v: string): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Ticket presets from route params. Null when any given field is invalid, so a broken link
 * opens an "incomplete" message rather than a half-filled ticket. A quote-only exchange
 * parses; the ticket's own validation refuses it.
 */
export function parseTicketParams(raw: Raw): TicketParams | null {
  const exchange = one(raw, 'exchange')
  const symbol = one(raw, 'symbol')
  const action = oneOf<Side>(SIDES, one(raw, 'action') ?? '')
  if (!exchange || !ALL_EXCHANGES.includes(exchange) || !symbol || !action) return null
  const out: TicketParams = { exchange, symbol, action }

  const pt = one(raw, 'pricetype')
  if (pt !== undefined) {
    const v = oneOf<PriceType>(PRICE_TYPES, pt)
    if (!v) return null
    out.pricetype = v
  }
  const pr = one(raw, 'product')
  if (pr !== undefined) {
    const v = oneOf<Product>(PRODUCTS, pr)
    if (!v) return null
    out.product = v
  }
  const price = one(raw, 'price')
  if (price !== undefined) {
    const n = Number(price)
    if (!Number.isFinite(n) || n < 0) return null
    out.price = n
  }
  const qty = one(raw, 'quantity')
  if (qty !== undefined) {
    const n = quantityOf(qty)
    if (n === null) return null
    out.quantity = n
  }
  const trigger = one(raw, 'trigger')
  if (trigger !== undefined) {
    const n = positiveOf(trigger)
    if (n === null) return null
    out.trigger = n
  }
  const src = one(raw, 'source')
  if (src !== undefined) {
    if (src !== 'chart') return null
    out.source = src
  }
  return out
}

/**
 * Modify presets from route params (the order id is the route's own and not read here). `{}` when
 * none is given; null when one is invalid, so a broken link opens an "incomplete" message rather
 * than a sheet that quietly ignores it.
 */
export function parseModifyParams(raw: Raw): (ModifyPreset & { source?: 'chart' }) | null {
  const out: ModifyPreset & { source?: 'chart' } = {}
  const price = one(raw, 'price')
  if (price !== undefined) {
    const n = positiveOf(price)
    if (n === null) return null
    out.price = n
  }
  const trigger = one(raw, 'trigger_price')
  if (trigger !== undefined) {
    const n = positiveOf(trigger)
    if (n === null) return null
    out.trigger_price = n
  }
  const src = one(raw, 'source')
  if (src !== undefined) {
    if (src !== 'chart') return null
    out.source = src
  }
  return out
}

/**
 * GTT ticket presets from route params, by `parseTicketParams`' rules, except that the action
 * may be absent (the instrument sheet's link names none; the ticket defaults it to BUY).
 */
export function parseGttParams(raw: Raw): GttParams | null {
  const exchange = one(raw, 'exchange')
  const symbol = one(raw, 'symbol')
  if (!exchange || !ALL_EXCHANGES.includes(exchange) || !symbol) return null
  const out: GttParams = { exchange, symbol }

  const act = one(raw, 'action')
  if (act !== undefined) {
    const v = oneOf<Side>(SIDES, act)
    if (!v) return null
    out.action = v
  }
  const qty = one(raw, 'quantity')
  if (qty !== undefined) {
    const n = quantityOf(qty)
    if (n === null) return null
    out.quantity = n
  }
  return out
}
