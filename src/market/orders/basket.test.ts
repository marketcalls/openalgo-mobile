import { NATIVE_KEY } from '~/dom/bridge/protocol'
import {
  type BasketLeg,
  BasketReplySchema,
  type BasketSpec,
  basketBody,
  LEGGING_RISK,
  type LegResult,
  MAX_BASKET_LEGS,
  matchBasketResults,
  netPremium,
  parseHeldBasket,
} from './basket'

const CE = 'NIFTY01DEC2624500CE'
const PE = 'NIFTY01DEC2624500PE'

/** A builder leg as ExecuteBasketDialog sends it (no disclosed quantity: the server's 0). */
const order = (o: Record<string, unknown> = {}) => ({
  symbol: CE,
  exchange: 'NFO',
  action: 'SELL',
  quantity: 75,
  pricetype: 'LIMIT',
  product: 'NRML',
  price: 120.5,
  trigger_price: 0,
  ...o,
})

/** Strategy Builder's body for a short straddle: a saved name of 120 characters. */
const builderBody = (o: Record<string, unknown> = {}) => ({
  apikey: NATIVE_KEY,
  strategy: 'S'.repeat(120),
  orders: [order(), order({ symbol: PE, price: 98.25 })],
  ...o,
})

const leg = (o: Partial<BasketLeg> = {}): BasketLeg => ({
  symbol: CE,
  exchange: 'NFO',
  action: 'SELL',
  quantity: 75,
  pricetype: 'LIMIT',
  product: 'NRML',
  price: 120.5,
  trigger_price: 0,
  disclosed_quantity: 0,
  ...o,
})
const spec = (...legs: BasketLeg[]): BasketSpec => ({
  endpoint: 'basketorder',
  strategy: 'S',
  legs,
})

describe('parseHeldBasket', () => {
  test("Strategy Builder's body parses, with a 120-character strategy; an unknown field, a 257-character strategy, quantity 0 or exchange 'XX' is refused", () => {
    expect(parseHeldBasket(builderBody())).toEqual({
      endpoint: 'basketorder',
      strategy: 'S'.repeat(120),
      legs: [leg(), leg({ symbol: PE, price: 98.25 })],
    })
    // the longest strategy the server's own apikey bound allows; no cap of its own
    expect(parseHeldBasket(builderBody({ strategy: 'S'.repeat(256) }))?.strategy).toHaveLength(256)

    const refused = [
      builderBody({ strategy: 'S'.repeat(257) }),
      builderBody({ strategy: '' }),
      builderBody({ orders: [order({ quantity: 0 })] }),
      builderBody({ orders: [order({ quantity: -75 })] }),
      builderBody({ orders: [order({ exchange: 'XX' })] }),
      // an unknown field, at the top or on a leg
      builderBody({ splitsize: 10 }),
      builderBody({ orders: [order({ strike: 24500 })] }),
      // fields.Str and fields.Float take no other type here
      builderBody({ orders: [order({ quantity: '75' })] }),
      builderBody({ orders: [order({ action: 'Sell' })] }),
      builderBody({ orders: [order({ pricetype: 'MKT' })] }),
      builderBody({ orders: [order({ price: -1 })] }),
      builderBody({ orders: [order({ disclosed_quantity: 1.5 })] }),
      // a fractional quantity outside CRYPTO (_coerce_quantity_to_int)
      builderBody({ orders: [order({ quantity: 1.5 })] }),
      // an index is never traded, whatever VALID_EXCHANGES says
      builderBody({ orders: [order({ exchange: 'NSE_INDEX', symbol: 'NIFTY' })] }),
      // 1..MAX_BASKET_LEGS legs
      builderBody({ orders: [] }),
      builderBody({ orders: Array.from({ length: MAX_BASKET_LEGS + 1 }, () => order()) }),
      builderBody({ orders: undefined }),
      builderBody({ strategy: undefined }),
      null,
      [builderBody()],
      'basket',
    ]
    for (const body of refused) expect(parseHeldBasket(body)).toBeNull()
  })

  test("actions are upper-cased, the type and product never default, the prices and disclosed quantity default to 0, and CRYPTO's quantity may be fractional", () => {
    const parsed = parseHeldBasket(
      builderBody({
        orders: [
          {
            symbol: 'BTCUSDT',
            exchange: 'CRYPTO',
            action: 'buy',
            quantity: 0.25,
            pricetype: 'MARKET',
            product: 'NRML',
          },
          order({ action: 'sell', disclosed_quantity: 25 }),
        ],
      }),
    )
    expect(parsed?.legs).toEqual([
      leg({
        symbol: 'BTCUSDT',
        exchange: 'CRYPTO',
        action: 'BUY',
        quantity: 0.25,
        pricetype: 'MARKET',
        price: 0,
      }),
      leg({ disclosed_quantity: 25 }),
    ])
    expect(parseHeldBasket(builderBody({ orders: [order({ pricetype: undefined })] }))).toBeNull()
    expect(parseHeldBasket(builderBody({ orders: [order({ product: undefined })] }))).toBeNull()
    expect(
      parseHeldBasket(
        builderBody({ orders: Array.from({ length: MAX_BASKET_LEGS }, () => order()) }),
      )?.legs,
    ).toHaveLength(MAX_BASKET_LEGS)
  })
})

