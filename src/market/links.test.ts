import {
  backupHref,
  chartHref,
  depthHref,
  gttHref,
  gttModifyHref,
  instrumentHref,
  modifyHref,
  ordersHref,
  parseGttParams,
  parseKey,
  parseTicketParams,
  searchHref,
  ticketHref,
  toolHref,
} from './links'

const SYMBOLS = ['M&M', 'BAJAJ-AUTO', 'NIFTY30DEC2624000CE', 'A:B', 'X Y/Z%']

const lastSegment = (href: string) => (href.split('?')[0] ?? '').split('/').pop() ?? ''
const query = (href: string) => Object.fromEntries(new URLSearchParams(href.split('?')[1] ?? ''))

describe('route keys', () => {
  test.each(SYMBOLS)('%s round-trips through every key link', (sym) => {
    for (const href of [instrumentHref('NSE', sym), depthHref('NSE', sym), chartHref('NSE', sym)]) {
      expect(parseKey(lastSegment(href))).toEqual({ exchange: 'NSE', symbol: sym })
    }
  })

  test('the segment is the encoded exchange:symbol', () => {
    expect(instrumentHref('NSE', 'M&M')).toBe('/instrument/NSE%3AM%26M')
    expect(depthHref('NFO', 'NIFTY30DEC2624000CE')).toBe('/depth/NFO%3ANIFTY30DEC2624000CE')
    expect(chartHref('NSE', 'SBIN')).toBe('/chart/NSE%3ASBIN')
  })

  test('parseKey splits at the first colon and rejects what has no two parts', () => {
    expect(parseKey('NSE:A:B')).toEqual({ exchange: 'NSE', symbol: 'A:B' })
    expect(parseKey('NSE')).toBeNull()
    expect(parseKey(':X')).toBeNull()
    expect(parseKey('NSE:')).toBeNull()
    expect(parseKey('%E0%A4%A')).toBeNull() // malformed escape
  })
})

describe('ticket links', () => {
  test('a full set of params round-trips', () => {
    const p = {
      exchange: 'NFO',
      symbol: 'NIFTY30DEC2624000CE',
      action: 'SELL' as const,
      pricetype: 'SL' as const,
      price: 101.5,
      product: 'NRML' as const,
      quantity: 150,
    }
    expect(parseTicketParams(query(ticketHref(p)))).toEqual(p)
  })

  test('only the given params are written, and symbols are encoded', () => {
    const href = ticketHref({ exchange: 'NSE', symbol: 'M&M', action: 'BUY' })
    expect(href.startsWith('/order/new?')).toBe(true)
    expect(href).toContain('symbol=M%26M')
    expect(query(href)).toEqual({ exchange: 'NSE', symbol: 'M&M', action: 'BUY' })
    expect(parseTicketParams(query(href))).toEqual({
      exchange: 'NSE',
      symbol: 'M&M',
      action: 'BUY',
    })
  })

  test('a quote-only exchange parses; validateTicket is what refuses it', () => {
    expect(parseTicketParams({ exchange: 'NSE_INDEX', symbol: 'NIFTY', action: 'BUY' })).toEqual({
      exchange: 'NSE_INDEX',
      symbol: 'NIFTY',
      action: 'BUY',
    })
  })

  test('arrays take the first value', () => {
    expect(
      parseTicketParams({ exchange: ['NSE', 'NFO'], symbol: 'SBIN', action: ['SELL'] }),
    ).toEqual({ exchange: 'NSE', symbol: 'SBIN', action: 'SELL' })
  })

  test.each([
    ['HOLD action', { exchange: 'NSE', symbol: 'SBIN', action: 'HOLD' }],
    ['negative price', { exchange: 'NSE', symbol: 'SBIN', action: 'BUY', price: '-1' }],
    ['unknown exchange', { exchange: 'XYZ', symbol: 'SBIN', action: 'BUY' }],
    ['missing symbol', { exchange: 'NSE', action: 'BUY' }],
    ['missing action', { exchange: 'NSE', symbol: 'SBIN' }],
    ['bad pricetype', { exchange: 'NSE', symbol: 'SBIN', action: 'BUY', pricetype: 'IOC' }],
    ['bad product', { exchange: 'NSE', symbol: 'SBIN', action: 'BUY', product: 'XYZ' }],
    ['text price', { exchange: 'NSE', symbol: 'SBIN', action: 'BUY', price: 'abc' }],
    ['fractional quantity', { exchange: 'NSE', symbol: 'SBIN', action: 'BUY', quantity: '1.5' }],
    ['zero quantity', { exchange: 'NSE', symbol: 'SBIN', action: 'BUY', quantity: '0' }],
  ])('%s gives null', (_n, raw) => {
    expect(parseTicketParams(raw)).toBeNull()
  })

  test('blank optional params count as absent', () => {
    expect(
      parseTicketParams({ exchange: 'NSE', symbol: 'SBIN', action: 'BUY', price: '', product: '' }),
    ).toEqual({ exchange: 'NSE', symbol: 'SBIN', action: 'BUY' })
  })
})

