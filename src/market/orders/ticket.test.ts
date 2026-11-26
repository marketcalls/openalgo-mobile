import type { InstrumentMeta } from '../instruments/meta'
import {
  initialTicket,
  issueText,
  planOrder,
  type TicketState,
  ticketSummary,
  ticketUnits,
  validateTicket,
} from './ticket'

const FUT: InstrumentMeta = {
  exchange: 'NFO',
  symbol: 'NIFTY30DEC26FUT',
  name: 'NIFTY',
  lotsize: 65,
  tick: 0.1,
  freezeQty: 1800,
  instrumenttype: 'FUTIDX',
  expiry: '30-DEC-26',
  strike: null,
  quoteOnly: false,
  lots: true,
}

const RELIANCE: InstrumentMeta = {
  exchange: 'NSE',
  symbol: 'RELIANCE',
  name: 'RELIANCE INDUSTRIES LTD',
  lotsize: 1,
  tick: 0.05,
  freezeQty: 0,
  instrumenttype: 'EQ',
  expiry: null,
  strike: null,
  quoteOnly: false,
  lots: false,
}

const NIFTY_INDEX: InstrumentMeta = {
  ...RELIANCE,
  exchange: 'NSE_INDEX',
  symbol: 'NIFTY',
  name: 'NIFTY 50',
  instrumenttype: '',
  quoteOnly: true,
}

const fut = (o: Partial<TicketState> = {}): TicketState => ({
  exchange: 'NFO',
  symbol: 'NIFTY30DEC26FUT',
  action: 'BUY',
  product: 'NRML',
  pricetype: 'MARKET',
  qty: 2,
  ...o,
})

const rel = (o: Partial<TicketState> = {}): TicketState => ({
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'BUY',
  product: 'CNC',
  pricetype: 'MARKET',
  qty: 10,
  ...o,
})

const SPLIT = { splitAvailable: true }
const NO_SPLIT = { splitAvailable: false }

describe('units (terminal.ts:955-958)', () => {
  test('lots times the lot size on a derivative, units elsewhere', () => {
    expect(ticketUnits(fut({ qty: 2 }), FUT)).toBe(130)
    expect(ticketUnits(rel({ qty: 10 }), RELIANCE)).toBe(10)
  })

  test('at least one whole lot, as the web sizes it', () => {
    expect(ticketUnits(fut({ qty: 0 }), FUT)).toBe(65)
    expect(ticketUnits(fut({ qty: Number.NaN }), FUT)).toBe(65)
  })
})