describe('basketBody', () => {
  test('the placeholder apikey is dropped and never in basketBody', () => {
    const parsed = parseHeldBasket(builderBody())
    expect(parsed).not.toHaveProperty('apikey')
    if (!parsed) throw new Error('unparsed')
    const body = basketBody(parsed)
    expect(body).toEqual({
      strategy: 'S'.repeat(120),
      orders: [
        { ...order(), disclosed_quantity: 0 },
        { ...order({ symbol: PE, price: 98.25 }), disclosed_quantity: 0 },
      ],
    })
    expect(body).not.toHaveProperty('apikey')
    expect(JSON.stringify(body)).not.toContain(NATIVE_KEY)
  })

  test('each leg carries the prices its type does (C9): none at MARKET, the trigger alone at SL-M', () => {
    const { orders } = basketBody(
      spec(
        leg({ pricetype: 'MARKET', price: 120, trigger_price: 110 }),
        leg({ pricetype: 'SL-M', price: 120, trigger_price: 110 }),
        leg({ pricetype: 'SL', price: 120, trigger_price: 110 }),
        leg({ pricetype: 'LIMIT', price: 120, trigger_price: 110 }),
      ),
    ) as { orders: Array<{ price: number; trigger_price: number }> }
    expect(orders.map((o) => [o.price, o.trigger_price])).toEqual([
      [0, 0],
      [0, 110],
      [120, 110],
      [120, 0],
    ])
  })
})

