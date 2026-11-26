import type { Api } from '~/core/http/api'
import { createHttpClient, type RequestOptions } from '~/core/http/client'
import type { EndpointId } from '~/core/http/endpoints'
import { ApiError } from '~/core/http/errors'
import cancelAll from '../../../test/fixtures/openalgo-docs/cancelallorder.json'
import closePosition from '../../../test/fixtures/openalgo-docs/closeposition.json'
import holdings from '../../../test/fixtures/openalgo-docs/holdings.json'
import margin from '../../../test/fixtures/openalgo-docs/margin.json'
import orderbook from '../../../test/fixtures/openalgo-docs/orderbook.json'
import positionbook from '../../../test/fixtures/openalgo-docs/positionbook.json'
import splitOrder from '../../../test/fixtures/openalgo-docs/splitorder.json'
import tradebook from '../../../test/fixtures/openalgo-docs/tradebook.json'
import { type Route, scriptedFetch } from '../../../test/helpers/fakeFetch'
import type { OrderRow } from '../books/schemas'
import { createOrderApi, type OrderApi } from './api'
import { type OrderSpec, placeBody } from './schemas'

const SPEC: OrderSpec = {
  exchange: 'NSE',
  symbol: 'YESBANK',
  action: 'SELL',
  quantity: 104,
  pricetype: 'MARKET',
  product: 'MIS',
  price: 0,
  trigger_price: 0,
}
const ROW: OrderRow = {
  orderid: '250408001002736',
  symbol: 'YESBANK',
  exchange: 'NSE',
  action: 'BUY',
  product: 'MIS',
  pricetype: 'LIMIT',
  quantity: 1,
  price: 16.5,
  trigger_price: 0,
  status: 'open',
  timestamp: '08-Apr-2025 14:13:45',
  placedAt: null,
}
const POSITION = { symbol: 'YESBANK', exchange: 'NSE', product: 'MIS', quantity: -104 }

type Call = { id: EndpointId; body: Record<string, unknown>; o?: RequestOptions }

/** An Api that records each call and parses `replies[id]` with the schema it was given. */
function fakeApi(replies: Partial<Record<EndpointId, unknown>>) {
  const calls: Call[] = []
  const api: Api = {
    async call(id, body, schema, o) {
      calls.push({ id, body, o })
      return schema.parse(replies[id])
    },
  }
  return { orders: createOrderApi(api), calls }
}

type Case = {
  name: keyof OrderApi
  run: (a: OrderApi, o: RequestOptions) => Promise<unknown>
  id: EndpointId
  body: Record<string, unknown>
  reply: unknown
  result: unknown
}

