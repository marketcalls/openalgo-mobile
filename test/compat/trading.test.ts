// Every order path of the app against the stock-server mock, over a real socket and Node's fetch,
// on each version profile.

import { ApiError } from '~/core/http/errors'
import { reconcileClose, reconcilePlacement, reconcileSplit } from '~/market/orders/reconcile'
import type { OrderSpec } from '~/market/orders/schemas'
import { PROFILE_IDS, until } from '../helpers/compatApp'
import { type MockServerProcess, startMockServerProcess } from '../helpers/mockServer'
import { type TradingHarness, tradingHarness } from '../helpers/tradingHarness'

const C5_MODIFY =
  'Modify order operation is not allowed in Semi-Auto mode. Please switch to Auto mode to modify orders.'

const market = (o: Partial<OrderSpec> = {}): OrderSpec => ({
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'BUY',
  quantity: 10,
  pricetype: 'MARKET',
  product: 'MIS',
  price: 0,
  trigger_price: 0,
  ...o,
})
const limit = (o: Partial<OrderSpec> = {}) => market({ pricetype: 'LIMIT', price: 100, ...o })
// 28 lots of 65 is 1,820 units: one child at the freeze quantity 1,800 and one of 20.
const FUT: OrderSpec = {
  exchange: 'NFO',
  symbol: 'NIFTY30DEC26FUT',
  action: 'BUY',
  quantity: 28 * 65,
  pricetype: 'MARKET',
  product: 'NRML',
  price: 0,
  trigger_price: 0,
}

let mock: MockServerProcess | null = null
let h: TradingHarness | null = null
afterEach(async () => {
  h?.dispose()
  h = null
  await mock?.stop()
  mock = null
})

async function start(env: Record<string, string>): Promise<TradingHarness> {
  mock = await startMockServerProcess(env)
  h = await tradingHarness(mock)
  return h
}

/** The orderid of a placed order, from a `done` outcome. */
function placedId(o: Awaited<ReturnType<TradingHarness['submit']>>): string {
  if (o.kind !== 'done') throw new Error(`not done: ${o.kind}`)
  const r = o.reply as { kind: string; orderid?: string }
  if (r.kind !== 'placed' || !r.orderid) throw new Error(`not placed: ${r.kind}`)
  return r.orderid
}

/** The only order in the book. */
async function onlyOrder(t: TradingHarness) {
  const [row, ...rest] = await bookOrders(t)
  if (!row || rest.length) throw new Error('expected exactly one order in the book')
  return row
}

async function bookOrders(t: TradingHarness) {
  return (await t.orders.orderbook({ fresh: true })).orders
}