describe('matchBasketResults', () => {
  const placed = (symbol: string, orderid: string, o: Partial<LegResult> = {}): LegResult => ({
    symbol,
    exchange: 'NFO',
    ok: true,
    orderid,
    ...o,
  })
  const failed = (symbol: string, message: string): LegResult => ({ symbol, ok: false, message })

  test('results in completion order (SELL first) match their legs by symbol', () => {
    const s = spec(
      leg({ symbol: CE, action: 'BUY' }),
      leg({ symbol: PE, action: 'SELL' }),
      leg({ symbol: 'NIFTY01DEC2624600CE', action: 'BUY' }),
    )
    // the server sends BUY legs first, but a result comes back as its leg completes
    const results = [
      placed(PE, 'P1'),
      failed('NIFTY01DEC2624600CE', 'Insufficient funds'),
      placed(CE, 'C1'),
    ]
    expect(matchBasketResults(s, results)).toEqual([
      { leg: 0, state: 'placed', orderid: 'C1' },
      { leg: 1, state: 'placed', orderid: 'P1' },
      { leg: 2, state: 'failed', message: 'Insufficient funds' },
    ])
  })

  test('two legs on one symbol: different outcomes are unclear, the same outcome is placed', () => {
    const s = spec(
      leg({ action: 'BUY', quantity: 75 }),
      leg({ action: 'SELL', quantity: 150 }),
      leg({ symbol: PE }),
    )
    // a result has no action, so which of the two legs failed cannot be told
    expect(matchBasketResults(s, [placed(CE, 'C1'), failed(CE, 'RMS'), placed(PE, 'P1')])).toEqual([
      { leg: 0, state: 'unclear' },
      { leg: 1, state: 'unclear' },
      { leg: 2, state: 'placed', orderid: 'P1' },
    ])
    // both placed: each leg is placed, and neither is given an id it may not own
    expect(matchBasketResults(s, [placed(CE, 'C2'), placed(CE, 'C1'), placed(PE, 'P1')])).toEqual([
      { leg: 0, state: 'placed' },
      { leg: 1, state: 'placed' },
      { leg: 2, state: 'placed', orderid: 'P1' },
    ])
    // both failed: each leg tells every message once, since whose is whose cannot be told
    expect(
      matchBasketResults(s, [failed(CE, 'RMS'), failed(CE, 'RMS'), failed(PE, 'Margin')]),
    ).toEqual([
      { leg: 0, state: 'failed', message: 'RMS' },
      { leg: 1, state: 'failed', message: 'RMS' },
      { leg: 2, state: 'failed', message: 'Margin' },
    ])
    expect(matchBasketResults(s, [failed(CE, 'RMS'), failed(CE, 'Margin')]).slice(0, 2)).toEqual([
      { leg: 0, state: 'failed', message: 'RMS; Margin' },
      { leg: 1, state: 'failed', message: 'RMS; Margin' },
    ])
    // one row for the two legs: one of them has none, and which cannot be told
    expect(matchBasketResults(s, [placed(CE, 'C1'), placed(PE, 'P1')]).slice(0, 2)).toEqual([
      { leg: 0, state: 'unclear' },
      { leg: 1, state: 'unclear' },
    ])
    // results that name their action tell the two apart
    expect(
      matchBasketResults(s, [
        placed(CE, 'C1', { action: 'SELL' }),
        { ...failed(CE, 'RMS'), action: 'BUY' },
      ]).slice(0, 2),
    ).toEqual([
      { leg: 0, state: 'failed', message: 'RMS' },
      { leg: 1, state: 'placed', orderid: 'C1' },
    ])
  })

  test('a leg with no row is missing; a success without an id is unclear; the exchange, when given, must match', () => {
    const nse = leg({ exchange: 'NSE', symbol: 'RELIANCE', product: 'MIS' })
    const s = spec(nse, { ...nse, exchange: 'BSE' }, leg())
    // each success names its exchange
    expect(
      matchBasketResults(s, [
        placed('RELIANCE', 'N1', { exchange: 'NSE' }),
        placed('RELIANCE', 'B1', { exchange: 'BSE' }),
      ]),
    ).toEqual([
      { leg: 0, state: 'placed', orderid: 'N1' },
      { leg: 1, state: 'placed', orderid: 'B1' },
      { leg: 2, state: 'missing' },
    ])
    // a failure names none (place_single_order), so it fits both legs, and neither can be told
    expect(
      matchBasketResults(s, [
        placed('RELIANCE', 'N1', { exchange: 'NSE' }),
        failed('RELIANCE', 'RMS'),
      ]),
    ).toEqual([
      { leg: 0, state: 'unclear' },
      { leg: 1, state: 'unclear' },
      { leg: 2, state: 'missing' },
    ])
    expect(matchBasketResults(s, [placed(CE, '', { orderid: undefined })])[2]).toEqual({
      leg: 2,
      state: 'unclear',
    })
    // a row of another contract, or another exchange, is no leg's
    expect(
      matchBasketResults(spec(leg()), [
        placed('NIFTY01DEC2624600CE', 'X'),
        placed(CE, 'Y', { exchange: 'BFO' }),
      ]),
    ).toEqual([{ leg: 0, state: 'missing' }])
    expect(matchBasketResults(spec(leg()), [])).toEqual([{ leg: 0, state: 'missing' }])
  })

  test("a leg sent but never answered (the server's unanswered text in a 200) is unclear, never failed", () => {
    // utils/httpx_client.py UNANSWERED_ORDER_MESSAGE at c8b2896, verbatim; place_single_order puts
    // it on a leg whose broker call was sent and whose reply was lost
    const unanswered =
      'The connection to the broker dropped after the order was sent, so it may have been placed. Check the order book before placing it again.'
    const body = {
      status: 'success',
      results: [
        { symbol: PE, exchange: 'NFO', product: 'NRML', status: 'success', orderid: 'P1' },
        { symbol: CE, status: 'error', message: unanswered },
        { symbol: 'NIFTY01DEC2624600CE', status: 'error', message: 'Insufficient funds' },
      ],
    }
    const reply = BasketReplySchema.parse(body)
    expect(reply).toEqual({
      kind: 'basket',
      results: [
        { symbol: PE, exchange: 'NFO', ok: true, orderid: 'P1' },
        { symbol: CE, ok: false, maybe: true, message: unanswered },
        { symbol: 'NIFTY01DEC2624600CE', ok: false, message: 'Insufficient funds' },
      ],
      analyze: false,
      raw: body,
    })
    if (reply.kind !== 'basket') throw new Error('not a basket')
    const s = spec(leg(), leg({ symbol: PE }), leg({ symbol: 'NIFTY01DEC2624600CE' }))
    // the leg may be working at the broker: the book is checked, it is never offered again
    expect(matchBasketResults(s, reply.results)).toEqual([
      { leg: 0, state: 'unclear' },
      { leg: 1, state: 'placed', orderid: 'P1' },
      { leg: 2, state: 'failed', message: 'Insufficient funds' },
    ])
    // two legs on one symbol, both unanswered, or one unanswered and one failed: both unclear
    const two = spec(leg({ action: 'BUY' }), leg({ action: 'SELL' }))
    const maybe: LegResult = { symbol: CE, ok: false, maybe: true, message: unanswered }
    expect(matchBasketResults(two, [maybe, maybe])).toEqual([
      { leg: 0, state: 'unclear' },
      { leg: 1, state: 'unclear' },
    ])
    expect(matchBasketResults(two, [failed(CE, 'RMS'), maybe])).toEqual([
      { leg: 0, state: 'unclear' },
      { leg: 1, state: 'unclear' },
    ])
  })
})

