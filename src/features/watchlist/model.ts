import { z } from 'zod'

export const WatchItemSchema = z.object({ exchange: z.string(), symbol: z.string() })

/** The device-local watchlists (design 7.7). `version` lets a later release migrate the shape. */
export const WatchlistsSchema = z.object({
  version: z.literal(1),
  lists: z.array(z.object({ id: z.string(), name: z.string(), items: z.array(WatchItemSchema) })),
})

export type WatchItem = z.output<typeof WatchItemSchema>
export type Watchlists = z.output<typeof WatchlistsSchema>

export const DEFAULT_WATCHLISTS: Watchlists = {
  version: 1,
  lists: [
    {
      id: 'default',
      name: 'Watchlist',
      items: [
        { exchange: 'NSE', symbol: 'RELIANCE' },
        { exchange: 'NSE', symbol: 'TCS' },
        { exchange: 'NSE', symbol: 'INFY' },
        { exchange: 'NSE', symbol: 'HDFCBANK' },
        { exchange: 'NSE', symbol: 'ICICIBANK' },
        { exchange: 'NSE', symbol: 'SBIN' },
        { exchange: 'NSE_INDEX', symbol: 'NIFTY' },
      ],
    },
  ],
}
