import {
  backupHref,
  chartHref,
  depthHref,
  gttHref,
  gttModifyHref,
  instrumentHref,
  modifyHref,
  optionChainHref,
  ordersHref,
  parseGttParams,
  parseKey,
  parseModifyParams,
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
    const hrefs = [
      instrumentHref('NSE', sym),
      depthHref('NSE', sym),
      chartHref('NSE', sym),
      optionChainHref('NSE', sym),
    ]
    for (const href of hrefs) {
      expect(parseKey(lastSegment(href))).toEqual({ exchange: 'NSE', symbol: sym })
    }
  })

  test('the segment is the encoded exchange:symbol', () => {
    expect(instrumentHref('NSE', 'M&M')).toBe('/instrument/NSE%3AM%26M')
    expect(depthHref('NFO', 'NIFTY30DEC2624000CE')).toBe('/depth/NFO%3ANIFTY30DEC2624000CE')
    expect(chartHref('NSE', 'SBIN')).toBe('/chart/NSE%3ASBIN')
    expect(optionChainHref('NSE_INDEX', 'NIFTY')).toBe('/optionchain/NSE_INDEX%3ANIFTY')
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

  test('ticket links round-trip source=chart and trigger', () => {
    const p = {
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'SELL' as const,
      price: 1419.9,
      trigger: 1421,
      source: 'chart' as const,
    }
    const href = ticketHref(p)
    expect(query(href)).toMatchObject({ source: 'chart', trigger: '1421' })
    expect(parseTicketParams(query(href))).toEqual(p)
    // neither is written when unset
    expect(query(ticketHref({ exchange: 'NSE', symbol: 'SBIN', action: 'BUY' }))).toEqual({
      exchange: 'NSE',
      symbol: 'SBIN',
      action: 'BUY',
    })
  })

  test('a ticket link with a bad source or trigger does not parse', () => {
    const base = { exchange: 'NSE', symbol: 'SBIN', action: 'BUY' }
    for (const bad of [{ source: 'web' }, { trigger: '0' }, { trigger: '-1' }, { trigger: 'x' }]) {
      expect(parseTicketParams({ ...base, ...bad })).toBeNull()
    }
  })

  test('modify links carry a price or trigger preset; a bad preset does not parse', () => {
    expect(modifyHref('1')).toBe('/order/1/modify')
    const href = modifyHref('250408/00 98', { price: 101.5, trigger_price: 100, source: 'chart' })
    expect(href.startsWith('/order/250408%2F00%2098/modify?')).toBe(true)
    expect(parseModifyParams(query(href))).toEqual({
      price: 101.5,
      trigger_price: 100,
      source: 'chart',
    })
    expect(parseModifyParams(query(modifyHref('1', { price: 5 })))).toEqual({ price: 5 })
    // the route's own id param is not a preset, and no preset is an empty one
    expect(parseModifyParams({ id: '1' })).toEqual({})
    expect(parseModifyParams({ id: ['1'], price: ['7'] })).toEqual({ price: 7 })
    for (const bad of [
      { price: 'x' },
      { price: '0' },
      { price: '-2' },
      { trigger_price: 'NaN' },
      { trigger_price: '0' },
      { source: 'web' },
    ]) {
      expect(parseModifyParams({ id: '1', ...bad })).toBeNull()
    }
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
