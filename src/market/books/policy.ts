// How often the books refresh on their own (design 7.6): rarely while the feed carries order
// events, every 5 s while orders are working without them. Which brokers emit events is contract
// C7. Pure: the hooks pass the feed's, the broker's and the book's facts in.
import { isAnyMarketOpen, isExchangeOpen } from '~/core/realtime/marketHours'
import { POLL_RATES } from '~/core/realtime/polling'
import type { FeedState } from '~/core/realtime/types'
import type { ConnectionState } from '~/core/services/connection'
import { isWorking, type OrderRow } from './schemas'

// services/order_update_service.py at openalgo c8b2896.
/** Adapters that push order updates (:36-95). */
const PUSHED = [
  'aliceblue',
  'angel',
  'arrow',
  'definedge',
  'dhan',
  'flattrade',
  'fyers',
  'groww',
  'iiflcapital',
  'indmoney',
  'kotak',
  'motilal',
  'nubra',
  'nuvama',
  'pocketful',
  'sahi',
  'shoonya',
  'tradejini',
  'tradesmart',
  'upstox',
  'zebu',
  'zerodha',
]
/** Brokers the server itself polls every 5 s, then emits for (:113). */
const SERVER_POLLED = ['fivepaisa', 'samco']

/** The 24 brokers whose orders produce `order_update` events. */
export const ORDER_EVENT_BROKERS: readonly string[] = [...PUSHED, ...SERVER_POLLED]

/** The 15 brokers that produce none: their books are polled. */
export const NO_ORDER_EVENT_BROKERS: readonly string[] = [
  'compositedge',
  'deltaexchange',
  'dhan_sandbox',
  'firstock',
  'fivepaisaxts',
  'hdfcsecurities',
  'hdfcsky',
  'ibulls',
  'iifl',
  'jainamxts',
  'mstock',
  'paytm',
  'rmoney',
  'rupeezy',
  'wisdom',
]

const EVENTED = new Set(ORDER_EVENT_BROKERS)

/** Whether the broker emits order events; an unknown broker, or none named yet, does not. */
export const hasOrderEvents = (broker: string | null): boolean =>
  broker !== null && EVENTED.has(broker)

/** The feed is live and acknowledged `subscribe_orders` (2.0.1.6+), so events can arrive. */
export const streamLive = (feed: FeedState, orderStream: boolean | null): boolean =>
  feed === 'live' && orderStream === true

export type EventedInput = {
  streamLive: boolean
  broker: string | null
  analyzer: ConnectionState['analyzer']
  /** No event came for one of the app's own orders this session (RF 3). */
  demoted: boolean
}

/** Order events can be relied on: the sandbox emits them in analyzer mode for every broker (C7). */
export const isEvented = (i: EventedInput): boolean =>
  i.streamLive && !i.demoted && (hasOrderEvents(i.broker) || i.analyzer === 'analyze')

/** The wait between book polls, slower while no market the books depend on is open. */
export function bookPollMs(i: EventedInput & { anyWorking: boolean; marketOpen: boolean }): number {
  const base = isEvented(i)
    ? POLL_RATES.orderbookIdle
    : i.anyWorking
      ? POLL_RATES.orderbookWorking
      : POLL_RATES.orderbookIdle
  return i.marketOpen ? base : base * POLL_RATES.offHoursFactor
}

/**
 * Whether the books can change now: a working order's market is open, else (nothing working) a
 * market of any of the day's orders, else (no orders) any market at all.
 */
export function booksMarketOpen(
  orders: readonly Pick<OrderRow, 'exchange' | 'status'>[],
  now: number,
): boolean {
  const working = orders.filter(isWorking)
  const rows = working.length > 0 ? working : orders
  if (rows.length === 0) return isAnyMarketOpen(now)
  return rows.some((o) => isExchangeOpen(o.exchange, now))
}
