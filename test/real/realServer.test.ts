// Checks the app's layers against a real OpenAlgo test server: the openalgo checkout on this Mac,
// in analyzer mode and logged in to the broker, never the live trading server. The suite reads
// the mode and never toggles it. `.env.test.local` holds the address and key; the key is never
// printed.
//
// The server is logged in to a real broker, and its mode can flip from the web or a strategy at
// any moment (Review Focus 2), so every write reads the mode just before it goes and refuses in
// LIVE, and every write reply must carry the sandbox tag: one that does not went to the broker,
// and is undone at once (the order cancelled, the buy sold back).
import { WebSocket } from 'ws'
import { type Capabilities, VERSION_GATES } from '~/core/capabilities/gates'
import { createCapabilityStore } from '~/core/capabilities/store'
import { profileStorage } from '~/core/config/storage'
import { atLeast } from '~/core/config/version'
import { checkKey } from '~/core/credentials/status'
import { createHttpClient, type HttpClient } from '~/core/http/client'
import { AnalyzerSchema, DepthSchema, FundsSchema, MultiQuotesSchema } from '~/core/http/schemas'
import { isExchangeOpen } from '~/core/realtime/marketHours'
import { type Inbound, parseInbound } from '~/core/realtime/protocol'
import { createTickStore } from '~/core/realtime/tickStore'
import { createRealtime, type WebSocketCtor } from '~/core/realtime/wsClient'
import { capabilityReport } from '~/features/account/diagnostics'
import { feedStep, keyStep, serverStep } from '~/features/onboarding/flow'
import type { OrderRow } from '~/market/books/schemas'
import { SymbolSchema, toMeta } from '~/market/instruments/meta'
import { snapTick } from '~/market/instruments/tick'
import { createOrderApi } from '~/market/orders/api'
import { memoryKV } from '../helpers/memoryKV'
import { loadTestEnv, type TestEnv } from './env'

