// Held baskets (plan F): a tool page's basketorder is held for native review like a placeorder, and
// every answer the gateway gives it without a send is a 200 `{status:'error', message}`
// (ux-bar XL-1). The rest of the held-write contract is plan E's (tools.test.ts).
import { type DomReply, type DomRequest, type JSONValue, NATIVE_KEY } from '~/dom/bridge/protocol'
import {
  CANCELLED_COPY,
  createHeldWriteRoutes,
  createHeldWrites,
  heldRefusal,
  MAX_HELD_WRITES,
  ONE_AT_A_TIME,
  ORDER_WRITE_ENDPOINTS,
  REVIEWABLE_WRITES,
  TOOL_ORDERS_LATER,
} from './heldWrites'
import { createRequestRouter } from './requests'

/** Strategy Builder's basket, as ExecuteBasketDialog sends it through placeBasketOrder. */
const BASKET = {
  apikey: NATIVE_KEY,
  strategy: 'Short Straddle',
  orders: [
    {
      symbol: 'NIFTY01DEC2624500CE',
      exchange: 'NFO',
      action: 'SELL',
      quantity: 75,
      pricetype: 'LIMIT',
      product: 'NRML',
      price: 120.5,
      trigger_price: 0,
    },
  ],
}
const ORDER = {
  apikey: NATIVE_KEY,
  strategy: 'Max Pain',
  symbol: 'NIFTY01DEC2624000CE',
  exchange: 'NFO',
  action: 'BUY',
  quantity: 75,
  pricetype: 'MARKET',
  product: 'NRML',
}

let rid = 0
const post = (endpoint: string, body: JSONValue): DomRequest => ({
  v: 1,
  kind: 'request',
  rid: ++rid,
  method: 'POST',
  path: `/api/v1/${endpoint}`,
  body,
})

/** A page's held writes with the tool screen's reviewable set. */
function page() {
  const held = createHeldWrites()
  const route = createRequestRouter(
    createHeldWriteRoutes(held, 'maxpain', { reviewable: REVIEWABLE_WRITES }),
  )
  const send = (r: DomRequest, signal = new AbortController().signal) => route(r, signal)
  return { held, send }
}

/** A request's reply, or 'pending' while it has none after the queued callbacks ran. */
async function outcome(p: Promise<DomReply>): Promise<DomReply | 'pending'> {
  let out: DomReply | 'pending' = 'pending'
  void p.then((r) => {
    out = r
  })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  return out
}

const pageError = (message: string): DomReply => ({
  status: 200,
  body: { status: 'error', message },
})

test('the tool screen reviews placeorder and basketorder; every other order write stays 501', async () => {
  expect([...REVIEWABLE_WRITES].sort()).toEqual(['basketorder', 'placeorder'])
  const p = page()
  const basket = p.send(post('basketorder', BASKET))
  expect(await outcome(basket)).toBe('pending')
  expect(p.held.getState().current).toMatchObject({
    endpoint: 'basketorder',
    body: BASKET,
    page: 'maxpain',
  })
  // smart, split and options multi-order legs carry what no review can show: never held
  const later = ORDER_WRITE_ENDPOINTS.filter((e) => !REVIEWABLE_WRITES.has(e))
  expect(later).toEqual(['placesmartorder', 'optionsmultiorder', 'splitorder'])
  for (const e of later) {
    expect(await p.send(post(e, ORDER))).toEqual({
      status: 501,
      body: { status: 'error', message: TOOL_ORDERS_LATER },
    })
  }
  expect(p.held.getState().waiting).toBe(0)
  p.held.cancelAll()
  await basket
})

test('a held basket cancelled before its send begins hears a 200 error with CANCELLED_COPY; a placeorder keeps its 400 (XL-1)', async () => {
  const p = page()
  const basket = p.send(post('basketorder', BASKET))
  const order = p.send(post('placeorder', ORDER))
  expect(await outcome(order)).toBe('pending')
  p.held.cancelAll()
  // ExecuteBasketDialog toasts the sentence and keeps Execute enabled, as a 4xx leaves it
  expect(await basket).toEqual(pageError(CANCELLED_COPY))
  expect(await order).toEqual({ status: 400, body: { status: 'error', message: CANCELLED_COPY } })

  // the page gives up on it before the review began its send: the same answer
  const ctl = new AbortController()
  const gaveUp = p.send(post('basketorder', BASKET), ctl.signal)
  expect(await outcome(gaveUp)).toBe('pending')
  ctl.abort()
  expect(await gaveUp).toEqual(pageError(CANCELLED_COPY))
  expect(p.held.getState().current).toBeNull()

  // one already given up on is never held (the router itself never routes it: the route's own
  // answer, for a caller that does)
  const held = createHeldWrites()
  const basketRoute = createHeldWriteRoutes(held, 'maxpain', {
    reviewable: REVIEWABLE_WRITES,
  }).find((r) => r.path === '/api/v1/basketorder')
  const gone = new AbortController()
  gone.abort()
  expect(await basketRoute?.handle(post('basketorder', BASKET), gone.signal)).toEqual(
    pageError(CANCELLED_COPY),
  )
  expect(held.getState().current).toBeNull()
})

test('once its send has begun a held basket keeps its real outcome: cancelAll and an abort answer nothing (RF 2)', async () => {
  const p = page()
  const ctl = new AbortController()
  const basket = p.send(post('basketorder', BASKET), ctl.signal)
  expect(await outcome(basket)).toBe('pending')
  const id = p.held.getState().current?.id ?? -1
  expect(p.held.begin(id)).toBe(true)
  p.held.cancelAll()
  ctl.abort()
  expect(await outcome(basket)).toBe('pending')
  const placed: DomReply = {
    status: 200,
    body: { status: 'success', mode: 'analyze', results: [] },
  }
  p.held.settle(id, placed)
  expect(await basket).toEqual(placed)
})

test('past MAX_HELD_WRITES a basket hears ONE_AT_A_TIME as a 200 error; a placeorder keeps its 409', async () => {
  const p = page()
  const held = Array.from({ length: MAX_HELD_WRITES }, () => p.send(post('basketorder', BASKET)))
  expect(await outcome(held[MAX_HELD_WRITES - 1] as Promise<DomReply>)).toBe('pending')
  expect(await p.send(post('basketorder', BASKET))).toEqual(pageError(ONE_AT_A_TIME))
  expect(await p.send(post('placeorder', ORDER))).toEqual({
    status: 409,
    body: { status: 'error', message: ONE_AT_A_TIME },
  })
  p.held.cancelAll()
  for (const r of held) expect(await r).toEqual(pageError(CANCELLED_COPY))
})

test('heldRefusal: a basket hears 200 with the message, whatever the status; the other writes their status', () => {
  expect(heldRefusal('basketorder', 403, 'Semi-Auto')).toEqual(pageError('Semi-Auto'))
  expect(heldRefusal('basketorder', 502, 'checking')).toEqual(pageError('checking'))
  expect(heldRefusal('placeorder', 403, 'Semi-Auto')).toEqual({
    status: 403,
    body: { status: 'error', message: 'Semi-Auto' },
  })
})
