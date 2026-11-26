// Tick-size rules, ported from openalgo frontend/src/lib/trading/format.ts:11-42 (tickSize,
// tickDecimals, snapTick, fmtPrice) and terminal.ts:920-923 (resolveTick). Display uses toFixed
// and manual Indian grouping, so it reads the same on every platform.
import { isQuoteOnly } from './exchanges'

/** The instrument tick, guarded against an implausibly coarse one (over 1% of the price). */
export function tickSize(tick: number | undefined, refPrice: number): number {
  const t = Number(tick)
  if (!(t > 0)) return 0.05
  if (refPrice > 0 && t > refPrice * 0.01) return 0.05
  return t
}

/** Decimals implied by the tick (0.05 is 2, 0.1 is 1, 1 is 0). */
export function tickDecimals(tick: number | undefined, refPrice: number): number {
  const t = tickSize(tick, refPrice)
  if (t >= 1) return 0
  let d = 0
  let v = t
  while (d < 8 && Math.abs(v - Math.round(v)) > 1e-9) {
    v *= 10
    d++
  }
  return d
}

/** Snap a price to the instrument tick. */
export function snapTick(price: number, tick: number | undefined, refPrice: number): number {
  const t = tickSize(tick, refPrice)
  return Number((Math.round(price / t) * t).toFixed(tickDecimals(tick, refPrice)))
}

/**
 * The tick to format an instrument's prices with. A quote-only exchange is pinned to 0.05
 * (the master contract's index ticks are feed artefacts such as 0.0005); a CDS pair keeps its
 * real four-decimal tick.
 */
export function resolveTick(exchange: string, tickSize: unknown): number {
  if (isQuoteOnly(exchange)) return 0.05
  return Number(tickSize) || 0.05
}

/** Indian digit grouping (12,34,567) of an integer string. */
function groupIndian(intStr: string): string {
  if (intStr.length <= 3) return intStr
  return `${intStr.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${intStr.slice(-3)}`
}

/** A price at the tick's decimals (at least two), with Indian grouping. */
export function fmtTick(n: number, tick: number | undefined, refPrice: number): string {
  const dp = Math.max(2, tickDecimals(tick, refPrice))
  const [ip = '', fp] = Number(n).toFixed(dp).split('.')
  const neg = ip.startsWith('-')
  return `${neg ? '-' : ''}${groupIndian(neg ? ip.slice(1) : ip)}${fp ? `.${fp}` : ''}`
}