const CASES: Case[] = [
  {
    name: 'place',
    run: (a, o) => a.place(SPEC, o),
    id: 'placeorder',
    body: placeBody(SPEC),
    reply: { status: 'success', orderid: '250408000989443' },
    result: { kind: 'placed', orderid: '250408000989443', analyze: false },
  },
  {
    name: 'split',
    run: (a, o) => a.split({ ...SPEC, quantity: 105 }, 20, o),
    id: 'splitorder',
    body: { ...placeBody({ ...SPEC, quantity: 105 }), splitsize: 20 },
    reply: splitOrder,
    result: expect.objectContaining({ kind: 'split', total: 105, size: 20 }),
  },
  {
    name: 'smartClose',
    run: (a, o) => a.smartClose(POSITION, o),
    id: 'placesmartorder',
    body: expect.objectContaining({ symbol: 'YESBANK', action: 'BUY', position_size: '0' }),
    reply: { status: 'success', message: 'Positions Already Matched. No Action needed.' },
    result: {
      kind: 'flat',
      message: 'Positions Already Matched. No Action needed.',
      analyze: false,
    },
  },
  {
    name: 'modify',
    run: (a, o) => a.modify(ROW, { price: 16.4 }, o),
    id: 'modifyorder',
    body: expect.objectContaining({ orderid: '250408001002736', price: 16.4, quantity: 1 }),
    reply: { status: 'success', orderid: '250408001002736' },
    result: { kind: 'ok', orderid: '250408001002736', analyze: false },
  },
  {
    name: 'cancel',
    run: (a, o) => a.cancel('250408001002736', o),
    id: 'cancelorder',
    body: { orderid: '250408001002736', strategy: 'mobile' },
    reply: { status: 'success', orderid: '250408001002736', mode: 'analyze' },
    result: { kind: 'ok', orderid: '250408001002736', analyze: true },
  },
  {
    name: 'cancelAll',
    run: (a, o) => a.cancelAll(o),
    id: 'cancelallorder',
    body: { strategy: 'mobile' },
    reply: cancelAll,
    result: expect.objectContaining({ failed: [] }),
  },
  {
    name: 'closeAll',
    run: (a, o) => a.closeAll(o),
    id: 'closeposition',
    body: { strategy: 'mobile' },
    reply: closePosition,
    result: { message: 'All Open Positions Squared Off', analyze: false },
  },
  {
    name: 'margin',
    run: (a, o) => a.margin(SPEC, o),
    id: 'margin',
    body: { positions: [expect.objectContaining({ symbol: 'YESBANK', quantity: '104' })] },
    reply: margin,
    result: { total: 91555.7625 },
  },
  {
    name: 'orderbook',
    run: (a, o) => a.orderbook(o),
    id: 'orderbook',
    body: {},
    reply: orderbook,
    result: expect.objectContaining({ dropped: 0, orders: expect.any(Array) }),
  },
  {
    name: 'tradebook',
    run: (a, o) => a.tradebook(o),
    id: 'tradebook',
    body: {},
    reply: tradebook,
    result: expect.objectContaining({ dropped: 0, rows: expect.any(Array) }),
  },
  {
    name: 'positionbook',
    run: (a, o) => a.positionbook(o),
    id: 'positionbook',
    body: {},
    reply: positionbook,
    result: expect.objectContaining({ dropped: 0, rows: expect.any(Array) }),
  },
  {
    name: 'holdings',
    run: (a, o) => a.holdings(o),
    id: 'holdings',
    body: {},
    reply: holdings,
    result: expect.objectContaining({ dropped: 0, stats: expect.any(Object) }),
  },
]

describe('createOrderApi', () => {
  test('covers every method', () => {
    const { orders } = fakeApi({})
    expect(CASES.map((c) => c.name).sort()).toEqual(Object.keys(orders).sort())
  })

  test.each(CASES)(
    '$name calls $id once with its body and schema, forwarding the options',
    async (c) => {
      const { orders, calls } = fakeApi({ [c.id]: c.reply })
      const o = { signal: new AbortController().signal }
      await expect(c.run(orders, o)).resolves.toEqual(c.result)
      expect(calls).toEqual([{ id: c.id, body: c.body, o }])
    },
  )
})

/** The order API over the real HTTP client, so a reply goes through its classification. */
function overHttp(routes: Record<string, Route>) {
  const fetch = scriptedFetch(routes)
  const http = createHttpClient({
    origin: 'https://algo.example.com',
    getKey: () => 'ab'.repeat(32),
    fetch,
    resolveAuth403: async () => 'key_invalid',
  })
  const api: Api = { call: (id, body, schema, o) => http.request(id, body, schema, o) }
  return { orders: createOrderApi(api), fetch }
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('expected the call to fail')
}

