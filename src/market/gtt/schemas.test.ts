import {
  GttBookSchema,
  GttReplySchema,
  type GttSpec,
  gttCancelBody,
  gttModifyBody,
  gttPlaceBody,
} from './schemas'

/** One G4 row as Zerodha's mapper sends it (broker/zerodha/mapping/gtt_data.py, map_gtt_book). */
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

const book = (data: unknown[], extra: Record<string, unknown> = {}) =>
  GttBookSchema.parse({ status: 'success', data, ...extra })

describe('GttBookSchema (RF 3)', () => {
  test('a Kite SINGLE row parses', () => {
    expect(book([KITE_SINGLE])).toEqual({
      rows: [
        {
          triggerId: '112127',
          type: 'SINGLE',
          status: 'active',
          symbol: 'RELIANCE',
          exchange: 'NSE',
          triggers: [1500],
          lastPrice: 1800.25,
          legs: [
            {
              action: 'SELL',
              quantity: 1,
              price: 1499,
              pricetype: 'LIMIT',
              product: 'CNC',
              trigger: 1500,
            },
          ],
          createdAt: '2026-11-26 09:30:00',
          expiresAt: '2027-11-26 09:30:00',
        },
      ],
      dropped: 0,
      analyze: false,
    })
  })

  test('a Fyers-style row: numeric id, upper-case type, capitalised status, string prices', () => {
    const [row] = book([
      {
        trigger_id: 123,
        trigger_type: 'SINGLE',
        status: 'Active',
        symbol: 'SBIN',
        exchange: 'NSE',
        trigger_prices: ['1450.5'],
        last_price: 0,
        legs: [{ action: 'BUY', quantity: 10, price: '1451', pricetype: 'LIMIT', product: 'CNC' }],
        created_at: '2026-11-26 09:30:00',
        updated_at: '',
        expires_at: '',
      },
    ]).rows
    expect(row).toMatchObject({
      triggerId: '123',
      type: 'SINGLE',
      status: 'active',
      triggers: [1450.5],
      legs: [{ action: 'BUY', quantity: 10, price: 1451, trigger: 1450.5 }],
    })
  })

  test('OCO legs out of trigger order: each leg keeps its own trigger, then both sort ascending', () => {
    const [row] = book([
      {
        ...KITE_SINGLE,
        trigger_type: 'two-leg',
        trigger_prices: [1520, 1420],
        legs: [
          { action: 'SELL', quantity: 1, price: 1521, pricetype: 'LIMIT', product: 'CNC' },
          { action: 'SELL', quantity: 1, price: 1419, pricetype: 'LIMIT', product: 'CNC' },
        ],
      },
    ]).rows
    expect(row?.type).toBe('OCO')
    expect(row?.triggers).toEqual([1420, 1520])
    expect(row?.legs.map((l) => [l.trigger, l.price])).toEqual([
      [1420, 1419],
      [1520, 1521],
    ])
  })

  /**
   * An OCO as Fyers' mapper sends it (c8b2896 broker/fyers/mapping/gtt_data.py, map_gtt_book):
   * leg1 is the target (above the LTP) and leg2 the stop-loss, while `trigger_prices` is sorted
   * on its own, so leg i does not go with trigger i.
   */
  const fyersOco = (target: number, stoploss: number) => ({
    trigger_id: '25112600001',
    trigger_type: 'two-leg',
    status: 'active',
    symbol: 'RELIANCE',
    exchange: 'NSE',
    trigger_prices: [1420, 1520],
    last_price: 1470,
    legs: [
      { action: 'SELL', quantity: 1, price: target, pricetype: 'LIMIT', product: 'CNC' },
      { action: 'SELL', quantity: 1, price: stoploss, pricetype: 'LIMIT', product: 'CNC' },
    ],
    created_at: '26-Nov-2026 09:30:00',
    updated_at: '',
    expires_at: '',
  })

  test.each([
    ['limits past their triggers', 1521, 1419],
    ['limits at their triggers', 1520, 1420],
    ['limits short of their triggers', 1519, 1421],
  ])(
    'a Fyers OCO (target leg first, triggers sorted): the stop-loss keeps its own limit, %s',
    (_, target, stoploss) => {
      const [row] = book([fyersOco(target, stoploss)]).rows
      expect(row?.type).toBe('OCO')
      expect(row?.triggers).toEqual([1420, 1520])
      expect(row?.legs.map((l) => [l.trigger, l.price])).toEqual([
        [1420, stoploss],
        [1520, target],
      ])
    },
  )

  test('limits beyond the same end of both triggers cannot tell the pairing: the row order stands', () => {
    // A Kite OCO, legs in trigger order, whose target sells at any price from 1300 up.
    const [row] = book([
      {
        ...KITE_SINGLE,
        trigger_type: 'two-leg',
        trigger_prices: [1420, 1520],
        legs: [
          { action: 'SELL', quantity: 1, price: 1410, pricetype: 'LIMIT', product: 'CNC' },
          { action: 'SELL', quantity: 1, price: 1300, pricetype: 'LIMIT', product: 'CNC' },
        ],
      },
    ]).rows
    expect(row?.legs.map((l) => [l.trigger, l.price])).toEqual([
      [1420, 1410],
      [1520, 1300],
    ])
  })

  test.each([
    ['two-leg', 'OCO'],
    ['TWO-LEG', 'OCO'],
    ['oco', 'OCO'],
    ['OCO', 'OCO'],
    ['single', 'SINGLE'],
    ['gtt', 'SINGLE'],
    ['', 'SINGLE'],
  ])('trigger_type %p is %p', (trigger_type, type) => {
    expect(book([{ ...KITE_SINGLE, trigger_type }]).rows[0]?.type).toBe(type)
  })

  test('a row without a trigger_id is dropped and counted, and the others are kept', () => {
    const { trigger_id: _, ...noId } = KITE_SINGLE
    const b = book([noId, KITE_SINGLE, { ...KITE_SINGLE, trigger_id: '  ' }])
    expect(b.dropped).toBe(2)
    expect(b.rows.map((r) => r.triggerId)).toEqual(['112127'])
  })

  test('missing legs are empty; legs that do not pair with the triggers keep their order', () => {
    const { legs: _, ...noLegs } = KITE_SINGLE
    expect(book([noLegs]).rows[0]?.legs).toEqual([])
    const [row] = book([
      {
        ...KITE_SINGLE,
        trigger_prices: [1520, 1420],
        legs: [{ action: 'SELL', quantity: 1, price: 1521, pricetype: 'LIMIT', product: 'CNC' }],
      },
    ]).rows
    expect(row?.triggers).toEqual([1420, 1520])
    expect(row?.legs).toEqual([
      { action: 'SELL', quantity: 1, price: 1521, pricetype: 'LIMIT', product: 'CNC' },
    ])
  })

  test("a sandbox leg's triggered_order_id is its orderId; null is none", () => {
    const [row] = book([
      {
        ...KITE_SINGLE,
        trigger_id: 'GTT-261126-0a1b2c3d',
        trigger_prices: [1420, 1520],
        legs: [
          { ...KITE_SINGLE.legs[0], price: 1419, triggered_order_id: null },
          { ...KITE_SINGLE.legs[0], price: 1521, triggered_order_id: 'SB-1700000000-42' },
        ],
        strategy: 'mobile',
        margin_blocked: 1521,
      },
    ]).rows
    expect(row?.legs.map((l) => l.orderId)).toEqual([undefined, 'SB-1700000000-42'])
  })

  test("the envelope's mode:'analyze' marks the book as the sandbox's", () => {
    expect(book([], { mode: 'analyze' })).toEqual({ rows: [], dropped: 0, analyze: true })
    expect(book([]).analyze).toBe(false)
  })
})

