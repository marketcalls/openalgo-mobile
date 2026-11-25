import cancelAll from '../../../test/fixtures/openalgo-docs/cancelallorder.json'
import cancelAllAnalyze from '../../../test/fixtures/openalgo-docs/cancelallorder-analyze.json'
import cancelAllPartial from '../../../test/fixtures/openalgo-docs/cancelallorder-partial.json'
import closePosition from '../../../test/fixtures/openalgo-docs/closeposition.json'
import margin from '../../../test/fixtures/openalgo-docs/margin.json'
import splitOrder from '../../../test/fixtures/openalgo-docs/splitorder.json'
import type { OrderRow } from '../books/schemas'
import {
  CancelAllReplySchema,
  CloseAllReplySchema,
  cancelAllBody,
  cancelBody,
  closeAllBody,
  IdReplySchema,
  MarginSchema,
  marginBody,
  modifyBody,
  type OrderSpec,
  PlaceReplySchema,
  placeBody,
  SmartReplySchema,
  SplitReplySchema,
  smartCloseBody,
  splitBody,
} from './schemas'

const QUEUED = {
  status: 'success',
  message: 'Order queued for approval in Action Center',
  mode: 'semi_auto',
  pending_order_id: 12,
}
const SPEC: OrderSpec = {
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'BUY',
  quantity: 10,
  pricetype: 'LIMIT',
  product: 'CNC',
  price: 1300.5,
  trigger_price: 1299,
}
const ROW: OrderRow = {
  orderid: '250408000989443',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  action: 'SELL',
  product: 'MIS',
  pricetype: 'SL',
  quantity: 5,
  price: 1190,
  trigger_price: 1191,
  status: 'trigger pending',
  timestamp: '08-Apr-2025 13:58:03',
  placedAt: 0,
}
// restx_api/schemas.py:22-211, each body besides the apikey the client adds.
const C3_KEYS = {
  placeorder: [
    'strategy',
    'exchange',
    'symbol',
    'action',
    'quantity',
    'pricetype',
    'product',
    'price',
    'trigger_price',
    'disclosed_quantity',
  ],
  modifyorder: [
    'orderid',
    'strategy',
    'symbol',
    'action',
    'exchange',
    'pricetype',
    'product',
    'quantity',
    'price',
    'trigger_price',
    'disclosed_quantity',
  ],
}
const keys = (o: object) => Object.keys(o).sort()

describe('PlaceReplySchema', () => {
  test('an order id is placed', () => {
    expect(PlaceReplySchema.parse({ status: 'success', orderid: '250408000989443' })).toEqual({
      kind: 'placed',
      orderid: '250408000989443',
      analyze: false,
    })
  })

  test("mode:'analyze' marks the sandbox", () => {
    const r = PlaceReplySchema.parse({ status: 'success', orderid: 'SB-1', mode: 'analyze' })
    expect(r).toEqual({ kind: 'placed', orderid: 'SB-1', analyze: true })
  })

  test('a numeric order id becomes a string', () => {
    expect(PlaceReplySchema.parse({ status: 'success', orderid: 250408000989443 })).toMatchObject({
      orderid: '250408000989443',
    })
  })

  test("semi_auto is queued with the pending id '12'", () => {
    expect(PlaceReplySchema.parse(QUEUED)).toEqual({ kind: 'queued', pendingId: '12' })
  })

  test('a success without an order id is no_id, never a parse failure', () => {
    for (const orderid of [undefined, null, '', ' ', {}]) {
      expect(PlaceReplySchema.parse({ status: 'success', orderid })).toEqual({ kind: 'no_id' })
    }
  })

  test('a numeric order id past 2^53 is no id: its digits are already rounded', () => {
    const reply = JSON.parse('{"status":"success","orderid":9007199254740993}')
    expect(PlaceReplySchema.parse(reply)).toEqual({ kind: 'no_id' })
  })

  test('an error body does not parse', () => {
    expect(PlaceReplySchema.safeParse({ status: 'error', orderid: '1' }).success).toBe(false)
  })
})

describe('SplitReplySchema', () => {
  test('the docs fixture', () => {
    const r = SplitReplySchema.parse(splitOrder)
    expect(r).toMatchObject({ kind: 'split', total: 105, size: 20, analyze: false })
    if (r.kind !== 'split') throw new Error(r.kind)
    expect(r.children).toHaveLength(6)
    expect(r.children[0]).toEqual({ n: 1, qty: 20, ok: true, orderid: '250408001021467' })
    expect(r.children[5]).toEqual({ n: 6, qty: 5, ok: true, orderid: '250408001021472' })
  })

  test('a failed child carries its message and no id; the sandbox marks analyze', () => {
    const r = SplitReplySchema.parse({
      status: 'success',
      mode: 'analyze',
      total_quantity: 1820,
      split_size: 1755,
      results: [
        { order_num: 1, quantity: 1755, status: 'success', orderid: 'SB-1' },
        { order_num: 2, quantity: 65, status: 'error', message: 'Failed to place order' },
      ],
    })
    expect(r).toEqual({
      kind: 'split',
      total: 1820,
      size: 1755,
      analyze: true,
      children: [
        { n: 1, qty: 1755, ok: true, orderid: 'SB-1' },
        { n: 2, qty: 65, ok: false, message: 'Failed to place order' },
      ],
    })
  })

  test('semi_auto is queued', () => {
    expect(SplitReplySchema.parse(QUEUED)).toEqual({ kind: 'queued', pendingId: '12' })
  })
})