describe('GTT links', () => {
  test('a full set of params round-trips, and the symbol is encoded', () => {
    const p = { exchange: 'NSE', symbol: 'M&M', action: 'SELL' as const, quantity: 25 }
    const href = gttHref(p)
    expect(href.startsWith('/gtt/new?')).toBe(true)
    expect(href).toContain('symbol=M%26M')
    expect(parseGttParams(query(href))).toEqual(p)
  })

  test('only the given params are written; no action parses (the ticket defaults it)', () => {
    const href = gttHref({ exchange: 'NFO', symbol: 'NIFTY30DEC2624000CE' })
    expect(query(href)).toEqual({ exchange: 'NFO', symbol: 'NIFTY30DEC2624000CE' })
    expect(parseGttParams(query(href))).toEqual({
      exchange: 'NFO',
      symbol: 'NIFTY30DEC2624000CE',
    })
  })

  test('arrays take the first value, and blank optional params count as absent', () => {
    expect(
      parseGttParams({ exchange: ['NSE', 'NFO'], symbol: 'SBIN', action: '', quantity: '' }),
    ).toEqual({ exchange: 'NSE', symbol: 'SBIN' })
  })

  test.each([
    ['HOLD action', { exchange: 'NSE', symbol: 'SBIN', action: 'HOLD' }],
    ['unknown exchange', { exchange: 'XYZ', symbol: 'SBIN' }],
    ['missing exchange', { symbol: 'SBIN' }],
    ['missing symbol', { exchange: 'NSE', action: 'BUY' }],
    ['fractional quantity', { exchange: 'NSE', symbol: 'SBIN', quantity: '1.5' }],
    ['zero quantity', { exchange: 'NSE', symbol: 'SBIN', quantity: '0' }],
    ['text quantity', { exchange: 'NSE', symbol: 'SBIN', quantity: 'ten' }],
  ])('%s gives null', (_n, raw) => {
    expect(parseGttParams(raw)).toBeNull()
  })

  test('modify round-trips the trigger id', () => {
    const id = 'GTT-261126-0a1b/2c 3d'
    const href = gttModifyHref(id)
    expect(href).toBe('/gtt/GTT-261126-0a1b%2F2c%203d/modify')
    expect(decodeURIComponent(href.split('/')[2] ?? '')).toBe(id)
  })
})

describe('other links', () => {
  test('search', () => {
    expect(searchHref()).toBe('/search')
    expect(searchHref({})).toBe('/search')
    expect(query(searchHref({ addTo: 'my list&1' }))).toEqual({ addTo: 'my list&1' })
  })

  test('modify round-trips the order id', () => {
    const id = '250408/00 98'
    const href = modifyHref(id)
    expect(href).toBe('/order/250408%2F00%2098/modify')
    expect(decodeURIComponent(href.split('/')[2] ?? '')).toBe(id)
    expect(href.endsWith('/modify')).toBe(true)
  })

  test('tools, orders and backup', () => {
    expect(toolHref('option-chain')).toBe('/tools/option-chain')
    const href = toolHref('option-chain', { u: 'NFO:NIFTY' })
    expect(decodeURIComponent(lastSegment(href.split('?')[0] ?? ''))).toBe('option-chain')
    expect(query(href)).toEqual({ u: 'NFO:NIFTY' })
    expect(ordersHref()).toBe('/orders')
    expect(ordersHref({ segment: 'all' })).toBe('/orders?segment=all')
    expect(ordersHref({ segment: 'gtt' })).toBe('/orders?segment=gtt')
    expect(backupHref()).toBe('/account/backup')
  })
})
