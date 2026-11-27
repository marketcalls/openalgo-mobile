// The device-local Strategy Portfolio's shapes (design 7.8): the frontend's own
// (`api/strategy-portfolio.ts`), checked against it by src/dom/routes/portfolio.ts. The server
// keeps a leg as a JSON blob and the frontend keeps its legs loose, so a leg may carry fields
// this file does not name, and they are stored and read back as given.
import { z } from 'zod'

export const WATCHLISTS = ['mytrades', 'simulation'] as const
/** The strategies the phone keeps; one AsyncStorage value holds them all. */
export const MAX_STRATEGIES = 500
/** The legs of one strategy. */
export const MAX_LEGS = 50

/** A number the page may have sent as null (JSON.stringify turns NaN into null); null is "absent". */
const maybe = <S extends z.ZodType>(s: S) =>
  z.union([s, z.null().transform(() => undefined)]).optional()

export const PortfolioLegSchema = z.looseObject({
  id: maybe(z.string()),
  segment: z.enum(['OPTION', 'FUTURE']),
  side: z.enum(['BUY', 'SELL']),
  lots: z.number(),
  lotSize: z.number(),
  expiry: z.string(),
  strike: maybe(z.number()),
  optionType: maybe(z.enum(['CE', 'PE'])),
  price: z.number(),
  iv: maybe(z.number()),
  active: maybe(z.boolean()),
  symbol: z.string(),
  exitPrice: maybe(z.number()),
})

const Watchlist = z.enum(WATCHLISTS)

export const PortfolioEntrySchema = z.object({
  id: z.int().min(1),
  watchlist: Watchlist,
  name: z.string(),
  underlying: z.string(),
  exchange: z.string(),
  expiry: z.string().nullable(),
  legs: z.array(PortfolioLegSchema),
  notes: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
})

/** What a page sends to save: the entry less what the store sets. */
export const PortfolioSavePayloadSchema = z.object({
  name: z.string(),
  watchlist: Watchlist,
  underlying: z.string(),
  exchange: z.string(),
  expiry: maybe(z.string()),
  legs: z.array(PortfolioLegSchema).min(1).max(MAX_LEGS),
  notes: maybe(z.string()),
})

export type Watchlist = (typeof WATCHLISTS)[number]
export type PortfolioLeg = z.output<typeof PortfolioLegSchema>
export type PortfolioEntry = z.output<typeof PortfolioEntrySchema>
export type PortfolioSavePayload = z.output<typeof PortfolioSavePayloadSchema>

const KEY = /^api_?key$/i

/** `v` less every key named apikey or api_key, at any depth. */
export function stripKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripKeys) as T
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (!KEY.test(k)) out[k] = stripKeys(x)
    return out as T
  }
  return v
}
