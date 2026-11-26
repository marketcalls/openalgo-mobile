export type Side = 'BUY' | 'SELL'
export type Product = 'MIS' | 'CNC' | 'NRML'
export type PriceType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'

/** The strategy label of a write: 'mobile-chart' for one that starts on the chart (design 7.10). */
export type Strategy = 'mobile' | 'mobile-chart'

/**
 * What a link into the ticket can preset. `quantity` is in units, whatever the exchange.
 * `trigger` alone opens an SL; `source: 'chart'` sends the order as 'mobile-chart'.
 */
export type TicketParams = {
  exchange: string
  symbol: string
  action: Side
  pricetype?: PriceType
  price?: number
  product?: Product
  quantity?: number
  trigger?: number
  source?: 'chart'
}

export const SIDES: readonly Side[] = ['BUY', 'SELL']
export const PRODUCTS: readonly Product[] = ['MIS', 'CNC', 'NRML']
export const PRICE_TYPES: readonly PriceType[] = ['MARKET', 'LIMIT', 'SL', 'SL-M']