describe('freeze splits (terminal.ts:7080, split_order_service.py:203-209)', () => {
  test('2 lots is 130 units: one order', () => {
    const plan = planOrder(fut({ qty: 2 }), FUT)
    expect(plan.kind).toBe('single')
    expect(plan.spec.quantity).toBe(130)
    expect(validateTicket(fut({ qty: 2 }), FUT, undefined, NO_SPLIT)).toEqual([])
  })

  test('28 lots is 1,820 units: whole lots of 1,755 below the freeze, then 65', () => {
    const plan = planOrder(fut({ qty: 28 }), FUT)
    expect(plan).toEqual({
      kind: 'split',
      spec: expect.objectContaining({ quantity: 1820 }),
      splitsize: 1755,
      orders: 2,
      children: [1755, 65],
    })
    expect(validateTicket(fut({ qty: 28 }), FUT, undefined, SPLIT)).toEqual([])
  })

  test('the units exactly at the freeze limit go as one order', () => {
    const atFreeze: InstrumentMeta = { ...FUT, freezeQty: 1820 }
    expect(planOrder(fut({ qty: 28 }), atFreeze).kind).toBe('single')
  })

  test('a freeze limit under one lot still splits by whole lots', () => {
    const tiny: InstrumentMeta = { ...FUT, freezeQty: 50 }
    const plan = planOrder(fut({ qty: 2 }), tiny)
    expect(plan).toMatchObject({ kind: 'split', splitsize: 65, children: [65, 65] })
  })

  test('2,700 lots is exactly 100 children, which OpenAlgo allows', () => {
    const plan = planOrder(fut({ qty: 2700 }), FUT)
    if (plan.kind !== 'split') throw new Error('expected a split')
    expect(plan.orders).toBe(100)
    expect(plan.children).toHaveLength(100)
    expect(plan.children.every((c) => c === 1755)).toBe(true)
    expect(validateTicket(fut({ qty: 2700 }), FUT, undefined, SPLIT)).toEqual([])
  })

  test('2,701 lots needs 101 orders: split_too_large', () => {
    const t = fut({ qty: 2701 })
    const plan = planOrder(t, FUT)
    if (plan.kind !== 'split') throw new Error('expected a split')
    expect(plan.orders).toBe(101)
    expect(validateTicket(t, FUT, undefined, SPLIT)).toEqual(['split_too_large'])
    expect(issueText('split_too_large', { ticket: t, meta: FUT })).toBe(
      'This needs 101 orders; OpenAlgo splits into 100 at most. Reduce the quantity.',
    )
  })

  test('a split the server would refuse lists no children, however large the quantity', () => {
    const t = fut({ qty: 999_999_999 })
    const plan = planOrder(t, FUT)
    if (plan.kind !== 'split') throw new Error('expected a split')
    expect(plan.orders).toBe(37_037_037)
    expect(plan.children).toEqual([])
    expect(validateTicket(t, FUT, undefined, SPLIT)).toEqual(['split_too_large'])
    expect(issueText('split_too_large', { ticket: t, meta: FUT })).toBe(
      'This needs 3,70,37,037 orders; OpenAlgo splits into 100 at most. Reduce the quantity.',
    )
  })

  test('a freeze of 0 (unknown) or 1 never splits', () => {
    for (const freezeQty of [0, 1]) {
      const meta: InstrumentMeta = { ...RELIANCE, freezeQty }
      const t = rel({ qty: 100_000 })
      expect(planOrder(t, meta)).toEqual({
        kind: 'single',
        spec: expect.objectContaining({ quantity: 100_000 }),
      })
      expect(validateTicket(t, meta, undefined, NO_SPLIT)).toEqual([])
    }
  })

  test('without the split endpoint an order above the freeze is refused', () => {
    const t = fut({ qty: 28 })
    expect(validateTicket(t, FUT, undefined, NO_SPLIT)).toEqual(['split_unavailable'])
    expect(issueText('split_unavailable', { ticket: t, meta: FUT })).toBe(
      'Above the freeze limit of 1,800. Reduce the quantity.',
    )
  })
})

describe('stop side (terminal.ts:2229-2233)', () => {
  const sl = (action: 'BUY' | 'SELL', trigger: number) =>
    rel({ action, pricetype: 'SL', price: trigger, trigger })

  test('a BUY stop at or below LTP is on the wrong side', () => {
    expect(validateTicket(sl('BUY', 1420), RELIANCE, 1424, NO_SPLIT)).toEqual(['stop_side'])
    expect(validateTicket(sl('BUY', 1424), RELIANCE, 1424, NO_SPLIT)).toEqual(['stop_side'])
    expect(validateTicket(sl('BUY', 1425), RELIANCE, 1424, NO_SPLIT)).toEqual([])
  })

  test('a SELL stop must be below LTP', () => {
    expect(validateTicket(sl('SELL', 1425), RELIANCE, 1424, NO_SPLIT)).toEqual(['stop_side'])
    expect(validateTicket(sl('SELL', 1420), RELIANCE, 1424, NO_SPLIT)).toEqual([])
  })

  test('SL-M is checked the same way', () => {
    const t = rel({ action: 'BUY', pricetype: 'SL-M', trigger: 1420 })
    expect(validateTicket(t, RELIANCE, 1424, NO_SPLIT)).toEqual(['stop_side'])
  })

  test('with no LTP the side is not checked', () => {
    expect(validateTicket(sl('BUY', 1420), RELIANCE, undefined, NO_SPLIT)).toEqual([])
    expect(validateTicket(sl('BUY', 1420), RELIANCE, 0, NO_SPLIT)).toEqual([])
  })

  test('the copy names the side and the LTP at the tick', () => {
    const ctx = (action: 'BUY' | 'SELL') => ({
      ticket: sl(action, 1420),
      meta: RELIANCE,
      ltp: 1424,
    })
    expect(issueText('stop_side', ctx('BUY'))).toBe('BUY stop must be above LTP 1,424.00.')
    expect(issueText('stop_side', ctx('SELL'))).toBe('SELL stop must be below LTP 1,424.00.')
  })
})