describe.each(PROFILE_IDS)('%s', (profile) => {
  describe('analyzer orders', () => {
    test('MARKET is placed with analyze, and the position shows', async () => {
      const t = await start({ PROFILE: profile })
      await t.control({ analyzer: true })
      const out = await t.submit('place', () => t.orders.place(market()), 'analyze')
      expect(out).toMatchObject({
        kind: 'done',
        reply: { kind: 'placed', analyze: true },
      })
      const { rows } = await t.orders.positionbook({ fresh: true })
      expect(rows.find((r) => r.symbol === 'RELIANCE')).toMatchObject({
        quantity: 10,
      })
    })

    test('LIMIT is open; modify sends all fields and changes the price; cancel cancels', async () => {
      const t = await start({ PROFILE: profile })
      await t.control({ analyzer: true })
      const id = placedId(await t.submit('place', () => t.orders.place(limit()), 'analyze'))
      const row = await onlyOrder(t)
      expect(row).toMatchObject({ orderid: id, status: 'open', price: 100 })

      const mod = await t.submit('modify', () => t.orders.modify(row, { price: 105 }), 'analyze')
      expect(mod).toMatchObject({
        kind: 'done',
        reply: { kind: 'ok', orderid: id },
      })
      const sent = (await t.stats()).lastBody.modifyorder ?? {}
      // The 11 C3 fields besides the apikey, which the mock leaves out.
      expect(Object.keys(sent).sort()).toEqual(
        [
          'action',
          'disclosed_quantity',
          'exchange',
          'orderid',
          'price',
          'pricetype',
          'product',
          'quantity',
          'strategy',
          'symbol',
          'trigger_price',
        ].sort(),
      )
      expect((await bookOrders(t))[0]?.price).toBe(105)

      const cancel = await t.submit('cancel', () => t.orders.cancel(id), 'analyze')
      expect(cancel.kind).toBe('done')
      expect((await bookOrders(t))[0]?.status).toBe('cancelled')
    })
  })

  describe('an unknown outcome', () => {
    test('a 502 after the order was taken is maybe, then reconcile finds it, with one request', async () => {
      const t = await start({ PROFILE: profile })
      await t.control({
        failNext: { path: 'placeorder', status: 502, afterApply: true },
      })
      const sentAt = Date.now()
      const out = await t.submit('place', () => t.orders.place(market()), 'live')
      expect(out).toEqual({ kind: 'maybe' })
      const r = await reconcilePlacement({
        fetchOrders: () => t.orders.orderbook({ fresh: true }),
        spec: market(),
        sentAt,
        knownIds: new Set(),
        sleep: t.sleep,
        delaysMs: t.delaysMs,
      })
      expect(r.found).toMatchObject({ symbol: 'RELIANCE', quantity: 10 })
      expect((await t.stats()).requests.placeorder).toBe(1)
    })

    test('a 502 without the order is maybe, and the book shows nothing after 3 reads', async () => {
      const t = await start({ PROFILE: profile })
      await t.control({ failNext: { path: 'placeorder', status: 502 } })
      const out = await t.submit('place', () => t.orders.place(market()), 'live')
      expect(out).toEqual({ kind: 'maybe' })
      const r = await reconcilePlacement({
        fetchOrders: () => t.orders.orderbook({ fresh: true }),
        spec: market(),
        sentAt: Date.now(),
        knownIds: new Set(),
        sleep: t.sleep,
        delaysMs: t.delaysMs,
      })
      expect(r).toEqual({ found: null, checked: true })
      const stats = await t.stats()
      expect(stats.requests.orderbook).toBe(3)
      expect(stats.requests.placeorder).toBe(1)
    })

    test('a reply later than the 15 s timeout is maybe, and the order is found', async () => {
      const t = await start({ PROFILE: profile })
      await t.control({
        delayNext: { path: 'placeorder', ms: 16_000, afterApply: true },
      })
      const sentAt = Date.now()
      const out = await t.submit('place', () => t.orders.place(market()), 'live')
      expect(out).toEqual({ kind: 'maybe' })
      const r = await reconcilePlacement({
        fetchOrders: () => t.orders.orderbook({ fresh: true }),
        spec: market(),
        sentAt,
        knownIds: new Set(),
        sleep: t.sleep,
        delaysMs: t.delaysMs,
      })
      expect(r.found).not.toBeNull()
      expect((await t.stats()).requests.placeorder).toBe(1)
    })
  })

  describe('Semi-Auto', () => {
    test('placing is queued; a live cancel is blocked with the C5 text', async () => {
      const t = await start({ PROFILE: profile })
      const id = placedId(await t.submit('place', () => t.orders.place(limit()), 'live'))
      await t.control({ semiAuto: true })
      const queued = await t.submit('place', () => t.orders.place(market()), 'live')
      expect(queued).toMatchObject({ kind: 'done', reply: { kind: 'queued' } })

      const blocked = await t.submit('cancel', () => t.orders.cancel(id), 'live')
      expect(blocked.kind).toBe('semi_auto_blocked')
      const row = await onlyOrder(t)
      const mod = await t.submit('modify', () => t.orders.modify(row, { price: 101 }), 'live')
      expect(mod).toMatchObject({ kind: 'semi_auto_blocked' })
      if (mod.kind === 'semi_auto_blocked') expect(mod.message).toContain(C5_MODIFY)
    })

    test('with the analyzer on, close all is allowed and done', async () => {
      const t = await start({ PROFILE: profile })
      await t.control({ analyzer: true, semiAuto: true })
      const out = await t.submit('closeAll', () => t.orders.closeAll(), 'analyze')
      expect(out.kind).toBe('done')
    })
  })

  describe('flat close', () => {
    test('a server error on a flat position is Server, and the positions show it closed', async () => {
      const t = await start({ PROFILE: profile })
      await t.submit('place', () => t.orders.place(market()), 'live')
      await t.submit('place', () => t.orders.place(market({ action: 'SELL' })), 'live')
      await t.control({ flatCloseError: true })
      const row = {
        symbol: 'RELIANCE',
        exchange: 'NSE',
        product: 'MIS' as const,
        quantity: 0,
      }
      const out = await t.submit('closeOne', () => t.orders.smartClose(row), 'live')
      expect(out).toMatchObject({ kind: 'error', error: { kind: 'Server' } })
      expect(out.kind === 'error' && out.error).toBeInstanceOf(ApiError)
      const closed = await reconcileClose({
        fetchPositions: () => t.orders.positionbook({ fresh: true }),
        row,
        sleep: t.sleep,
        delaysMs: t.delaysMs,
      })
      expect(closed).toBe('closed')
    })
  })

  describe('split', () => {
    test('28 lots with splitFailFrom 2 is [ok, error] from one request', async () => {
      const t = await start({ PROFILE: profile })
      await t.control({ splitFailFrom: 2 })
      const out = await t.submit('split', () => t.orders.split(FUT, 1800), 'live')
      expect(out.kind).toBe('done')
      if (out.kind !== 'done' || out.reply.kind !== 'split') throw new Error('not a split')
      expect(out.reply.children.map((c) => [c.qty, c.ok])).toEqual([
        [1800, true],
        [20, false],
      ])
      expect((await t.stats()).requests.splitorder).toBe(1)
    })

    test('a split slower than its timeout is maybe, and reconcile finds 2 of 2', async () => {
      const t = await start({ PROFILE: profile })
      await t.control({
        delayNext: {
          path: 'splitorder',
          ms: t.splitTimeoutMs + 1000,
          afterApply: true,
        },
      })
      const sentAt = Date.now()
      const out = await t.submit(
        'split',
        () =>
          t.orders.split(FUT, 1800, {
            signal: AbortSignal.timeout(t.splitTimeoutMs),
          }),
        'live',
      )
      expect(out).toEqual({ kind: 'maybe' })
      const r = await reconcileSplit({
        fetchOrders: () => t.orders.orderbook({ fresh: true }),
        spec: FUT,
        sentAt,
        knownIds: new Set(),
        children: [1800, 20],
        sleep: t.sleep,
        delaysMs: t.delaysMs,
      })
      expect(r.found.map((o) => o.quantity).sort((a, b) => a - b)).toEqual([20, 1800])
      expect((await t.stats()).requests.splitorder).toBe(1)
    })
  })

  describe('bulk and margin', () => {
    test('cancel all with 2 open cancels 2', async () => {
      const t = await start({ PROFILE: profile })
      await t.submit('place', () => t.orders.place(limit()), 'live')
      await t.submit('place', () => t.orders.place(limit({ price: 101 })), 'live')
      const out = await t.submit('cancelAll', () => t.orders.cancelAll(), 'live')
      expect(out.kind).toBe('done')
      if (out.kind === 'done') expect(out.reply.canceled).toHaveLength(2)
    })

    test('margin on a broker without it is Unsupported', async () => {
      const t = await start({ PROFILE: profile })
      await t.control({ marginUnsupported: true })
      await expect(t.orders.margin(market())).rejects.toMatchObject({
        kind: 'Unsupported',
      })
    })
  })

  test('an analyzer toggle between the review read and the send is mode_changed, with no order', async () => {
    const t = await start({ PROFILE: profile })
    const shown = await t.gate.read()
    expect(shown).toBe('live')
    await t.control({ analyzer: true })
    const out = await t.submit('place', () => t.orders.place(market()), shown)
    expect(out).toEqual({ kind: 'mode_changed', now: 'analyze' })
    expect((await t.stats()).requests.placeorder).toBeUndefined()
  })

  test('an unknown symbol is asked for once, and is unknown', async () => {
    const t = await start({ PROFILE: profile })
    expect(await t.instruments.get('NFO', 'NIFTY25NOV25FUT')).toBe('unknown')
    expect(await t.instruments.get('NFO', 'NIFTY25NOV25FUT')).toBe('unknown')
    expect(t.instruments.peek('NFO', 'NIFTY25NOV25FUT')).toBe('unknown')
    expect((await t.stats()).requests.symbol).toBe(1)
  })
})

describe('order events', () => {
  test('2.0.3.5 zerodha: the own order comes back as an order_update within 2 s', async () => {
    const t = await start({ PROFILE: '2.0.3.5', BROKER: 'zerodha' })
    await until(() => t.app.caps.ws().orderStream === true, 5000, 'orderStream')
    const seen: string[] = []
    t.bus.subscribe((u) => seen.push(u.orderid))
    const id = placedId(await t.submit('place', () => t.orders.place(limit()), 'live'))
    t.watch.expect(id)
    await until(() => seen.includes(id), 2000, 'the order_update')
    expect(t.watch.demoted()).toBe(false)
  })

  test('2.0.1.6 with orderEvents off: no event, so the watch demotes after its timeout', async () => {
    const t = await start({ PROFILE: '2.0.1.6' })
    await t.control({ orderEvents: false })
    await until(() => t.app.caps.ws().orderStream === true, 5000, 'orderStream')
    const id = placedId(await t.submit('place', () => t.orders.place(limit()), 'live'))
    t.watch.expect(id)
    expect(t.watch.demoted()).toBe(false)
    await until(() => t.watch.demoted(), 3000, 'the demotion')
  })
})
