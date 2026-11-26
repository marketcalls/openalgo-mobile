import { SymbolSchema, toMeta } from './meta'

const parse = (data: Record<string, unknown>) =>
  SymbolSchema.parse({ status: 'success', data: { symbol: 'X', exchange: 'NSE', ...data } })

describe('instrument metadata', () => {
  test("the C1 envelope's fixture row", () => {
    const row = parse({
      name: 'RELIANCE',
      symbol: 'RELIANCE',
      instrumenttype: '',
      expiry: '',
      strike: -0.01,
      lotsize: 1,
      tick_size: 0.05,
      token: '2885',
    })
    expect(toMeta(row)).toEqual({
      exchange: 'NSE',
      symbol: 'RELIANCE',
      name: 'RELIANCE',
      lotsize: 1,
      tick: 0.05,
      freezeQty: 0,
      instrumenttype: '',
      expiry: null,
      strike: null,
      quoteOnly: false,
      lots: false,
    })
  })

  test("an empty lotsize is 1 and a null freeze_qty is 0, as the web's Number(x) || 1", () => {
    const m = toMeta(parse({ lotsize: '', freeze_qty: null }))
    expect(m.lotsize).toBe(1)
    expect(m.freezeQty).toBe(0)
    expect(toMeta(parse({ lotsize: '75', freeze_qty: '1800' }))).toMatchObject({
      lotsize: 75,
      freezeQty: 1800,
    })
  })

  test('an index is quote-only, with the 0.05 tick', () => {
    const m = toMeta(parse({ exchange: 'NSE_INDEX', symbol: 'NIFTY', tick_size: 0.0005 }))
    expect(m).toMatchObject({ quoteOnly: true, tick: 0.05, lots: false })
  })

  test('a derivative carries expiry, strike and lots', () => {
    const m = toMeta(
      parse({
        exchange: 'NFO',
        symbol: 'NIFTY30DEC2624000CE',
        expiry: '30-DEC-26',
        strike: '24000',
        instrumenttype: 'CE',
        lotsize: 75,
        tick_size: 0.05,
      }),
    )
    expect(m).toMatchObject({
      expiry: '30-DEC-26',
      strike: 24000,
      instrumenttype: 'CE',
      lots: true,
      quoteOnly: false,
      name: 'NIFTY30DEC2624000CE',
    })
  })

  test('numbers arrive as strings', () => {
    expect(toMeta(parse({ tick_size: '0.0025', exchange: 'CDS' })).tick).toBe(0.0025)
  })

  test('an error envelope does not parse', () => {
    expect(SymbolSchema.safeParse({ status: 'error', message: 'x' }).success).toBe(false)
  })
})