describe('through the HTTP client', () => {
  beforeEach(() => {
    for (const m of ['debug', 'info', 'warn', 'error'] as const) {
      jest.spyOn(console, m).mockImplementation(() => {})
    }
  })
  afterEach(() => jest.restoreAllMocks())

  // A 2xx on an order lane means the server took the request: never Server (design 7.10).
  test.each<[string, Route]>([
    ['a non-JSON body', { status: 200, body: 'OK' }],
    ['a cut-off JSON body', { status: 200, contentType: 'application/json', body: '{"stat' }],
    ['an unexpected status', { status: 200, body: { status: 'ok', orderid: '1' } }],
  ])('placeorder 200 with %s is MaybePlaced, sent once', async (_name, reply) => {
    const { orders, fetch } = overHttp({ 'POST /api/v1/placeorder': reply })
    const e = await failure(orders.place(SPEC))
    expect(e).toMatchObject({ kind: 'MaybePlaced', status: 200, endpoint: 'placeorder' })
    expect(fetch.calls).toHaveLength(1)
  })

  test('splitorder 200 with an unexpected shape is MaybePlaced', async () => {
    const { orders, fetch } = overHttp({
      'POST /api/v1/splitorder': {
        status: 200,
        body: { status: 'success', total_quantity: 105, split_size: 20, results: 'queued' },
      },
    })
    const e = await failure(orders.split({ ...SPEC, quantity: 105 }, 20))
    expect(e).toMatchObject({ kind: 'MaybePlaced', status: 200, endpoint: 'splitorder' })
    expect(fetch.calls).toHaveLength(1)
  })

  // Each schema's own way to fail: a success with no id is no_id, not a failure.
  test.each<[string, Route, (a: OrderApi) => Promise<unknown>, EndpointId]>([
    [
      'smartClose',
      { status: 200, body: { status: 'ok', orderid: '1' } },
      (a) => a.smartClose(POSITION),
      'placesmartorder',
    ],
    [
      'modify',
      { status: 200, body: { status: 'done', orderid: '250408001002736' } },
      (a) => a.modify(ROW, {}),
      'modifyorder',
    ],
    [
      'cancelAll',
      { status: 200, body: { status: 'success', canceled_orders: 3 } },
      (a) => a.cancelAll(),
      'cancelallorder',
    ],
    [
      'closeAll',
      { status: 200, body: { status: 'success' } },
      (a) => a.closeAll(),
      'closeposition',
    ],
  ])('%s: a 2xx that fails its schema is MaybePlaced', async (_name, reply, run, id) => {
    const { orders } = overHttp({ [`POST /api/v1/${id}`]: reply })
    expect(await failure(run(orders))).toMatchObject({
      kind: 'MaybePlaced',
      status: 200,
      endpoint: id,
    })
  })

  test('a read 200 that fails its schema is Server', async () => {
    const { orders } = overHttp({
      'POST /api/v1/orderbook': { status: 200, body: { status: 'success', data: 'none' } },
    })
    const e = await failure(orders.orderbook())
    expect(e).toMatchObject({ kind: 'Server', status: 200, endpoint: 'orderbook' })
  })

  test.each<[string, (a: OrderApi) => Promise<unknown>, EndpointId]>([
    ['smartClose', (a) => a.smartClose(POSITION), 'placesmartorder'],
    ['modify', (a) => a.modify(ROW, { price: 16.4 }), 'modifyorder'],
    ['cancel', (a) => a.cancel('250408001002736'), 'cancelorder'],
  ])(
    '%s: a success with orderid null is no_id, for the caller to reconcile',
    async (_n, run, id) => {
      const { orders } = overHttp({
        [`POST /api/v1/${id}`]: { status: 200, body: { status: 'success', orderid: null } },
      })
      await expect(run(orders)).resolves.toEqual({ kind: 'no_id' })
    },
  )

  test('cancel all keeps the readable ids when one item is null', async () => {
    const { orders } = overHttp({
      'POST /api/v1/cancelallorder': {
        status: 200,
        body: {
          status: 'success',
          message: 'Canceled 2 orders. Failed to cancel 1 orders.',
          canceled_orders: ['250408001042620', null],
          failed_cancellations: ['250408001043015'],
        },
      },
    })
    await expect(orders.cancelAll()).resolves.toEqual({
      canceled: ['250408001042620'],
      failed: [{ orderid: '250408001043015' }],
      analyze: false,
    })
  })
})