describe('BasketReplySchema', () => {
  test('a success without results is no_id; semi_auto is queued', () => {
    const parse = (body: unknown) => BasketReplySchema.parse(body)
    expect(parse({ status: 'success' })).toEqual({ kind: 'no_id' })
    expect(parse({ status: 'success', results: [] })).toEqual({ kind: 'no_id' })
    expect(
      parse({ status: 'success', results: [null, { symbol: CE, status: 'pending' }] }),
    ).toEqual({
      kind: 'no_id',
    })
    expect(
      parse({
        status: 'success',
        message: 'Order queued for approval in Action Center',
        mode: 'semi_auto',
        pending_order_id: 12,
      }),
    ).toEqual({ kind: 'queued', pendingId: '12' })
    expect(BasketReplySchema.safeParse({ status: 'error', message: 'x' }).success).toBe(false)
  })

  test('the sandbox reply: each result read, the analyze tag, and the body as it came for the page', () => {
    const body = {
      mode: 'analyze',
      status: 'success',
      results: [
        {
          symbol: PE,
          exchange: 'NFO',
          product: 'NRML',
          status: 'success',
          orderid: 25112600001,
          batch_order: true,
          is_last_order: false,
        },
        { symbol: CE, status: 'error', message: 'Insufficient funds' },
        null,
      ],
    }
    expect(BasketReplySchema.parse(body)).toEqual({
      kind: 'basket',
      results: [
        { symbol: PE, exchange: 'NFO', ok: true, orderid: '25112600001' },
        { symbol: CE, ok: false, message: 'Insufficient funds' },
      ],
      analyze: true,
      raw: body,
    })
    // live: no tag
    const live = {
      status: 'success',
      results: [{ symbol: CE, exchange: 'NFO', status: 'success', orderid: '7' }],
    }
    expect(BasketReplySchema.parse(live)).toMatchObject({
      kind: 'basket',
      analyze: false,
      raw: live,
    })
  })
})

describe('netPremium', () => {
  const quotes: Record<string, number> = { [`NFO:${CE}`]: 121, [`NFO:${PE}`]: 97.5 }
  const ltp = (key: string) => quotes[key]

  test('netPremium: a short straddle at LIMIT is a credit; MARKET uses the LTP; an unknown LTP gives null', () => {
    const short = spec(leg(), leg({ symbol: PE, price: 98.25 }))
    // (120.50 + 98.25) × 75 received
    expect(netPremium(short, ltp)).toEqual({ value: 16406.25, kind: 'credit' })
    const long = spec(
      leg({ action: 'BUY', pricetype: 'MARKET', price: 0 }),
      leg({ symbol: PE, action: 'BUY', price: 98.25 }),
    )
    // 121 × 75 + 98.25 × 75 paid: the amount, with the kind saying which way
    expect(netPremium(long, ltp)).toEqual({ value: 16443.75, kind: 'debit' })
    const unknown = spec(
      leg(),
      leg({ symbol: 'NIFTY01DEC2624600CE', pricetype: 'MARKET', price: 0 }),
    )
    expect(netPremium(unknown, ltp)).toBeNull()
  })

  test('equal premiums both ways are flat, to the paisa; SL takes its price and SL-M its trigger; an unpriced leg is null', () => {
    const flat = spec(
      leg({ price: 0.1, quantity: 3 }),
      leg({ action: 'BUY', price: 0.3, quantity: 1 }),
    )
    expect(netPremium(flat, ltp)).toEqual({ value: 0, kind: 'flat' })
    const stops = spec(
      leg({ pricetype: 'SL', price: 100, trigger_price: 99 }),
      leg({ action: 'BUY', pricetype: 'SL-M', price: 0, trigger_price: 90 }),
    )
    expect(netPremium(stops, ltp)).toEqual({ value: 750, kind: 'credit' })
    expect(netPremium(spec(leg({ price: 0 })), ltp)).toBeNull()
    expect(netPremium(spec(leg({ pricetype: 'MARKET' })), () => Number.NaN)).toBeNull()
  })
})

test('the legging warning', () => {
  expect(LEGGING_RISK).toBe(
    'The legs are sent together but fill on their own: one can fill without the other.',
  )
})
