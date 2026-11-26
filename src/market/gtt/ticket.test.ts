import type { InstrumentMeta } from '../instruments/meta'
import { GttBookSchema, type GttRow } from './schemas'
import {
  type GttIssue,
  type GttTicketState,
  gttIssueText,
  gttSummary,
  gttTicketFromRow,
  initialGttTicket,
  planGtt,
  validateGtt,
} from './ticket'

const RELIANCE: InstrumentMeta = {
  exchange: 'NSE',
  symbol: 'RELIANCE',
  name: 'RELIANCE INDUSTRIES',
  lotsize: 1,
  tick: 0.05,
  freezeQty: 0,
  instrumenttype: 'EQ',
  expiry: null,
  strike: null,
  quoteOnly: false,
  lots: false,
}

const FUT = 'NIFTY30DEC26FUT'
const NIFTY_FUT: InstrumentMeta = {
  exchange: 'NFO',
  symbol: FUT,
  name: 'NIFTY',
  lotsize: 65,
  tick: 0.1,
  freezeQty: 1800,
  instrumenttype: 'FUT',
  expiry: '30-DEC-26',
  strike: null,
  quoteOnly: false,
  lots: true,
}

const single = (o: Partial<GttTicketState> = {}): GttTicketState => ({
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'SELL',
  type: 'SINGLE',
  qty: 1,
  trigger: 1500,
  price: 1499,
  ...o,
})

const oco = (o: Partial<GttTicketState> = {}): GttTicketState => ({
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'SELL',
  type: 'OCO',
  qty: 1,
  slTrigger: 1300,
  slPrice: 1299,
  tgTrigger: 1500,
  tgPrice: 1501,
  ...o,
})

/** One G4 row, parsed as the book reads it. */
const rowOf = (raw: Record<string, unknown>): GttRow => {
  const [row] = GttBookSchema.parse({ status: 'success', data: [raw] }).rows
  if (!row) throw new Error('the row did not parse')
  return row
}

const KITE_SINGLE = {
  trigger_id: '112127',
  trigger_type: 'single',
  status: 'active',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  trigger_prices: [1500],
  last_price: 1800.25,
  legs: [{ action: 'SELL', quantity: 1, price: 1499, pricetype: 'LIMIT', product: 'CNC' }],
  created_at: '2026-11-26 09:30:00',
  updated_at: '2026-11-26 09:30:00',
  expires_at: '2027-11-26 09:30:00',
}

describe('initialGttTicket', () => {
  test('a link with no action or quantity: SINGLE BUY, 1 unit', () => {
    expect(initialGttTicket({ exchange: 'NSE', symbol: 'RELIANCE' }, RELIANCE)).toEqual({
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'BUY',
      type: 'SINGLE',
      qty: 1,
    })
  })

  test('the preset side; a quantity in units, which a derivative takes as whole lots', () => {
    expect(
      initialGttTicket(
        { exchange: 'NSE', symbol: 'RELIANCE', action: 'SELL', quantity: 5 },
        RELIANCE,
      ),
    ).toMatchObject({ action: 'SELL', qty: 5 })
    expect(
      initialGttTicket({ exchange: 'NFO', symbol: FUT, quantity: 130 }, NIFTY_FUT),
    ).toMatchObject({ action: 'BUY', qty: 2 })
    // the nearest whole number of lots, at least one, as the order ticket presets them
    expect(initialGttTicket({ exchange: 'NFO', symbol: FUT, quantity: 20 }, NIFTY_FUT).qty).toBe(1)
    expect(initialGttTicket({ exchange: 'NFO', symbol: FUT }, NIFTY_FUT).qty).toBe(1)
  })
})

describe('gttIssueText', () => {
  test.each<[GttIssue, string]>([
    ['quote_only', 'Indices are quote-only: GTT is not available.'],
    ['unknown_instrument', 'This contract is expired or unknown.'],
    ['qty', 'Enter a quantity of at least 1.'],
    ['over_freeze', 'Above the freeze quantity of 5,000. Place a smaller GTT.'],
    ['trigger_missing', 'Enter a trigger price.'],
    ['price_missing', 'Enter a limit price.'],
    ['trigger_at_ltp', 'The trigger must differ from the last price.'],
    ['ltp_unknown', 'Waiting for the last price.'],
    ['oco_missing', 'Enter both triggers and both limit prices.'],
    ['oco_order', 'The stop-loss trigger must be below the target trigger.'],
    ['oco_ltp', 'The last price must sit between the stop-loss and target triggers.'],
  ])('%s', (issue, text) => {
    expect(gttIssueText(issue, { meta: { ...RELIANCE, freezeQty: 5000 }, ltp: 1800 })).toBe(text)
  })

  test('on a derivative the quantity is in lots, and the freeze quantity is named', () => {
    expect(gttIssueText('qty', { meta: NIFTY_FUT })).toBe('Enter a quantity of at least 1 lot.')
    expect(gttIssueText('over_freeze', { meta: NIFTY_FUT })).toBe(
      'Above the freeze quantity of 1,800. Place a smaller GTT.',
    )
    expect(gttIssueText('qty', { meta: 'unknown' })).toBe('Enter a quantity of at least 1.')
  })
})

