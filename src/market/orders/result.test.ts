import { ApiError } from '~/core/http/errors'
import { type Orderbook, OrderbookSchema } from '../books/schemas'
import { CHECKING } from './outcome'
import { NO_REPLY_DELAYS_MS } from './reconcile'
import {
  placementOutcome,
  type Reconcile,
  reconcileText,
  resultLine,
  type Sent,
  type TicketResult,
} from './result'
import type { PlaceReply, SplitReply } from './schemas'
import type { Outcome } from './submit'
import type { OrderPlan } from './ticket'

const SPEC = {
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'BUY' as const,
  quantity: 1,
  pricetype: 'MARKET' as const,
  product: 'CNC' as const,
  price: 0,
  trigger_price: 0,
}
const SINGLE: OrderPlan = { kind: 'single', spec: SPEC }
const SPLIT: OrderPlan = {
  kind: 'split',
  spec: { ...SPEC, quantity: 3 },
  splitsize: 2,
  orders: 2,
  children: [2, 1],
}
// Tuesday 24 Nov 2026, 09:30 IST
const T0 = Date.UTC(2026, 10, 24, 4, 0)

const row = (orderid: string, quantity = 1, status = 'open') => ({
  action: 'BUY',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  orderid,
  product: 'CNC',
  quantity: String(quantity),
  price: 0,
  pricetype: 'MARKET',
  order_status: status,
  trigger_price: 0,
  timestamp: '24-Nov-2026 09:30:01',
})
const bookOf = (rows: unknown[]): Orderbook =>
  OrderbookSchema.parse({ status: 'success', data: { orders: rows, statistics: {} } })

const sent = (o: Partial<Sent> = {}): Sent => ({
  at: T0,
  knownIds: new Set(),
  complete: true,
  ...o,
})
const noSleep = async () => {}
const outcome = (
  out: Outcome<PlaceReply | SplitReply>,
  o: { plan?: OrderPlan; sent?: Sent; fetchOrders?: () => Promise<Orderbook> } = {},
) =>
  placementOutcome(out, {
    plan: o.plan ?? SINGLE,
    sent: o.sent ?? sent(),
    fetchOrders: o.fetchOrders ?? (async () => bookOf([])),
    sleep: noSleep,
  })

/** The check of an unknown outcome, run to its end. */
async function checked(p: ReturnType<typeof outcome>): Promise<Reconcile> {
  if (p.kind !== 'unknown') throw new Error(`expected unknown, got ${p.kind}`)
  return p.check()
}

test('placed and queued replies are the result; a LIVE answer after ANALYZE says so', () => {
  const placed = { kind: 'placed' as const, orderid: 'A1', analyze: true }
  expect(outcome({ kind: 'done', reply: placed })).toEqual({ kind: 'result', result: placed })
  expect(
    outcome({ kind: 'done', reply: { ...placed, analyze: false }, liveSurprise: true }),
  ).toEqual({ kind: 'result', result: { ...placed, analyze: false, liveSurprise: true } })
  expect(outcome({ kind: 'done', reply: { kind: 'queued', pendingId: '12' } })).toEqual({
    kind: 'result',
    result: { kind: 'queued' },
  })
})

test('a success without an id is checked for the time the book lags; one with no reply reads on past the broker timeout', async () => {
  const noId = outcome({ kind: 'done', reply: { kind: 'no_id' } })
  expect(noId).toMatchObject({ kind: 'unknown' })
  expect(noId).not.toHaveProperty('waitSec')
  const noReply = outcome({ kind: 'maybe' })
  const sum = NO_REPLY_DELAYS_MS.reduce((a, b) => a + b, 0)
  expect(noReply).toMatchObject({ kind: 'unknown', waitSec: sum / 1000 })
  // a split's children may still be on their way: 30 s more per 30 children
  expect(outcome({ kind: 'maybe' }, { plan: SPLIT })).toMatchObject({ waitSec: sum / 1000 + 30 })
  // a 5xx from the order endpoint itself may hide the order too
  const server = new ApiError({ kind: 'Server', status: 500, endpoint: 'placeorder' })
  expect(outcome({ kind: 'error', error: server })).toMatchObject({ kind: 'unknown' })
})

