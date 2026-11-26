import { priceActions } from './priceActions'

const RELIANCE = { exchange: 'NSE', symbol: 'RELIANCE' }
const at = (price: number, ltp: number | null, o: { quoteOnly?: boolean; units?: number } = {}) =>
  priceActions({ inst: RELIANCE, price, ltp, quoteOnly: o.quoteOnly ?? false, units: o.units ?? 1 })
const ids = (a: ReturnType<typeof priceActions>) => a.map((x) => x.id)

test('price actions above and below LTP, without LTP, and for quote-only', () => {
  // above: a SELL limit rests there, a BUY stop triggers there (preflight conflict 28)
  const above = at(1410, 1400)
  expect(ids(above)).toEqual(['sell-limit', 'buy-stop'])
  // below: a BUY limit rests, a SELL stop triggers
  expect(ids(at(1390, 1400))).toEqual(['buy-limit', 'sell-stop'])
  // no LTP to tell the side: the two limits
  expect(ids(at(1390, null))).toEqual(['buy-limit', 'sell-limit'])
  // at the LTP no limit rests and no stop can trigger, as the web's menu disables them all
  expect(at(1400, 1400)).toEqual([])
  // an index trades nothing
  expect(at(1410, 1400, { quoteOnly: true })).toEqual([])
  expect(at(1410, null, { quoteOnly: true })).toEqual([])

  // a limit presets its price; a stop is SL with price and trigger both at it (terminal.ts:2273-2274)
  expect(above).toEqual([
    {
      id: 'sell-limit',
      label: 'Sell limit',
      testID: 'chart-price-sell-limit',
      params: {
        exchange: 'NSE',
        symbol: 'RELIANCE',
        action: 'SELL',
        pricetype: 'LIMIT',
        price: 1410,
        quantity: 1,
        source: 'chart',
      },
    },
    {
      id: 'buy-stop',
      label: 'Buy stop',
      testID: 'chart-price-buy-stop',
      params: {
        exchange: 'NSE',
        symbol: 'RELIANCE',
        action: 'BUY',
        pricetype: 'SL',
        price: 1410,
        trigger: 1410,
        quantity: 1,
        source: 'chart',
      },
    },
  ])
  const below = at(1390, 1400, { units: 65 })
  expect(below.map((a) => [a.testID, a.label, a.params.action, a.params.quantity])).toEqual([
    ['chart-price-buy-limit', 'Buy limit', 'BUY', 65],
    ['chart-price-sell-stop', 'Sell stop', 'SELL', 65],
  ])
  expect(below[1]?.params).toMatchObject({ pricetype: 'SL', price: 1390, trigger: 1390 })
  // every action opens a ticket sent as 'mobile-chart'
  for (const a of [...above, ...below, ...at(1390, null)]) expect(a.params.source).toBe('chart')
})