describe('validateGtt', () => {
  test('an index or an unlisted contract is reported alone', () => {
    expect(validateGtt(single({ exchange: 'NSE_INDEX', qty: 0 }), RELIANCE, 1800)).toEqual([
      'quote_only',
    ])
    expect(validateGtt(single({ qty: 0 }), 'unknown', 1800)).toEqual(['unknown_instrument'])
  })

  test('a SINGLE with its trigger and limit, and the LTP known, is valid', () => {
    expect(validateGtt(single(), RELIANCE, 1800)).toEqual([])
  })

  test('the quantity must be whole and at least 1', () => {
    expect(validateGtt(single({ qty: 0 }), RELIANCE, 1800)).toEqual(['qty'])
    expect(validateGtt(single({ qty: 1.5 }), RELIANCE, 1800)).toEqual(['qty'])
    expect(validateGtt(single({ qty: Number.NaN }), RELIANCE, 1800)).toEqual(['qty'])
  })

  test('above a freeze quantity over 1, in units', () => {
    const fut = { exchange: 'NFO', symbol: FUT, trigger: 24_000, price: 23_990 }
    // 27 lots are 1,755 units, 28 are 1,820
    expect(validateGtt(single({ ...fut, qty: 27 }), NIFTY_FUT, 24_100)).toEqual([])
    expect(validateGtt(single({ ...fut, qty: 28 }), NIFTY_FUT, 24_100)).toEqual(['over_freeze'])
    // no freeze quantity known: any size
    expect(validateGtt(single({ qty: 5000 }), RELIANCE, 1800)).toEqual([])
  })

  test('a SINGLE needs a trigger and a limit price above 0, on the tick', () => {
    expect(validateGtt(single({ trigger: undefined, price: undefined }), RELIANCE, 1800)).toEqual([
      'trigger_missing',
      'price_missing',
    ])
    // below half a tick it snaps to 0
    expect(validateGtt(single({ trigger: 0.02, price: 0 }), RELIANCE, 1800)).toEqual([
      'trigger_missing',
      'price_missing',
    ])
  })

  test('(RF 6) a SINGLE without the LTP waits for it: its direction is not known', () => {
    expect(validateGtt(single(), RELIANCE, undefined)).toEqual(['ltp_unknown'])
    expect(validateGtt(single(), RELIANCE, 0)).toEqual(['ltp_unknown'])
  })

  test('a SINGLE whose snapped trigger is the LTP has no direction', () => {
    expect(validateGtt(single({ trigger: 1800.03 }), RELIANCE, 1800.05)).toEqual(['trigger_at_ltp'])
    expect(validateGtt(single({ trigger: 1800.1 }), RELIANCE, 1800.05)).toEqual([])
  })

  test('an OCO needs all four values; its stop-loss below its target; the LTP between them', () => {
    expect(validateGtt(oco(), RELIANCE, 1400)).toEqual([])
    // no LTP: an OCO's direction is its own, so it can go
    expect(validateGtt(oco(), RELIANCE, undefined)).toEqual([])
    expect(validateGtt(oco({ tgPrice: undefined }), RELIANCE, 1400)).toEqual(['oco_missing'])
    expect(validateGtt(oco({ slTrigger: 0.01 }), RELIANCE, 1400)).toEqual(['oco_missing'])
    expect(validateGtt(oco({ slTrigger: 1500 }), RELIANCE, 1400)).toEqual(['oco_order'])
    expect(validateGtt(oco({ slTrigger: 1600 }), RELIANCE, 1400)).toEqual(['oco_order'])
    expect(validateGtt(oco(), RELIANCE, 1300)).toEqual(['oco_ltp'])
    expect(validateGtt(oco(), RELIANCE, 1550)).toEqual(['oco_ltp'])
  })
})