describe('prices (sandbox/order_manager.py:1437-1450)', () => {
  test('LIMIT needs a price above 0', () => {
    for (const price of [0, undefined, Number.NaN, -1]) {
      const t = rel({ pricetype: 'LIMIT', price })
      expect(validateTicket(t, RELIANCE, undefined, NO_SPLIT)).toEqual(['price_required'])
    }
    expect(
      validateTicket(rel({ pricetype: 'LIMIT', price: 1424 }), RELIANCE, 1424, NO_SPLIT),
    ).toEqual([])
  })

  test('SL needs both a price and a trigger', () => {
    const t = rel({ pricetype: 'SL', price: 0, trigger: 0 })
    expect(validateTicket(t, RELIANCE, undefined, NO_SPLIT)).toEqual([
      'price_required',
      'trigger_required',
    ])
  })

  test('SL-M without a trigger needs one, and needs no price', () => {
    expect(validateTicket(rel({ pricetype: 'SL-M' }), RELIANCE, 1424, NO_SPLIT)).toEqual([
      'trigger_required',
    ])
  })

  test('MARKET ignores the price and the trigger', () => {
    const t = rel({ pricetype: 'MARKET', price: 0, trigger: -5 })
    expect(validateTicket(t, RELIANCE, 1424, NO_SPLIT)).toEqual([])
    expect(planOrder(t, RELIANCE).spec).toMatchObject({ price: 0, trigger_price: 0 })
  })

  test('the spec carries only the fields its type sends, snapped to the tick', () => {
    expect(
      planOrder(rel({ pricetype: 'LIMIT', price: 1423.93, trigger: 1400 }), RELIANCE).spec,
    ).toMatchObject({ price: 1423.95, trigger_price: 0 })
    expect(
      planOrder(rel({ pricetype: 'SL', price: 1430.02, trigger: 1425.04 }), RELIANCE).spec,
    ).toMatchObject({ price: 1430, trigger_price: 1425.05 })
    expect(
      planOrder(rel({ pricetype: 'SL-M', price: 1430, trigger: 1425.07 }), RELIANCE).spec,
    ).toMatchObject({ price: 0, trigger_price: 1425.05 })
  })

  test('a price or trigger that snaps to 0 is refused: the check reads what is sent', () => {
    // A deep out-of-the-money option on tick 0.05: 0.02 rounds to 0, which the sandbox and
    // brokers refuse, so it must stop at the ticket, not after review.
    const OPT: InstrumentMeta = {
      ...FUT,
      symbol: 'NIFTY30DEC2630000CE',
      tick: 0.05,
      instrumenttype: 'OPTIDX',
      strike: 30000,
    }
    const opt = (o: Partial<TicketState>) => fut({ symbol: OPT.symbol, qty: 1, ...o })
    const LTP = 0.05

    const limit = opt({ pricetype: 'LIMIT', price: 0.02 })
    expect(planOrder(limit, OPT).spec.price).toBe(0)
    expect(validateTicket(limit, OPT, LTP, SPLIT)).toEqual(['price_required'])

    const slm = opt({ action: 'SELL', pricetype: 'SL-M', trigger: 0.02 })
    expect(planOrder(slm, OPT).spec.trigger_price).toBe(0)
    expect(validateTicket(slm, OPT, LTP, SPLIT)).toEqual(['trigger_required'])

    const sl = opt({ action: 'SELL', pricetype: 'SL', price: 0.02, trigger: 0.02 })
    expect(validateTicket(sl, OPT, LTP, SPLIT)).toEqual(['price_required', 'trigger_required'])

    // 0.03 rounds up to one tick, which is sent and allowed.
    const up = opt({ pricetype: 'LIMIT', price: 0.03 })
    expect(planOrder(up, OPT).spec.price).toBe(0.05)
    expect(validateTicket(up, OPT, LTP, SPLIT)).toEqual([])
  })

  test('the copy', () => {
    const ctx = { ticket: rel(), meta: RELIANCE }
    expect(issueText('price_required', ctx)).toBe('Enter a price above 0.')
    expect(issueText('trigger_required', ctx)).toBe('Enter a trigger price above 0.')
  })
})

