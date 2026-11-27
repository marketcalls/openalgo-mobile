// The Option Chain's model (design 7.8, 17.4): which chain a link opens, the ladder's rows and
// orientation marks from the live spot, the ticket a leg's BUY or SELL opens, the query its chain
// is read with, and the screen's copy. Pure: no React, no native module.

import { qk } from '~/core/query/keys'
import { istClock, istDate } from '~/core/realtime/marketHours'
import { parseKey } from '~/market/links'
import { MASTER_EXCHANGES } from '~/market/master/master'
import type { OptionsData } from '~/market/options/data'
import { expiryInstantMs, optionsExchangeOf, toDashed, toDdmmmyy } from '~/market/options/expiry'
import type { ChainLeg, ChainRow, OptionChain } from '~/market/options/schemas'
import type { Side, TicketParams } from '~/market/types'
import { fmtOi, fmtPrice, fmtStrike } from '~/ui/format'

/** The chain a screen shows: the options exchange and the underlying, as /optionchain takes it. */
export type ChainTarget = { optionsExchange: string; underlying: string }

/** What the screen opens on when no link names a chain. */
export const DEFAULT_TARGET: ChainTarget = { optionsExchange: 'NFO', underlying: 'NIFTY' }

export const CHAIN_LINK_INCOMPLETE = 'This option chain link is incomplete.'

/** An underlying as the server spells one: upper case, digits, & and - (M&M, BAJAJ-AUTO). */
const UNDERLYING = /^[A-Z0-9&-]{1,40}$/

/** `EX:SYM` with EX either the underlying's exchange or the options exchange. */
function targetOf(param: string): ChainTarget | null {
  const k = parseKey(param)
  if (!k) return null
  const optionsExchange = optionsExchangeOf(k.exchange)
  if (!(MASTER_EXCHANGES as readonly string[]).includes(optionsExchange)) return null
  return UNDERLYING.test(k.symbol) ? { optionsExchange, underlying: k.symbol } : null
}

/** `optionchain/[key]`: the underlying's quote key, `NSE_INDEX:NIFTY` → NIFTY on NFO. */
export const targetFromKey = (key: string): ChainTarget | null => targetOf(key)

/** The tool route's `u`: `NFO:NIFTY`. Absent is null too: the screen opens its default. */
export const targetFromU = (u: string | undefined): ChainTarget | null =>
  u === undefined ? null : targetOf(u)

// --- The leg's ticket -------------------------------------------------------------------------

/**
 * BUY at the ask and SELL at the bid, as a LIMIT; at the LTP when that side of the book is empty;
 * a MARKET order when neither is priced. The quantity is in units: lots × the lot size.
 */
export function legTicket(
  leg: ChainLeg,
  side: Side,
  lots: number,
  optionsExchange: string,
): TicketParams {
  const quantity = lots * Math.max(1, leg.lotsize)
  const base = { exchange: optionsExchange, symbol: leg.symbol, action: side, quantity }
  const price = ticketPrice(leg, side)
  return price === null
    ? { ...base, pricetype: 'MARKET' }
    : { ...base, pricetype: 'LIMIT', price: price.value }
}

/** The price legTicket sends and what it is: the side's quote, else the LTP; null at market. */
export function ticketPrice(
  leg: ChainLeg,
  side: Side,
): { value: number; from: 'ask' | 'bid' | 'LTP' } | null {
  const quote = side === 'BUY' ? leg.ask : leg.bid
  if (quote > 0) return { value: quote, from: side === 'BUY' ? 'ask' : 'bid' }
  return leg.ltp > 0 ? { value: leg.ltp, from: 'LTP' } : null
}

/** The caption under BUY or SELL: "at 120.55 ask", "at 120.50 LTP", "at market". */
export function ticketCaption(leg: ChainLeg, side: Side): string {
  const p = ticketPrice(leg, side)
  return p === null ? 'at market' : `at ${fmtPrice(p.value)} ${p.from}`
}

export const MIN_LOTS = 1
export const MAX_LOTS = 999
export const clampLots = (n: number) => Math.min(MAX_LOTS, Math.max(MIN_LOTS, Math.round(n)))

// --- The ladder ---------------------------------------------------------------------------------

export type LadderRow = {
  kind: 'row'
  row: ChainRow
  /** The strike nearest the live spot. */
  atm: boolean
  ceItm: boolean
  peItm: boolean
}
export type LadderItem = LadderRow | { kind: 'spot'; spot: number }

