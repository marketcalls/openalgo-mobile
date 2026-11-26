// The price actions of a long press on the chart (design 7.9.6), as the web terminal's chart menu
// offers them (frontend/src/lib/trading/terminal.ts:7685-7716 at c8b2896; preflight conflict 28):
// a limit only on the side where it rests (BUY below the LTP, SELL above), a stop only where it
// can trigger (BUY above, SELL below). Each opens the ticket preset at the pressed price, sent as
// 'mobile-chart'; none places an order. A stop is SL with its price and trigger both at the
// pressed price, as the web places it (terminal.ts:2273-2274).
import type { Inst } from '~/dom/bridge/protocol'
import type { Side, TicketParams } from '../types'

export type PriceActionId = 'buy-limit' | 'sell-limit' | 'buy-stop' | 'sell-stop'

export type PriceAction = {
  id: PriceActionId
  label: string
  params: TicketParams
  /** Written out in full: the e2e id check greps for each literal. */
  testID: string
}

const ACTIONS: Record<PriceActionId, { label: string; testID: string; side: Side; stop: boolean }> =
  {
    'buy-limit': { label: 'Buy limit', testID: 'chart-price-buy-limit', side: 'BUY', stop: false },
    'sell-limit': {
      label: 'Sell limit',
      testID: 'chart-price-sell-limit',
      side: 'SELL',
      stop: false,
    },
    'buy-stop': { label: 'Buy stop', testID: 'chart-price-buy-stop', side: 'BUY', stop: true },
    'sell-stop': { label: 'Sell stop', testID: 'chart-price-sell-stop', side: 'SELL', stop: true },
  }

/**
 * The actions at `price` (already on the tick), for `units` (one lot of a derivative). Without
 * an LTP the side cannot be told, so only the two limits; at the LTP itself no limit rests and no
 * stop can trigger, so none (the web disables them all); an index trades nothing.
 */
export function priceActions(o: {
  inst: Inst
  price: number
  ltp: number | null
  quoteOnly: boolean
  units: number
}): PriceAction[] {
  if (o.quoteOnly) return []
  const ltp = o.ltp !== null && o.ltp > 0 ? o.ltp : null
  const ids: PriceActionId[] =
    ltp === null
      ? ['buy-limit', 'sell-limit']
      : o.price > ltp
        ? ['sell-limit', 'buy-stop']
        : o.price < ltp
          ? ['buy-limit', 'sell-stop']
          : []
  return ids.map((id) => {
    const a = ACTIONS[id]
    const params: TicketParams = {
      exchange: o.inst.exchange,
      symbol: o.inst.symbol,
      action: a.side,
      pricetype: a.stop ? 'SL' : 'LIMIT',
      price: o.price,
      ...(a.stop ? { trigger: o.price } : {}),
      quantity: o.units,
      source: 'chart',
    }
    return { id, label: a.label, params, testID: a.testID }
  })
}
