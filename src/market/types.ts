export type Side = 'BUY' | 'SELL'
export type Product = 'MIS' | 'CNC' | 'NRML'
export type PriceType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'

/** What a link into the ticket can preset. `quantity` is in units, whatever the exchange. */
export type TicketParams = {
  exchange: string
  symbol: string
  action: Side
  pricetype?: PriceType
  price?: number
  product?: Product
  quantity?: number
}

export const SIDES: readonly Side[] = ['BUY', 'SELL']
export const PRODUCTS: readonly Product[] = ['MIS', 'CNC', 'NRML']
export const PRICE_TYPES: readonly PriceType[] = ['MARKET', 'LIMIT', 'SL', 'SL-M']