/**
 * The ladder's items from one live spot (ux OC-3): the strike nearest it is ATM, calls below it
 * and puts above it are in the money, and the spot's own marker sits between the strikes around
 * it. `atmIndex` is the ATM row's index among the items, -1 for an empty chain.
 */
export function ladderItems(
  rows: readonly ChainRow[],
  spot: number,
): { items: LadderItem[]; atmIndex: number } {
  const priced = spot > 0
  let atmStrike: number | null = null
  for (const r of rows) {
    if (atmStrike === null || Math.abs(r.strike - spot) < Math.abs(atmStrike - spot)) {
      atmStrike = r.strike
    }
  }
  const items: LadderItem[] = []
  let marked = !priced
  let atmIndex = -1
  for (const row of rows) {
    if (!marked && row.strike > spot) {
      items.push({ kind: 'spot', spot })
      marked = true
    }
    const atm = row.strike === atmStrike
    if (atm) atmIndex = items.length
    items.push({
      kind: 'row',
      row,
      atm,
      ceItm: priced && row.strike < spot,
      peItm: priced && row.strike > spot,
    })
  }
  if (!marked && rows.length > 0) items.push({ kind: 'spot', spot })
  return { items, atmIndex }
}

/** A strike in a testID: `24500`, `83_25`. */
export const strikeId = (strike: number): string => String(strike).replace('.', '_')

/** The largest OI each side shows: its bar is full width, its cell bold. */
export function maxOi(rows: readonly ChainRow[]): { ce: number; pe: number } {
  let ce = 0
  let pe = 0
  for (const r of rows) {
    ce = Math.max(ce, r.ce?.oi ?? 0)
    pe = Math.max(pe, r.pe?.oi ?? 0)
  }
  return { ce, pe }
}

/** The day's change in percent from `prev_close`; undefined when there is none. */
export function changePct(ltp: number, prevClose: number): number | undefined {
  return prevClose > 0 && ltp > 0 ? ((ltp - prevClose) / prevClose) * 100 : undefined
}

/** A cell's spoken label: "NIFTY 24,500 call, LTP 120.50, OI 12.5 lakh". */
export function legLabel(underlying: string, leg: ChainLeg, strike: number, side: 'ce' | 'pe') {
  const oi = fmtOi(leg.oi).replace(/(K|L|Cr)$/, (u) => SPOKEN[u] ?? u)
  const ltp = leg.ltpMissing ? 'no LTP' : `LTP ${fmtPrice(leg.ltp)}`
  return `${underlying} ${fmtStrike(strike)} ${side === 'ce' ? 'call' : 'put'}, ${ltp}, OI ${oi}`
}
const SPOKEN: Record<string, string> = { K: ' thousand', L: ' lakh', Cr: ' crore' }

// --- The underlying picker ----------------------------------------------------------------------

/** The indices a trader looks for first (ux OC-10), then A–Z. */
const INDICES_FIRST = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX']

/** Distinct, with `query` (upper-cased) in them, indices first and the rest A–Z. */
export function pickerList(names: readonly string[], query: string): string[] {
  const q = query.trim().toUpperCase()
  const rank = (u: string) => {
    const i = INDICES_FIRST.indexOf(u)
    return i < 0 ? INDICES_FIRST.length : i
  }
  return [...new Set(names)]
    .filter((u) => q === '' || u.includes(q))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
}

// --- Greeks ------------------------------------------------------------------------------------

export const GREEKS = ['iv', 'delta', 'gamma', 'theta', 'vega'] as const
export type Greek = (typeof GREEKS)[number]
/** The two Greek columns per side: [outer, inner]. */
export type GreekPair = readonly [Greek, Greek]

export const GREEK_LABEL: Readonly<Record<Greek, string>> = {
  iv: 'IV',
  delta: 'Delta',
  gamma: 'Gamma',
  theta: 'Theta',
  vega: 'Vega',
}
/** Decimals as on the web page (OptionChain.tsx formatGreek). */
export const GREEK_DP: Readonly<Record<Greek, number>> = {
  iv: 2,
  delta: 4,
  gamma: 4,
  theta: 2,
  vega: 2,
}

export const greekOf = (leg: ChainLeg, g: Greek): number | undefined =>
  g === 'iv' ? leg.implied_volatility : leg[g]