test("the check finds the order sent, never one the review's book already held", async () => {
  const fetchOrders = async () => bookOf([row('OLD'), row('NEW')])
  expect(
    await checked(
      outcome({ kind: 'maybe' }, { fetchOrders, sent: sent({ knownIds: new Set(['NEW']) }) }),
    ),
  ).toEqual({ kind: 'single', checked: true, status: 'open', earlier: false })
  // every match is an order the book held before the send: not found
  const none = await checked(
    outcome({ kind: 'maybe' }, { fetchOrders, sent: sent({ knownIds: new Set(['OLD', 'NEW']) }) }),
  )
  expect(none).toEqual({ kind: 'single', checked: true, status: null, earlier: false })
  expect(reconcileText(none)).toBe(
    'Not in the order book yet. The server may still be sending it, so check the order book before placing it again.',
  )
  // without the review's own read, a match may be an earlier identical order (ruling 26)
  const earlier = await checked(
    outcome({ kind: 'maybe' }, { fetchOrders, sent: sent({ complete: false }) }),
  )
  expect(earlier).toMatchObject({ status: 'open', earlier: true })
  expect(reconcileText(earlier)).toBe(
    'A matching order is in the order book, but it may be an earlier one. Check the order book before trying again.',
  )
  expect(resultLine({ kind: 'maybe', check: earlier })).toBe(
    'Unclear: the match may be an older order',
  )
})

test('a book that cannot be read says so, never "not placed"', async () => {
  const failing = async (): Promise<Orderbook> => {
    throw new ApiError({ kind: 'Network', status: 0, endpoint: 'orderbook' })
  }
  const single = await checked(outcome({ kind: 'maybe' }, { fetchOrders: failing }))
  expect(single).toEqual({ kind: 'single', checked: false, status: null, earlier: false })
  expect(reconcileText(single)).toBe("Couldn't check the order book. Check it before trying again.")
  const split = await checked(outcome({ kind: 'maybe' }, { plan: SPLIT, fetchOrders: failing }))
  expect(split).toEqual({ kind: 'split', checked: false, found: 0, of: 2, earlier: false })
})

test('a split check counts the children found', async () => {
  const fetchOrders = async () => bookOf([row('C1', 2), row('C2', 1)])
  const r = await checked(outcome({ kind: 'maybe' }, { plan: SPLIT, fetchOrders }))
  expect(r).toEqual({ kind: 'split', checked: true, found: 2, of: 2, earlier: false })
  expect(reconcileText(r)).toBe('Found 2 of 2 child orders in the order book.')
})

test('refusals, Semi-Auto, a mode change and a declined confirm pass through, unsent', () => {
  const refusal = new ApiError({
    kind: 'Validation',
    status: 400,
    endpoint: 'placeorder',
    serverMessage: 'Quantity must be a multiple of the lot size',
  })
  expect(outcome({ kind: 'error', error: refusal })).toEqual({
    kind: 'refused',
    message: 'Quantity must be a multiple of the lot size',
  })
  expect(outcome({ kind: 'semi_auto_blocked', message: 'No' })).toEqual({
    kind: 'semi_auto_blocked',
    message: 'No',
  })
  expect(outcome({ kind: 'mode_changed', now: 'live' })).toEqual({
    kind: 'mode_changed',
    now: 'live',
  })
  expect(outcome({ kind: 'cancelled' })).toEqual({ kind: 'cancelled' })
})

test('the one-line result says no less than the sheet', () => {
  const lines: [TicketResult, string][] = [
    [{ kind: 'placed', orderid: 'A1', analyze: false }, 'Order placed: A1'],
    [{ kind: 'placed', orderid: 'A1', analyze: true }, 'Sandbox order placed: A1'],
    [
      { kind: 'placed', orderid: 'A1', analyze: false, liveSurprise: true },
      'LIVE order placed: A1. The server switched to LIVE after your review.',
    ],
    [{ kind: 'queued' }, 'Order queued in the web Action Center'],
    [{ kind: 'maybe', check: null }, CHECKING],
  ]
  for (const [r, line] of lines) expect(resultLine(r)).toBe(line)
})
