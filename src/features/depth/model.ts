// The depth ladder's model: rows with their bars, the ticket a level tap opens, and the
// broker-and-exchange pairs that turned out to send 5 levels this session.
import { createStore } from 'zustand/vanilla'
import type { DepthLevel } from '~/core/realtime/protocol'
import type { TicketParams } from '~/market/types'

export type LadderRow = { price: number; quantity: number; orders?: number; share: number }
export type LadderSide = 'bid' | 'ask'

/**
 * After a deeper subscribe goes out, the feed is not judged for this long: the subscribe waits
 * out the socket's debounce, and the 5-level subscription's last ticks can still arrive.
 */
export const CONFIRM_SETTLE_MS = 1500

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

/** `downgradeKey`s whose deeper levels the feed did not deliver; kept until the app restarts. */
export const depthDowngrades = createStore<{
  keys: ReadonlySet<string>
  add(key: string): void
}>()((set, get) => ({
  keys: new Set<string>(),
  add(key) {
    if (!get().keys.has(key)) set({ keys: new Set([...get().keys, key]) })
  },
}))
