import type { Api } from '~/core/http/api'
import type { RequestOptions } from '~/core/http/client'
import type { EndpointId } from '~/core/http/endpoints'
import cancelAll from '../../../test/fixtures/openalgo-docs/cancelallorder.json'
import closePosition from '../../../test/fixtures/openalgo-docs/closeposition.json'
import holdings from '../../../test/fixtures/openalgo-docs/holdings.json'
import margin from '../../../test/fixtures/openalgo-docs/margin.json'
import orderbook from '../../../test/fixtures/openalgo-docs/orderbook.json'
import positionbook from '../../../test/fixtures/openalgo-docs/positionbook.json'
import splitOrder from '../../../test/fixtures/openalgo-docs/splitorder.json'
import tradebook from '../../../test/fixtures/openalgo-docs/tradebook.json'
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
    result: { kind: 'flat', message: 'Positions Already Matched. No Action needed.' },
  },
  {
    name: 'modify',
    run: (a, o) => a.modify(ROW, { price: 16.4 }, o),
    id: 'modifyorder',
    body: expect.objectContaining({ orderid: '250408001002736', price: 16.4, quantity: 1 }),
    reply: { status: 'success', orderid: '250408001002736' },
    result: { orderid: '250408001002736', analyze: false },
  },
  {
    name: 'cancel',
    run: (a, o) => a.cancel('250408001002736', o),
    id: 'cancelorder',
    body: { orderid: '250408001002736', strategy: 'mobile' },
    reply: { status: 'success', orderid: '250408001002736', mode: 'analyze' },
    result: { orderid: '250408001002736', analyze: true },
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
    result: { message: 'All Open Positions Squared Off' },
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
