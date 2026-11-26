import {
  ALL_EXCHANGES,
  defaultProduct,
  exchangeLabel,
  isQuoteOnly,
  productOptionsFor,
  searchExchanges,
  usesLots,
} from './exchanges'

describe('exchange rules (C2, C9)', () => {
  test('labels indices', () => {
    expect(exchangeLabel('NSE_INDEX')).toBe('INDICES')
    expect(exchangeLabel('NFO')).toBe('NFO')
  })

  test('products by segment', () => {
    expect(productOptionsFor('MCX')).toEqual(['MIS', 'NRML'])
    expect(productOptionsFor('NSE')).toEqual(['MIS', 'CNC'])
    expect(productOptionsFor('CRYPTO')).toEqual(['MIS', 'NRML'])
    expect(defaultProduct('NFO')).toBe('NRML')
    expect(defaultProduct('NSE')).toBe('CNC')
  })

  test('lots on derivatives only; four quote-only exchanges', () => {
    expect(usesLots('NFO')).toBe(true)
    expect(usesLots('NSE')).toBe(false)
    for (const ex of ['NSE_INDEX', 'BSE_INDEX', 'MCX_INDEX', 'GLOBAL_INDEX'])
      expect(isQuoteOnly(ex)).toBe(true)
    expect(isQuoteOnly('NSE')).toBe(false)
  })

  test('search exchanges follow the server version', () => {
    const base = searchExchanges('2.0.0.0')
    expect(base).not.toContain('CRYPTO')
    expect(base).not.toContain('NCO')
    expect(searchExchanges(null)).toEqual(base)
    expect(searchExchanges('2.0.0.1')).toEqual([...base, 'CRYPTO'])
    const latest = searchExchanges('2.0.1.0')
    expect(latest).toEqual(expect.arrayContaining(['CRYPTO', 'NCO', 'MCX_INDEX', 'GLOBAL_INDEX']))
    expect(searchExchanges('2.0.0.9')).not.toContain('NCO')
    expect(base).toHaveLength(10)
    for (const ex of latest) expect(ALL_EXCHANGES).toContain(ex)
  })
})
