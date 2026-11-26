// Response schemas for the endpoints M1 reads (contract S2, S8, S9). Objects are not
// strict, so extra fields (a broker's, or a fixture's `_source`) are dropped.
import { z } from 'zod'
import { bool, int, num, optNum, str } from './coerce'

/** A success envelope `{status:'success', data}`; the parsed value is its `data`. */
export const envelope = <T extends z.ZodType>(data: T) =>
  // zod cannot resolve a generic shape's output type, so name the one field read here.
  z
    .object({ status: z.literal('success'), data })
    .transform((b) => (b as { data: z.output<T> }).data)

/** `GET /auth/app-info`. Only a string `version` counts; normalizing it is the caller's job. */
export const AppInfoSchema = z.object({ version: z.string(), name: z.string().optional() })

/** `GET /api/v1/swagger.json` as endpoint ids: each `paths` key with its slashes trimmed. */
export const SwaggerSchema = z
  .object({ paths: z.record(z.string(), z.unknown()) })
  .transform((s) => Object.keys(s.paths).map((k) => k.replace(/^\/+|\/+$/g, '')))

export const PingSchema = envelope(z.object({ message: z.string(), broker: str }))

export const FundsSchema = envelope(
  z.object({
    availablecash: optNum,
    collateral: optNum,
    m2mrealized: optNum,
    m2munrealized: optNum,
    utiliseddebits: optNum,
  }),
)

/** `analyzer`, and `analyzer/toggle`, which adds `message`. */
export const AnalyzerSchema = envelope(
  z.object({
    mode: z.enum(['live', 'analyze']),
    analyze_mode: bool,
    total_logs: int.optional(),
    message: z.string().optional(),
  }),
)

const Instrument = z.object({
  symbol: str,
  name: str.nullish(),
  exchange: str,
  token: str.nullish(),
  expiry: str.nullish(),
  strike: optNum,
  lotsize: optNum,
  instrumenttype: str.nullish(),
  tick_size: optNum,
  freeze_qty: optNum,
})
export const SearchSchema = envelope(z.array(Instrument))

const Quote = z.object({
  ltp: optNum,
  prev_close: optNum,
  open: optNum,
  high: optNum,
  low: optNum,
  volume: optNum,
  oi: optNum,
  bid: optNum,
  ask: optNum,
})
export const QuotesSchema = envelope(Quote)

/** multiquotes answers `results`, not `data`. An invalid entry has `error` and no `data`. */
export const MultiQuotesSchema = z
  .object({
    status: z.literal('success'),
    results: z.array(
      z.object({
        symbol: str,
        exchange: str,
        data: Quote.optional(),
        error: z.string().optional(),
      }),
    ),
  })
  .transform((b) => b.results)

/** Brokers pad missing levels with price 0 (S12); the consumer drops them. */
const DepthLevel = z.object({ price: num, quantity: num })
export const DepthSchema = envelope(
  z.object({
    ltp: optNum,
    ltq: optNum,
    open: optNum,
    high: optNum,
    low: optNum,
    prev_close: optNum,
    volume: optNum,
    oi: optNum,
    totalbuyqty: optNum,
    totalsellqty: optNum,
    bids: z.array(DepthLevel),
    asks: z.array(DepthLevel),
  }),
)

export type AppInfo = z.output<typeof AppInfoSchema>
export type Ping = z.output<typeof PingSchema>
export type Funds = z.output<typeof FundsSchema>
export type Analyzer = z.output<typeof AnalyzerSchema>
export type Instrument = z.output<typeof Instrument>
export type Quote = z.output<typeof Quote>
export type MultiQuote = z.output<typeof MultiQuotesSchema>[number]
export type DepthLevel = z.output<typeof DepthLevel>
export type Depth = z.output<typeof DepthSchema>