const SINGLE: GttSpec = {
  type: 'SINGLE',
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'SELL',
  product: 'CNC',
  quantity: 1,
  trigger: 1500,
  price: 1499,
  above: false,
}
const OCO: GttSpec = {
  type: 'OCO',
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'SELL',
  product: 'CNC',
  quantity: 1,
  sl: { trigger: 1700, price: 1699 },
  tg: { trigger: 1900, price: 1901 },
}

describe('request bodies (G2)', () => {
  const common = {
    strategy: 'mobile',
    exchange: 'NSE',
    symbol: 'RELIANCE',
    action: 'SELL',
    product: 'CNC',
    quantity: 1,
    pricetype: 'LIMIT',
  }

  test('SINGLE below the LTP goes as the stop-loss trigger (RF 6)', () => {
    expect(gttPlaceBody(SINGLE)).toStrictEqual({
      ...common,
      trigger_type: 'SINGLE',
      price: 1499,
      triggerprice_sl: 1500,
      triggerprice_tg: 0,
    })
  })

  test('SINGLE above the LTP goes as the target trigger (RF 6)', () => {
    expect(gttPlaceBody({ ...SINGLE, trigger: 1900, price: 1900, above: true })).toStrictEqual({
      ...common,
      trigger_type: 'SINGLE',
      price: 1900,
      triggerprice_sl: 0,
      triggerprice_tg: 1900,
    })
  })

  test('OCO sends both legs, with the stop-loss limit as the price', () => {
    expect(gttPlaceBody(OCO)).toStrictEqual({
      ...common,
      trigger_type: 'OCO',
      price: 1699,
      triggerprice_sl: 1700,
      stoploss: 1699,
      triggerprice_tg: 1900,
      target: 1901,
    })
  })

  test('modify is the full place body plus the trigger id', () => {
    expect(gttModifyBody('1001', OCO)).toStrictEqual({ trigger_id: '1001', ...gttPlaceBody(OCO) })
  })

  test('cancel takes the strategy and the trigger id only', () => {
    expect(gttCancelBody('1001')).toStrictEqual({ strategy: 'mobile', trigger_id: '1001' })
  })
})

describe('GttReplySchema (G3)', () => {
  test('a success with a trigger id is ok, its id a string', () => {
    expect(GttReplySchema.parse({ status: 'success', trigger_id: 77 })).toEqual({
      kind: 'ok',
      triggerId: '77',
      analyze: false,
    })
  })

  test("the sandbox's mode:'analyze' marks it", () => {
    expect(
      GttReplySchema.parse({ status: 'success', trigger_id: 'GTT-1', mode: 'analyze' }),
    ).toEqual({ kind: 'ok', triggerId: 'GTT-1', analyze: true })
  })

  test('the Semi-Auto reply is queued', () => {
    expect(
      GttReplySchema.parse({
        status: 'success',
        message: 'Order queued for approval in Action Center',
        mode: 'semi_auto',
        pending_order_id: 12,
      }),
    ).toEqual({ kind: 'queued', pendingId: '12' })
  })

  test.each([
    ['no trigger id', { status: 'success' }],
    ['a null trigger id', { status: 'success', trigger_id: null }],
    ['an id past 2^53', JSON.parse('{"status":"success","trigger_id":9007199254740993}')],
  ])('a success with %s is no_id, for the caller to reconcile', (_n, reply) => {
    expect(GttReplySchema.parse(reply)).toEqual({ kind: 'no_id' })
  })
})