describe('planGtt', () => {
  test('every price snaps to the tick: 1500.03 is 1500.05 at 0.05', () => {
    expect(planGtt(single({ trigger: 1500.03, price: 1500.03 }), RELIANCE, 1800)).toMatchObject({
      trigger: 1500.05,
      price: 1500.05,
    })
    expect(
      planGtt(
        oco({ slTrigger: 1300.03, slPrice: 1299.02, tgTrigger: 1500.03, tgPrice: 1501.01 }),
        RELIANCE,
      ),
    ).toMatchObject({
      sl: { trigger: 1300.05, price: 1299 },
      tg: { trigger: 1500.05, price: 1501 },
    })
  })

  test('(RF 6) a SINGLE above the LTP fires on a rise, below it on a fall', () => {
    expect(planGtt(single({ trigger: 1900 }), RELIANCE, 1800)).toMatchObject({ above: true })
    expect(planGtt(single({ trigger: 1700 }), RELIANCE, 1800)).toMatchObject({ above: false })
  })

  test('a SINGLE is never planned without the LTP', () => {
    expect(() => planGtt(single(), RELIANCE, undefined)).toThrow()
  })

  test('the whole spec: units on a derivative, NRML there and CNC on cash', () => {
    expect(
      planGtt(
        single({
          exchange: 'NFO',
          symbol: FUT,
          action: 'BUY',
          qty: 2,
          trigger: 24_200,
          price: 24_210,
        }),
        NIFTY_FUT,
        24_100,
      ),
    ).toEqual({
      type: 'SINGLE',
      exchange: 'NFO',
      symbol: FUT,
      action: 'BUY',
      product: 'NRML',
      quantity: 130,
      trigger: 24_200,
      price: 24_210,
      above: true,
    })
    expect(planGtt(oco(), RELIANCE)).toEqual({
      type: 'OCO',
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'SELL',
      product: 'CNC',
      quantity: 1,
      sl: { trigger: 1300, price: 1299 },
      tg: { trigger: 1500, price: 1501 },
    })
  })
})