describe('SmartReplySchema', () => {
  test('an order id is placed, and semi_auto is queued', () => {
    expect(SmartReplySchema.parse({ status: 'success', orderid: '7', mode: 'analyze' })).toEqual({
      kind: 'placed',
      orderid: '7',
      analyze: true,
    })
    expect(SmartReplySchema.parse(QUEUED)).toEqual({ kind: 'queued', pendingId: '12' })
  })

  test.each([
    'Positions Already Matched. No Action needed.',
    'No OpenPosition Found. Not placing Exit order.',
  ])('%p is flat', (message) => {
    expect(SmartReplySchema.parse({ status: 'success', message, mode: 'analyze' })).toEqual({
      kind: 'flat',
      message,
    })
  })

  // place_smart_order_service.py:240-241 sends orderid null when the adapter gives none.
  test('a success with a null or missing id, and no flat message, is no_id', () => {
    for (const reply of [
      { status: 'success', orderid: null },
      { status: 'success' },
      { status: 'success', orderid: ' ', mode: 'analyze' },
      { status: 'success', message: 'Done' },
    ]) {
      expect(SmartReplySchema.parse(reply)).toEqual({ kind: 'no_id' })
    }
  })

  test('an error body does not parse', () => {
    expect(SmartReplySchema.safeParse({ status: 'error', message: 'x' }).success).toBe(false)
  })
})

describe('IdReplySchema', () => {
  test('modify and cancel echo the id; the sandbox adds mode:analyze', () => {
    expect(IdReplySchema.parse({ status: 'success', orderid: '250408000989443' })).toEqual({
      kind: 'ok',
      orderid: '250408000989443',
      analyze: false,
    })
    const sandbox = {
      status: 'success',
      orderid: 'SB-1',
      message: 'Order modified',
      mode: 'analyze',
    }
    expect(IdReplySchema.parse(sandbox)).toEqual({ kind: 'ok', orderid: 'SB-1', analyze: true })
  })

  test('a success with a null or missing id is no_id, never a parse failure', () => {
    expect(IdReplySchema.parse({ status: 'success', orderid: null })).toEqual({ kind: 'no_id' })
    expect(IdReplySchema.parse({ status: 'success' })).toEqual({ kind: 'no_id' })
    expect(IdReplySchema.parse({ status: 'success', mode: 'analyze' })).toEqual({ kind: 'no_id' })
  })

  test('an error body does not parse', () => {
    expect(IdReplySchema.safeParse({ status: 'error', orderid: '1' }).success).toBe(false)
  })
})

describe('CancelAllReplySchema', () => {
  test('all cancelled', () => {
    const r = CancelAllReplySchema.parse(cancelAll)
    expect(r.canceled).toHaveLength(5)
    expect(r.failed).toEqual([])
  })

  test('partial: failures given as bare ids', () => {
    expect(CancelAllReplySchema.parse(cancelAllPartial)).toEqual({
      canceled: ['250408001042620', '250408001042667', '250408001042642'],
      failed: [{ orderid: '250408001043015' }, { orderid: '250408001043386' }],
      analyze: false,
    })
  })

  test('analyzer partial: failures given as objects with a message, and the sandbox tag', () => {
    expect(CancelAllReplySchema.parse(cancelAllAnalyze)).toEqual({
      canceled: ['SB-250408001042620'],
      failed: [{ orderid: 'SB-250408001043015', message: 'Failed to cancel' }],
      analyze: true,
    })
  })

  test('an unreadable item is skipped and the readable ones are kept', () => {
    const r = CancelAllReplySchema.parse({
      status: 'success',
      message: 'Canceled 3 orders. Failed to cancel 3 orders.',
      canceled_orders: ['250408001042620', null, 250408001042667],
      failed_cancellations: [
        null,
        '250408001043015',
        { orderid: null, message: 'Failed to cancel' },
        { orderid: 'SB-1', message: 42 },
      ],
    })
    expect(r).toEqual({
      canceled: ['250408001042620', '250408001042667'],
      failed: [{ orderid: '250408001043015' }, { orderid: 'SB-1' }],
      analyze: false,
    })
    expect([r.canceled.length, r.failed.length]).toEqual([2, 2])
  })

  test('a reply without its lists does not parse', () => {
    expect(CancelAllReplySchema.safeParse({ status: 'success', message: 'x' }).success).toBe(false)
  })
})