describe('quantity', () => {
  test('a quantity under 1, or not whole, is refused', () => {
    for (const qty of [0, -1, 1.5, Number.NaN]) {
      expect(validateTicket(rel({ qty }), RELIANCE, undefined, NO_SPLIT)).toEqual(['qty'])
      expect(validateTicket(fut({ qty }), FUT, undefined, SPLIT)).toEqual(['qty'])
    }
    expect(issueText('qty', { ticket: rel({ qty: 0 }), meta: RELIANCE })).toBe(
      'Enter a quantity of at least 1.',
    )
  })
})

describe('instrument and product', () => {
  test('an index is quote-only, and nothing else is reported', () => {
    const t: TicketState = {
      exchange: 'NSE_INDEX',
      symbol: 'NIFTY',
      action: 'BUY',
      product: 'NRML',
      pricetype: 'LIMIT',
      qty: 0,
    }
    expect(validateTicket(t, NIFTY_INDEX, 24000, SPLIT)).toEqual(['quote_only'])
    expect(validateTicket(t, 'unknown', 24000, SPLIT)).toEqual(['quote_only'])
    expect(issueText('quote_only', { ticket: t, meta: NIFTY_INDEX })).toBe(
      "Indices can't be traded. Open the futures or options contract instead.",
    )
  })

  test('an instrument the server does not list is refused alone', () => {
    const t = fut({ qty: 0, pricetype: 'LIMIT' })
    expect(validateTicket(t, 'unknown', undefined, SPLIT)).toEqual(['unknown_instrument'])
    expect(issueText('unknown_instrument', { ticket: t, meta: 'unknown' })).toBe(
      "This symbol isn't on the server's list (expired or misspelt).",
    )
  })

  test('NRML on NSE and CNC on NFO are not offered', () => {
    const nrml = rel({ product: 'NRML' })
    expect(validateTicket(nrml, RELIANCE, undefined, NO_SPLIT)).toEqual(['product'])
    expect(issueText('product', { ticket: nrml, meta: RELIANCE })).toBe(
      "NRML isn't available on NSE.",
    )
    expect(validateTicket(fut({ product: 'CNC' }), FUT, undefined, SPLIT)).toEqual(['product'])
    expect(validateTicket(fut({ product: 'MIS' }), FUT, undefined, SPLIT)).toEqual([])
  })
})

