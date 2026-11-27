/**
 * @jest-environment jsdom
 */
// The native Option Chain's live merge against the web's own (frontend/src/hooks/
// useOptionChainLive.ts mergeOptionChainMarketData): the same polled chain and the same ticks give
// the same LTPs, books, forward and Greeks. The web module is loaded through a locally typed
// require(): its source fails the app's noUncheckedIndexedAccess (useOptionChainLive.ts:72), so tsc
// never reads it, and this file is outside `depcruise src`. jsdom, because its imports reach the
// browser runtime (MarketDataManager, the page-visibility hook).
import type { Quote } from '~/core/realtime/protocol'
import { liveChain } from '~/market/options/live'
import { type OptionChain, OptionChainSchema } from '~/market/options/schemas'
import { chainReply } from '../helpers/chains'

type WebLevel = { price: number; quantity: number }
/** What the web's MarketDataManager keeps per symbol (lib/MarketDataManager.ts SymbolData). */
type WebSymbolData = {
  data: { ltp?: number; depth?: { buy: WebLevel[]; sell: WebLevel[] } }
  lastUpdate?: number
}
type WebMerge = (
  polled: OptionChain,
  optionExchange: string,
  marketData: Map<string, WebSymbolData>,
  clockOffsetMs: number,
  interestRate?: number,
) => OptionChain

const web = require('@/hooks/useOptionChainLive') as { mergeOptionChainMarketData: WebMerge }

const NOW = Date.UTC(2026, 10, 30, 5, 0) // Mon 30 Nov 2026, 10:30 IST
beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW))
afterEach(() => jest.restoreAllMocks())

/** One tick, in both shapes: the app's store quote and the web manager's symbol data. */
function both(ltp: number, bid: number, ask: number): [Quote, WebSymbolData] {
  const buy = [{ price: bid, quantity: 130 }]
  const sell = [{ price: ask, quantity: 195 }]
  return [
    { ltp, depth: { buy, sell, levels: 1 }, ts: NOW, dir: 0, source: 'ws' },
    { data: { ltp, depth: { buy, sell } }, lastUpdate: NOW },
  ]
}

function scene(ticks: Record<string, [number, number, number]>) {
  const app = new Map<string, Quote>()
  const page = new Map<string, WebSymbolData>()
  for (const [key, [ltp, bid, ask]] of Object.entries(ticks)) {
    const [q, d] = both(ltp, bid, ask)
    app.set(key, q)
    page.set(key, d)
  }
  return { app, page }
}

const chain = OptionChainSchema.parse(chainReply({ spot: 24567.8, each: 12 }))
const sym = (i: number, side: 'ce' | 'pe') => {
  const leg = chain.chain[i]?.[side]
  if (!leg) throw new Error(`no ${side} at ${i}`)
  return `NFO:${leg.symbol}`
}

test.each([
  ['no ticks at all', {}, 0],
  [
    'the underlying and the ATM pair, off the tick grid',
    {
      'NSE_INDEX:NIFTY': [24611.35, 0, 0],
      [sym(12, 'ce')]: [151.23, 151.12, 151.38],
      [sym(12, 'pe')]: [109.98, 109.81, 110.07],
    },
    0,
  ],
  [
    'every leg ticking, a crossed and an empty book among them, the clock 3 min behind',
    {
      'NSE_INDEX:NIFTY': [24480.1, 0, 0],
      ...Object.fromEntries(
        chain.chain.flatMap((r, i) => [
          [sym(i, 'ce'), [r.ce?.ltp ?? 0, (r.ce?.bid ?? 0) - 0.1, (r.ce?.ask ?? 0) + 0.15]],
          [
            sym(i, 'pe'),
            [
              (r.pe?.ltp ?? 0) * 1.01,
              i === 3 ? 12 : (r.pe?.bid ?? 0),
              i === 3 ? 11 : (r.pe?.ask ?? 0),
            ],
          ],
        ]),
      ),
    },
    180_000,
  ],
] as const)(
  'liveChain matches mergeOptionChainMarketData on the same chain and ticks: %s',
  (_, ticks, offset) => {
    const { app, page } = scene(ticks as Record<string, [number, number, number]>)
    const mine = liveChain(chain, (k) => app.get(k), {
      optionsExchange: 'NFO',
      underlyingKey: 'NSE_INDEX:NIFTY',
      clockOffsetMs: offset,
    })
    const theirs = web.mergeOptionChainMarketData(chain, 'NFO', page, offset)
    expect(mine).toEqual(theirs)
    // and it priced something: the ATM call has an IV and a delta
    expect(mine.chain[12]?.ce?.implied_volatility).toBeGreaterThan(0)
    expect(mine.chain[12]?.ce?.delta).toBeGreaterThan(0)
  },
)