describe('gttTicketFromRow', () => {
  test('a SINGLE: its trigger and its leg, side and quantity', () => {
    expect(gttTicketFromRow(rowOf(KITE_SINGLE), RELIANCE)).toEqual({
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'SELL',
      type: 'SINGLE',
      qty: 1,
      product: 'CNC',
      trigger: 1500,
      price: 1499,
    })
  })

  test('(RF 3) an OCO whose legs come target first: the stop-loss is the lower trigger, with its own limit', () => {
    const row = rowOf({
      ...KITE_SINGLE,
      trigger_type: 'two-leg',
      trigger_prices: [1520, 1420],
      legs: [
        { action: 'SELL', quantity: 1, price: 1521, pricetype: 'LIMIT', product: 'CNC' },
        { action: 'SELL', quantity: 1, price: 1419, pricetype: 'LIMIT', product: 'CNC' },
      ],
    })
    expect(gttTicketFromRow(row, RELIANCE)).toEqual({
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'SELL',
      type: 'OCO',
      qty: 1,
      product: 'CNC',
      slTrigger: 1420,
      slPrice: 1419,
      tgTrigger: 1520,
      tgPrice: 1521,
    })
  })

  test('on a derivative the quantity is in lots', () => {
    const row = rowOf({
      ...KITE_SINGLE,
      exchange: 'NFO',
      symbol: FUT,
      trigger_prices: [24_000],
      legs: [{ action: 'BUY', quantity: 130, price: 24_010, pricetype: 'LIMIT', product: 'NRML' }],
    })
    expect(gttTicketFromRow(row, NIFTY_FUT)).toMatchObject({ action: 'BUY', qty: 2 })
  })

  test('a row without the legs its type needs gives no ticket: its side is not known', () => {
    expect(gttTicketFromRow(rowOf({ ...KITE_SINGLE, legs: [] }), RELIANCE)).toEqual({
      refused: 'legs',
    })
    const oneLeg = rowOf({ ...KITE_SINGLE, trigger_type: 'two-leg', trigger_prices: [1420, 1520] })
    expect(gttTicketFromRow(oneLeg, RELIANCE)).toEqual({ refused: 'legs' })
  })

  test("(G2) an NRML GTT on NSE (Angel's MARGIN) keeps its product: the modify sends NRML, never CNC", () => {
    const leg = { action: 'SELL', quantity: 1, price: 1499, pricetype: 'LIMIT', product: 'NRML' }
    const t = gttTicketFromRow(rowOf({ ...KITE_SINGLE, legs: [leg] }), RELIANCE)
    expect(t).toMatchObject({ exchange: 'NSE', product: 'NRML' })
    if ('refused' in t) throw new Error('refused')
    expect(planGtt(t, RELIANCE, 1800)).toMatchObject({ product: 'NRML' })
    // as the book may word it
    const lower = gttTicketFromRow(
      rowOf({ ...KITE_SINGLE, legs: [{ ...leg, product: ' nrml ', pricetype: 'limit' }] }),
      RELIANCE,
    )
    expect(lower).toMatchObject({ product: 'NRML' })
  })

  test('(G2) a product a GTT is not sent with, none, or two of them: no ticket, and the product named', () => {
    const leg = { action: 'SELL', quantity: 1, price: 1499, pricetype: 'LIMIT', product: 'CNC' }
    const withLegs = (legs: Record<string, unknown>[], o: Record<string, unknown> = {}) =>
      gttTicketFromRow(rowOf({ ...KITE_SINGLE, ...o, legs }), RELIANCE)
    expect(withLegs([{ ...leg, product: 'MIS' }])).toEqual({ refused: 'product', product: 'MIS' })
    expect(withLegs([{ ...leg, product: 'MTF' }])).toEqual({ refused: 'product', product: 'MTF' })
    expect(withLegs([{ ...leg, product: '' }])).toEqual({ refused: 'product', product: '' })
    expect(withLegs([{ ...leg, product: undefined }])).toEqual({ refused: 'product', product: '' })
    const twoLeg = { trigger_type: 'two-leg', trigger_prices: [1420, 1520] }
    expect(
      withLegs(
        [
          { ...leg, price: 1419 },
          { ...leg, price: 1521, product: 'NRML' },
        ],
        twoLeg,
      ),
    ).toEqual({ refused: 'product', product: 'CNC / NRML' })
  })

  test('(design 17.3) a leg that places a MARKET order is not sent as a LIMIT one: no ticket', () => {
    const leg = { action: 'SELL', quantity: 1, price: 0, pricetype: 'MARKET', product: 'CNC' }
    expect(gttTicketFromRow(rowOf({ ...KITE_SINGLE, legs: [leg] }), RELIANCE)).toEqual({
      refused: 'pricetype',
      pricetype: 'MARKET',
    })
    const unlisted = { ...leg, price: 1499, pricetype: undefined }
    expect(gttTicketFromRow(rowOf({ ...KITE_SINGLE, legs: [unlisted] }), RELIANCE)).toEqual({
      refused: 'pricetype',
      pricetype: '',
    })
    const twoLeg = rowOf({
      ...KITE_SINGLE,
      trigger_type: 'two-leg',
      trigger_prices: [1420, 1520],
      legs: [
        { ...leg, price: 1419, pricetype: 'LIMIT' },
        { ...leg, price: 0, pricetype: 'MARKET' },
      ],
    })
    expect(gttTicketFromRow(twoLeg, RELIANCE)).toEqual({
      refused: 'pricetype',
      pricetype: 'MARKET',
    })
  })
})

describe('gttSummary', () => {
  test('a SINGLE', () => {
    expect(gttSummary(planGtt(single(), RELIANCE, 1800), RELIANCE)).toBe(
      'GTT · SELL 1 RELIANCE · trigger 1,500.00 → LIMIT 1,499.00 · CNC',
    )
  })

  test('an OCO', () => {
    expect(gttSummary(planGtt(oco(), RELIANCE), RELIANCE)).toBe(
      'GTT OCO · SELL 1 RELIANCE · SL 1,300.00 → 1,299.00 · target 1,500.00 → 1,501.00 · CNC',
    )
  })

  test('lots as the order terms show them', () => {
    const spec = planGtt(
      single({
        exchange: 'NFO',
        symbol: FUT,
        action: 'BUY',
        qty: 2,
        trigger: 24_200,
        price: 24_210,
      }),
      NIFTY_FUT,
      24_100,
    )
    expect(gttSummary(spec, NIFTY_FUT)).toBe(
      `GTT · BUY 2L (130) ${FUT} · trigger 24,200.00 → LIMIT 24,210.00 · NRML`,
    )
  })

  test("a book row's own product, or none when it lists none", () => {
    const spec = planGtt(single(), RELIANCE, 1800)
    expect(gttSummary({ ...spec, product: 'MIS' }, RELIANCE)).toBe(
      'GTT · SELL 1 RELIANCE · trigger 1,500.00 → LIMIT 1,499.00 · MIS',
    )
    expect(gttSummary({ ...spec, product: '' }, RELIANCE)).toBe(
      'GTT · SELL 1 RELIANCE · trigger 1,500.00 → LIMIT 1,499.00',
    )
  })
})