const LIVE_MODE = 'Test server is in LIVE mode. Switch it to the analyzer on the web first.'
type AckEntry = Extract<Inbound, { t: 'sub_ack' }>['entries'][number]
const TICK_WITHIN_MS = 10_000
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`)
    await wait(25)
  }
}

const env = loadTestEnv()
if (!env) {
  test.skip('no .env.test.local', () => {})
} else {
  suite(env)
}

function suite({ url, key, wsUrl }: TestEnv) {
  describe('the real test server', () => {
    let origin = ''
    let caps: Capabilities
    let http: HttpClient
    let mode: 'live' | 'analyze' | null = null

    // Every test but the first refuses to run unless the first saw the analyzer.
    const safe = () => {
      if (mode !== 'analyze') throw new Error(LIVE_MODE)
    }

    /** Just before each write: the mode read now, never the first test's reading. */
    const stillAnalyzer = async () => {
      const a = await http.request('analyzer', {}, AnalyzerSchema)
      mode = a.mode
      if (mode !== 'analyze') throw new Error(LIVE_MODE)
    }

    /** A write reply without the sandbox tag went to the broker (C4). */
    const LIVE_REPLY = 'A write reply had no sandbox tag: it went to the broker.'

    beforeAll(async () => {
      const step = await serverStep(url, { fetch, allowDevHosts: true, now: Date.now })
      if (step.kind === 'ok') {
        origin = step.url
        caps = step.caps
        http = createHttpClient({
          origin,
          fetch,
          getKey: () => key,
          resolveAuth403: async () => 'broker_logged_out',
        })
      }
    })

    test('the server is in the analyzer, not live mode', async () => {
      const a = await http.request('analyzer', {}, AnalyzerSchema)
      mode = a.mode
      if (mode !== 'analyze') throw new Error(LIVE_MODE)
    })

    test('probeServer is ok, and the capability report', () => {
      safe()
      expect(caps).toBeDefined()
      const rows = capabilityReport(caps)
      console.info(
        `server ${origin} version ${caps.version ?? 'unknown'} (${caps.versionSource})\n` +
          rows.map((r) => `  ${r.on ? 'on ' : 'off'} ${r.feature}: ${r.reason}`).join('\n'),
      )
      expect(rows.length).toBeGreaterThan(0)
    })

    test('the key is accepted', async () => {
      safe()
      expect(await checkKey(http)).toBe('ok')
    })

    test('the broker session is active, with a broker name', async () => {
      safe()
      const r = await keyStep(origin, key, { fetch })
      expect(r).toMatchObject({ kind: 'ok', brokerSession: 'active' })
      if (r.kind === 'ok') expect(r.broker).toEqual(expect.any(String))
    })

    test('multiquotes for NSE:RELIANCE has an ltp, and depth has 5 bids', async () => {
      safe()
      const results = await http.request(
        'multiquotes',
        { symbols: [{ symbol: 'RELIANCE', exchange: 'NSE' }] },
        MultiQuotesSchema,
      )
      expect(results[0]?.data?.ltp).toEqual(expect.any(Number))
      const depth = await http.request(
        'depth',
        { symbol: 'RELIANCE', exchange: 'NSE' },
        DepthSchema,
      )
      expect(depth.bids).toHaveLength(5)
    })

    async function makeRealtime(WebSocketImpl = WebSocket as unknown as WebSocketCtor) {
      const store = createTickStore((flush) => void setTimeout(flush, 16))
      const capStore = createCapabilityStore(profileStorage(memoryKV(), 'p0123456789ab'))
      await capStore.save(caps)
      const realtime = createRealtime({
        url: () => wsUrl,
        feedMode: () => 'live',
        getKey: () => key,
        WebSocketImpl,
        lastFeedRetryAt: () => null,
        store,
        caps: capStore,
        isExchangeOpen,
        onBrokerError: async () => 'unknown',
        onKeyInvalid: () => {},
        on1012: () => {},
        onSilence: () => {},
        onOrderUpdate: () => {},
        onResync: () => {},
        onPollingRetry: () => {},
      })
      return { realtime, store, capStore }
    }

    const live = wsUrl ? describe : describe.skip
    live('the live feed', () => {
      const ws = WebSocket as unknown as WebSocketCtor

      test('testLiveFeed is ok', async () => {
        safe()
        const r = await feedStep(wsUrl as string, key, { WebSocketImpl: ws })
        expect(r.mode).toBe('live')
        expect('reason' in r).toBe(false)
      })

      test('a mode-3, depth-5 subscription is acked, with 5 levels in a tick while NSE is open', async () => {
        safe()
        // ws's WebSocket, also keeping the subscribe acks the client receives: the ack comes at
        // any hour, but a depth tick (and so confirmedDepth) only while the broker sends ticks.
        const acks: AckEntry[] = []
        class Recording extends WebSocket {
          constructor(address: string) {
            super(address)
            this.addEventListener('message', (ev) => {
              const m = typeof ev.data === 'string' ? parseInbound(ev.data) : null
              if (m?.t === 'sub_ack') acks.push(...m.entries)
            })
          }
        }
        const { realtime, store } = await makeRealtime(Recording as unknown as WebSocketCtor)
        try {
          realtime.start()
          const release = realtime.acquire({
            exchange: 'NSE',
            symbol: 'RELIANCE',
            mode: 3,
            depth: 5,
          })
          const reliance = () => acks.find((e) => e.exchange === 'NSE' && e.symbol === 'RELIANCE')
          await until(() => reliance() !== undefined, 10_000, 'the subscription ack')
          expect(reliance()).toMatchObject({ ok: true, depth: 5 })
          expect(realtime.isLive('NSE', 'RELIANCE')).toBe(true)
          if (isExchangeOpen('NSE', Date.now())) {
            await until(
              () => realtime.confirmedDepth('NSE', 'RELIANCE') !== undefined,
              TICK_WITHIN_MS,
              'a depth tick',
            )
            expect(realtime.confirmedDepth('NSE', 'RELIANCE')).toBe(5)
            expect(store.get('NSE:RELIANCE')?.source).toBe('ws')
          }
          release()
        } finally {
          realtime.stop()
        }
      })

      test('subscribe_orders behaves as the version says', async () => {
        safe()
        const { realtime, capStore } = await makeRealtime()
        try {
          realtime.start()
          await until(() => capStore.ws().orderStream !== null, 10_000, 'orderStream known')
          if (caps.version !== null) {
            expect(capStore.ws().orderStream).toBe(atLeast(caps.version, VERSION_GATES.orderStream))
          }
        } finally {
          realtime.stop()
        }
      })
    })

    // The app's order and book calls, over the real client: the scheduler and field gate are
    // not under test here.
    const orders = () =>
      createOrderApi({ call: (id, body, schema, o) => http.request(id, body, schema, o) })

    describe('books and metadata', () => {
      test('orderbook, tradebook, positionbook, holdings and funds all parse, none dropped', async () => {
        safe()
        const api = orders()
        const [ob, tb, pb, hd, funds] = await Promise.all([
          api.orderbook(),
          api.tradebook(),
          api.positionbook(),
          api.holdings(),
          http.request('funds', {}, FundsSchema),
        ])
        console.info(
          `dropped: orderbook ${ob.dropped}, tradebook ${tb.dropped}, positionbook ${pb.dropped}, holdings ${hd.dropped}`,
        )
        expect([ob.dropped, tb.dropped, pb.dropped, hd.dropped]).toEqual([0, 0, 0, 0])
        expect(funds.availablecash).toEqual(expect.any(Number))
      })

      test('/symbol RELIANCE gives a lot size and a tick', async () => {
        safe()
        const meta = toMeta(
          await http.request('symbol', { symbol: 'RELIANCE', exchange: 'NSE' }, SymbolSchema),
        )
        expect(meta.lotsize).toBeGreaterThanOrEqual(1)
        expect(meta.tick).toBeGreaterThan(0)
      })
    })

    describe('analyzer orders', () => {
      async function reliance() {
        const meta = toMeta(
          await http.request('symbol', { symbol: 'RELIANCE', exchange: 'NSE' }, SymbolSchema),
        )
        const q = await http.request(
          'multiquotes',
          { symbols: [{ symbol: 'RELIANCE', exchange: 'NSE' }] },
          MultiQuotesSchema,
        )
        const ltp = q[0]?.data?.ltp
        if (typeof ltp !== 'number' || !(ltp > 0)) throw new Error('RELIANCE has no ltp')
        return { tick: meta.tick, ltp }
      }

      const find = async (id: string) =>
        (await orders().orderbook({ fresh: true })).orders.find((o) => o.orderid === id)

      async function untilOrder(id: string, ok: (o: OrderRow) => boolean, what: string) {
        let last: OrderRow | undefined
        const end = Date.now() + 15_000
        while (Date.now() < end) {
          last = await find(id)
          if (last && ok(last)) return last
          await wait(500)
        }
        throw new Error(`${what}: not within 15000 ms (last ${last?.status ?? 'absent'})`)
      }

      test('place a LIMIT BUY below the market, modify its price, cancel it', async () => {
        safe()
        const api = orders()
        const { tick, ltp } = await reliance()
        const price = snapTick(ltp * 0.9, tick, ltp)
        await stillAnalyzer()
        const placed = await api.place({
          exchange: 'NSE',
          symbol: 'RELIANCE',
          action: 'BUY',
          quantity: 1,
          pricetype: 'LIMIT',
          product: 'CNC',
          price,
          trigger_price: 0,
        })
        if (placed.kind !== 'placed') throw new Error(`place answered ${placed.kind}`)
        const id = placed.orderid
        if (!placed.analyze) {
          // a real order at the broker: cancel it before anything else
          await api.cancel(id).catch(() => {})
          throw new Error(LIVE_REPLY)
        }
        try {
          const open = await untilOrder(id, (o) => o.status === 'open', 'the order is open')
          expect(open.price).toBe(price)

          const next = snapTick(ltp * 0.91, tick, ltp)
          expect(next).not.toBe(price)
          await stillAnalyzer()
          const m = await api.modify(open, { price: next })
          expect(m).toMatchObject({ kind: 'ok', analyze: true })
          const changed = await untilOrder(id, (o) => o.price === next, 'the price changes')
          expect(changed.price).toBe(next)

          await stillAnalyzer()
          const c = await api.cancel(id)
          expect(c).toMatchObject({ kind: 'ok', analyze: true })
          const gone = await untilOrder(
            id,
            (o) => o.status === 'cancelled',
            'the order is cancelled',
          )
          expect(gone.status).toBe('cancelled')
        } catch (e) {
          // Leave nothing working in the sandbox; in LIVE the order is not the sandbox's to touch.
          if (
            await stillAnalyzer().then(
              () => true,
              () => false,
            )
          ) {
            await api.cancel(id).catch(() => {})
          }
          throw e
        }
      })

      const whileOpen = isExchangeOpen('NSE', Date.now()) ? test : test.skip
      whileOpen('MARKET BUY 1 CNC, then smartClose leaves the position flat', async () => {
        safe()
        const api = orders()
        const spec = {
          exchange: 'NSE',
          symbol: 'RELIANCE',
          action: 'BUY' as const,
          quantity: 1,
          pricetype: 'MARKET' as const,
          product: 'CNC' as const,
          price: 0,
          trigger_price: 0,
        }
        const position = async () =>
          (await api.positionbook({ fresh: true })).rows.find(
            (r) => r.symbol === 'RELIANCE' && r.exchange === 'NSE' && r.product === 'CNC',
          )
        await stillAnalyzer()
        const placed = await api.place(spec)
        if (placed.kind !== 'placed') throw new Error(`place answered ${placed.kind}`)
        if (!placed.analyze) {
          // a real buy at the broker: sell exactly that back at once (a smart close would act on
          // the whole net position, which may hold quantity that is not this test's)
          await api.place({ ...spec, action: 'SELL' }).catch(() => {})
          throw new Error(LIVE_REPLY)
        }
        let row: Awaited<ReturnType<typeof position>>
        let closed = false
        try {
          const end = Date.now() + 15_000
          while (Date.now() < end) {
            row = await position()
            if (row && row.quantity > 0) break
            await wait(500)
          }
          if (!row || !(row.quantity > 0)) throw new Error('the position did not open')
          await stillAnalyzer()
          const close = await api.smartClose(row)
          closed = true
          expect(close).toMatchObject({ kind: 'placed', analyze: true })
          const flatEnd = Date.now() + 15_000
          let qty = row.quantity
          while (Date.now() < flatEnd && qty !== 0) {
            await wait(500)
            qty = (await position())?.quantity ?? 0
          }
          expect(qty).toBe(0)
        } finally {
          // Leave no sandbox position open: close it if this test did not get to. Only in the
          // analyzer: in LIVE the close would act on the broker's position instead.
          const open = await position().catch(() => undefined)
          if (!closed && open && open.quantity !== 0) {
            if (
              await stillAnalyzer().then(
                () => true,
                () => false,
              )
            ) {
              await api.smartClose(open).catch(() => {})
            } else console.warn('the server is in LIVE mode: a sandbox RELIANCE position is left')
          }
        }
      })
    })

    // Plan B: the checks below arrive with the screens they cover.
    test.todo('tool: portfolio backtest')
    test.todo('tool: SIP backtest')
    test.todo('tool: sector rotation')
    test.todo('tool: option chain with greeks')
  })
}