describe('initial tickets', () => {
  test('the holdings Sell preset', () => {
    const t = initialTicket(
      {
        exchange: 'NSE',
        symbol: 'RELIANCE',
        action: 'SELL',
        product: 'CNC',
        pricetype: 'MARKET',
        quantity: 10,
      },
      RELIANCE,
    )
    expect(t).toEqual({
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'SELL',
      product: 'CNC',
      pricetype: 'MARKET',
      qty: 10,
    })
  })

  test('a bid level price is snapped to the tick', () => {
    const t = initialTicket(
      { exchange: 'NSE', symbol: 'RELIANCE', action: 'SELL', pricetype: 'LIMIT', price: 1423.93 },
      RELIANCE,
    )
    expect(t.price).toBe(1423.95)
    expect(t.pricetype).toBe('LIMIT')
  })

  test('a stop link opens as SL with the price and the trigger on the tick', () => {
    const t = initialTicket(
      { exchange: 'NSE', symbol: 'RELIANCE', action: 'SELL', price: 1419.93, trigger: 1421.03 },
      RELIANCE,
    )
    expect(t).toMatchObject({ pricetype: 'SL', price: 1419.95, trigger: 1421.05 })
    // a trigger alone is an SL with no price yet, which the ticket's own rules then ask for
    const only = initialTicket(
      { exchange: 'NSE', symbol: 'RELIANCE', action: 'SELL', trigger: 1400 },
      RELIANCE,
    )
    expect(only).toMatchObject({ pricetype: 'SL', trigger: 1400 })
    expect(only.price).toBeUndefined()
    expect(validateTicket(only, RELIANCE, undefined, SPLIT)).toEqual(['price_required'])
  })

  test('a named type wins over the trigger default', () => {
    const t = initialTicket(
      { exchange: 'NSE', symbol: 'RELIANCE', action: 'SELL', pricetype: 'SL-M', trigger: 1400 },
      RELIANCE,
    )
    expect(t).toMatchObject({ pricetype: 'SL-M', trigger: 1400 })
  })

  test('a derivative quantity in units becomes lots', () => {
    const t = initialTicket(
      { exchange: 'NFO', symbol: 'NIFTY30DEC26FUT', action: 'BUY', quantity: 130 },
      FUT,
    )
    expect(t.qty).toBe(2)
    expect(ticketUnits(t, FUT)).toBe(130)
    expect(
      initialTicket(
        { exchange: 'NFO', symbol: 'NIFTY30DEC26FUT', action: 'BUY', quantity: 20 },
        FUT,
      ).qty,
    ).toBe(1)
  })

  test('defaults: MARKET, one lot or one share, the segment default product', () => {
    expect(
      initialTicket({ exchange: 'NFO', symbol: 'NIFTY30DEC26FUT', action: 'BUY' }, FUT),
    ).toEqual({
      exchange: 'NFO',
      symbol: 'NIFTY30DEC26FUT',
      action: 'BUY',
      product: 'NRML',
      pricetype: 'MARKET',
      qty: 1,
    })
    expect(
      initialTicket({ exchange: 'NSE', symbol: 'RELIANCE', action: 'BUY' }, RELIANCE),
    ).toMatchObject({ product: 'CNC', pricetype: 'MARKET', qty: 1 })
  })

  test('a product the segment does not offer falls back to its default', () => {
    const p = { exchange: 'NFO', symbol: 'NIFTY30DEC26FUT', action: 'BUY' as const }
    expect(initialTicket({ ...p, product: 'CNC' }, FUT).product).toBe('NRML')
    expect(initialTicket({ ...p, product: 'MIS' }, FUT).product).toBe('MIS')
  })
})

describe('summaries (terminal.ts:2263-2264)', () => {
  test('lots and units on a derivative, with the price at the tick', () => {
    const t = fut({ pricetype: 'LIMIT', price: 24117.3, qty: 2 })
    expect(ticketSummary(t, FUT)).toBe('BUY LIMIT 2L (130) NIFTY30DEC26FUT @ 24,117.30 · NRML')
  })

  test('units on cash, and no price at market', () => {
    const t = rel({ action: 'SELL', pricetype: 'MARKET', price: 1424, qty: 10 })
    expect(ticketSummary(t, RELIANCE)).toBe('SELL MARKET 10 RELIANCE · CNC')
  })

  test('stops show the trigger', () => {
    expect(
      ticketSummary(rel({ pricetype: 'SL', price: 1430, trigger: 1425, qty: 1500 }), RELIANCE),
    ).toBe('BUY SL 1,500 RELIANCE @ 1,430.00 trigger 1,425.00 · CNC')
    expect(ticketSummary(rel({ action: 'SELL', pricetype: 'SL-M', trigger: 1420 }), RELIANCE)).toBe(
      'SELL SL-M 10 RELIANCE @ 1,420.00 · CNC',
    )
  })

  test('the summary shows what is sent: the snapped price and the whole order', () => {
    const t = fut({ pricetype: 'LIMIT', price: 24117.27, qty: 28 })
    expect(ticketSummary(t, FUT)).toBe('BUY LIMIT 28L (1,820) NIFTY30DEC26FUT @ 24,117.30 · NRML')
  })
})