describe('CloseAllReplySchema and MarginSchema', () => {
  test('close all gives its message, and the sandbox tag when the sandbox answered', () => {
    expect(CloseAllReplySchema.parse(closePosition)).toEqual({
      message: 'All Open Positions Squared Off',
      analyze: false,
    })
    expect(
      CloseAllReplySchema.parse({
        status: 'success',
        message: 'No open positions to close',
        mode: 'analyze',
      }),
    ).toEqual({ message: 'No open positions to close', analyze: true })
  })

  test('margin gives the total required', () => {
    expect(MarginSchema.parse(margin)).toEqual({ total: 91555.7625 })
  })
})

describe('request bodies (C3)', () => {
  test('place: exactly the C3 keys, strategy mobile, disclosed 0', () => {
    const body = placeBody(SPEC)
    expect(keys(body)).toEqual([...C3_KEYS.placeorder].sort())
    expect(body).toEqual({
      strategy: 'mobile',
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'BUY',
      quantity: 10,
      pricetype: 'LIMIT',
      product: 'CNC',
      price: 1300.5,
      trigger_price: 0,
      disclosed_quantity: 0,
    })
  })

  test('split: the place body plus splitsize', () => {
    expect(splitBody(SPEC, 1755)).toEqual({ ...placeBody(SPEC), splitsize: 1755 })
  })

  test('smart close: the C3 row with the closing side and the row product', () => {
    const row = { symbol: 'NHPC', exchange: 'NSE', product: 'MIS', quantity: -1 }
    expect(smartCloseBody(row)).toEqual({
      strategy: 'mobile',
      exchange: 'NSE',
      symbol: 'NHPC',
      product: 'MIS',
      action: 'BUY',
      quantity: '0',
      position_size: '0',
      pricetype: 'MARKET',
      price: '0',
      trigger_price: '0',
      disclosed_quantity: '0',
    })
    expect(smartCloseBody({ ...row, product: 'CNC', quantity: 4 })).toMatchObject({
      action: 'SELL',
      product: 'CNC',
    })
  })

  test('modify: exactly the 11 C3 keys besides apikey', () => {
    expect(keys(modifyBody(ROW, {}))).toEqual([...C3_KEYS.modifyorder].sort())
  })

  test('modify: a price-only change copies every other field from the row', () => {
    expect(modifyBody(ROW, { price: 1185.5 })).toEqual({
      orderid: '250408000989443',
      strategy: 'mobile',
      symbol: 'RELIANCE',
      action: 'SELL',
      exchange: 'NSE',
      pricetype: 'SL',
      product: 'MIS',
      quantity: 5,
      price: 1185.5,
      trigger_price: 1191,
      disclosed_quantity: 0,
    })
  })

  test('modify: the change wins, and a row without a price sends 0', () => {
    const body = modifyBody({ ...ROW, pricetype: 'LIMIT', price: undefined }, { quantity: 2 })
    expect(body).toMatchObject({ quantity: 2, pricetype: 'LIMIT', price: 0, trigger_price: 0 })
    expect(modifyBody(ROW, { pricetype: 'LIMIT', price: 1180 })).toMatchObject({
      pricetype: 'LIMIT',
      price: 1180,
      trigger_price: 0,
    })
  })

  test('cancel, cancel all and close all', () => {
    expect(cancelBody('250408000989443')).toEqual({
      orderid: '250408000989443',
      strategy: 'mobile',
    })
    expect(keys(cancelAllBody())).toEqual(['strategy'])
    expect(keys(closeAllBody())).toEqual(['strategy'])
    expect(cancelAllBody()).toEqual({ strategy: 'mobile' })
    expect(closeAllBody()).toEqual({ strategy: 'mobile' })
  })

  test.each([
    ['MARKET', 0, 0],
    ['LIMIT', 1300.5, 0],
    ['SL', 1300.5, 1299],
    ['SL-M', 0, 1299],
  ] as const)('price fields: %s sends price %p and trigger %p', (pricetype, price, trigger) => {
    const spec = { ...SPEC, pricetype }
    expect(placeBody(spec)).toMatchObject({ price, trigger_price: trigger })
    expect(splitBody(spec, 5)).toMatchObject({ price, trigger_price: trigger })
    expect(modifyBody({ ...ROW, price: 1300.5, trigger_price: 1299 }, { pricetype })).toMatchObject(
      { price, trigger_price: trigger },
    )
    expect(marginBody(spec).positions[0]).toMatchObject({
      price: String(price),
      trigger_price: String(trigger),
    })
  })

  test('margin: one position, with quantity and prices as strings', () => {
    const spec: OrderSpec = {
      exchange: 'NFO',
      symbol: 'NIFTY30DEC25FUT',
      action: 'BUY',
      quantity: 130,
      pricetype: 'LIMIT',
      product: 'NRML',
      price: 24117.3,
      trigger_price: 0,
    }
    expect(marginBody(spec)).toEqual({
      positions: [
        {
          symbol: 'NIFTY30DEC25FUT',
          exchange: 'NFO',
          action: 'BUY',
          quantity: '130',
          product: 'NRML',
          pricetype: 'LIMIT',
          price: '24117.3',
          trigger_price: '0',
        },
      ],
    })
  })
})
