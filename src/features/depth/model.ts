// The depth ladder's model: rows with their bars, the ticket a level tap opens, and the timing
// of the level check and of a book that does not come. The session's downgraded broker and
// exchange pairs live on `Trading`, one set per services container.
import { POLL_RATES } from '~/core/realtime/polling'
import type { DepthLevel } from '~/core/realtime/protocol'
import type { TicketParams } from '~/market/types'

export type LadderRow = { price: number; quantity: number; orders?: number; share: number }
export type LadderSide = 'bid' | 'ask'

/**
 * After a deeper subscribe goes out, the feed is not judged for this long: the subscribe waits
 * out the socket's debounce, and the 5-level subscription's last ticks can still arrive.
 */
export const CONFIRM_SETTLE_MS = 1500

/**
 * Ruling 10 judges the first two socket depth ticks after the subscribe. With them in, the
 * verdict is final, so the check keeps no later tick until the next subscribe.
 */
export const LEVEL_TICKS = 2

/**
 * With the feed not live, a book that has not come in this long is a read error (design 7.11).
 * The slowest depth poll (a tunnel while the market is closed) comes every 25 s, so this is two
 * of those: the first poll has a whole interval to reply. Failing polls show sooner, through the
 * polling engine's health.
 */
export const NO_BOOK_MS = 2 * POLL_RATES.depth.tunnel * POLL_RATES.offHoursFactor

const rowsOf = (levels: readonly DepthLevel[], n: number): LadderRow[] => {
  const shown = levels.slice(0, n)
  const top = Math.max(0, ...shown.map((l) => l.quantity))
  return shown.map((l) => ({
    price: l.price,
    quantity: l.quantity,
    ...(l.orders !== undefined ? { orders: l.orders } : {}),
    share: top > 0 ? l.quantity / top : 0,
  }))
}

/** Up to `n` levels a side; `share` is a level's quantity over the largest on its side. */
export function ladderRows(
  depth: { buy: readonly DepthLevel[]; sell: readonly DepthLevel[] } | undefined,
  n: number,
): { bids: LadderRow[]; asks: LadderRow[] } {
  return { bids: rowsOf(depth?.buy ?? [], n), asks: rowsOf(depth?.sell ?? [], n) }
}

/** A tapped level presets a LIMIT at its price: a bid is someone to sell to, an ask to buy from. */
export function levelTicket(
  side: LadderSide,
  price: number,
  exchange: string,
  symbol: string,
): TicketParams {
  return { exchange, symbol, action: side === 'bid' ? 'SELL' : 'BUY', pricetype: 'LIMIT', price }
}