/** Two fit at 360 dp: a third pick drops the older; a picked one stays as it is. */
export function pickGreek(pair: GreekPair, g: Greek): GreekPair {
  if (pair.includes(g)) return pair
  return [pair[1], g]
}

export type ChainView = 'price' | 'greeks'

/** The view and the Greek pair, kept for the app session (ux OC-9). */
export const chainSession: { view: ChainView; greeks: GreekPair } = {
  view: 'price',
  greeks: ['iv', 'delta'],
}

// --- Expiries and copy --------------------------------------------------------------------------

const DAY_MS = 86_400_000
const titleCase = (m: string) => m.charAt(0) + m.slice(1).toLowerCase()

/** '28-NOV-25' → '28 Nov'; with `year`, '28 Nov 25'. */
export function expiryLabel(expiry: string, year = false): string {
  const d = toDashed(expiry)
  if (d === null) return expiry
  const [dd, mmm, yy] = d.split('-') as [string, string, string]
  return year ? `${dd} ${titleCase(mmm)} ${yy}` : `${dd} ${titleCase(mmm)}`
}

/** Whole IST days from `nowMs` to the expiry's day; null for a code that is not a date. */
export function daysTo(expiry: string, nowMs: number): number | null {
  const at = expiryInstantMs(expiry, 'NFO')
  if (at === null) return null
  return Math.round((Date.parse(istDate(at)) - Date.parse(istDate(nowMs))) / DAY_MS)
}

/** An expiry chip: 'Today', or '28 Nov · 1d'. */
export function expiryChip(expiry: string, nowMs: number): string {
  const days = daysTo(expiry, nowMs)
  if (days === 0) return 'Today'
  return days === null ? expiryLabel(expiry) : `${expiryLabel(expiry)} · ${days}d`
}

const two = (n: number) => String(n).padStart(2, '0')
/** `10:42:13` in IST. */
export function istTime(ms: number): string {
  const { hh, mm, ss } = istClock(ms)
  return `${two(hh)}:${two(mm)}:${two(ss)}`
}

export const pollingNote = (ms: number) => `Polling: prices refresh every ${ms / 1000} s.`
export const refreshFailed = (ms: number) => `Couldn't refresh at ${istTime(ms)}. Retrying.`
export const noStrikes = (underlying: string, expiry: string) =>
  `No strikes for ${underlying} ${expiryLabel(expiry)}.`
export const noExpiries = (underlying: string) => `No option expiries for ${underlying}.`

/** "PCR 1.12 · CE OI 1.2Cr · PE OI 1.3Cr": the web's calculatePCR (0 without call OI). */
export function chainTotals(rows: readonly ChainRow[]): { pcr: number; ce: number; pe: number } {
  let ce = 0
  let pe = 0
  for (const r of rows) {
    ce += r.ce?.oi ?? 0
    pe += r.pe?.oi ?? 0
  }
  return { pcr: ce === 0 ? 0 : pe / ce, ce, pe }
}

export const footerLine = (rows: readonly ChainRow[], updatedAt: number): string => {
  const t = chainTotals(rows)
  const oi = `CE OI ${fmtOi(t.ce)} · PE OI ${fmtOi(t.pe)}`
  return `PCR ${fmtPrice(t.pcr)} · ${oi} · Updated ${istTime(updatedAt)}`
}

// --- The chain's read ---------------------------------------------------------------------------

/**
 * The chain query's options (the hook's, and T15's compat cache check, preflight 22). The key
 * holds the expiry, so a reply for an expiry no longer selected lands in its own entry and never
 * renders (RF 3); and `with_greeks`, so it never shares an entry with a tool's (preflight 19).
 */
export function optionChainQuery(
  options: Pick<OptionsData, 'chain'>,
  pid: string,
  q: { target: ChainTarget; expiry: string; count: number; withGreeks: boolean },
) {
  const code = toDdmmmyy(q.expiry) ?? q.expiry
  const { optionsExchange, underlying } = q.target
  return {
    queryKey: qk.optionchain(pid, optionsExchange, underlying, code, q.count, q.withGreeks),
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<OptionChain> =>
      options.chain(
        {
          underlying,
          exchange: optionsExchange,
          expiry_date: code,
          strike_count: q.count,
          with_greeks: q.withGreeks,
        },
        { signal },
      ),
  }
}
