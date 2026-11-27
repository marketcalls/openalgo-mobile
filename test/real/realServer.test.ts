// Checks the app's layers against a real OpenAlgo test server: the openalgo checkout on this Mac,
// in analyzer mode and logged in to the broker, never the live trading server. The suite reads
// the mode and never toggles it. `.env.test.local` holds the address and key; the key is never
// printed.
//
// The server is logged in to a real broker, and its mode can flip from the web or a strategy at
// any moment (Review Focus 2), so every write reads the mode just before it goes and refuses in
// LIVE, and every write reply must carry the sandbox tag: one that does not went to the broker,
// and is undone at once (the order cancelled, the buy sold back).
import { QueryClient } from '@tanstack/react-query'
import { WebSocket } from 'ws'
import { type Capabilities, VERSION_GATES } from '~/core/capabilities/gates'
import { createCapabilityStore } from '~/core/capabilities/store'
import { profileStorage } from '~/core/config/storage'
import { atLeast } from '~/core/config/version'
import { checkKey } from '~/core/credentials/status'
import { type Api, createApi, type FieldGate, type KeyedApi } from '~/core/http/api'
import { createHttpClient, type HttpClient } from '~/core/http/client'
import { createScheduler } from '~/core/http/scheduler'
import { AnalyzerSchema, DepthSchema, FundsSchema, MultiQuotesSchema } from '~/core/http/schemas'
import { createServerClock } from '~/core/http/serverClock'
import { isExchangeOpen, istDate } from '~/core/realtime/marketHours'
import { type Inbound, parseInbound } from '~/core/realtime/protocol'
import { createTickStore } from '~/core/realtime/tickStore'
import { createRealtime, type WebSocketCtor } from '~/core/realtime/wsClient'
import type { DomToNative } from '~/dom/bridge/protocol'
import { createChartFeeds } from '~/dom/chart/feeds'
import { createChartRoutes } from '~/dom/gateway/chartRoutes'
import { createRequestRouter } from '~/dom/gateway/requests'
import { createWsEmulation } from '~/dom/gateway/wsEmulation'
import { createDeviceRoutes, type RouteDeps } from '~/dom/routes'
import { createDomClient } from '~/dom/web/client'
import { capabilityReport } from '~/features/account/diagnostics'
import { feedStep, keyStep, serverStep } from '~/features/onboarding/flow'
import type { OrderRow } from '~/market/books/schemas'
import { loadCalendars } from '~/market/chart/calendar'
import { chartIntervals } from '~/market/chart/intervals'
import { HistorySchema, IntervalsSchema } from '~/market/chart/schemas'
import { createGttApi } from '~/market/gtt/api'
import type { GttRow, GttSpec } from '~/market/gtt/schemas'
import { GTT_GATES } from '~/market/gtt/support'
import { SymbolSchema, toMeta } from '~/market/instruments/meta'
import { snapTick } from '~/market/instruments/tick'
import { createSymbolMaster } from '~/market/master/master'
import { createMemoryMasterDb } from '~/market/master/memoryDb'
import { chainForward, withGreeksChain } from '~/market/options/black76'
import { createOptionsData } from '~/market/options/data'
import { expiryInstantMs, optionsExchangeOf, serverYears } from '~/market/options/expiry'
import { OptionChainSchema } from '~/market/options/schemas'
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

      // The GTT loop (design 17.3): a SINGLE SELL whose trigger is above the market, so it must
      // stay active (RF 6). The shim has no field heal, so the book's `status` needs 2.0.2.4.
      test('GTT: place a SINGLE above the market, it stays active, modify it, cancel it', async () => {
        safe()
        if (!caps.endpoints?.includes('gttorderbook') || !atLeast(caps.version, GTT_GATES.status)) {
          console.info('GTT loop skipped: the server does not list the GTT book with status')
          return
        }
        const gtt = createGttApi(
          { call: (id, body, schema, o) => http.request(id, body, schema, o) },
          { record: () => {} },
        )
        const { tick, ltp } = await reliance()
        const at = (f: number) => snapTick(ltp * f, tick, ltp)
        const spec = (trigger: number): GttSpec => ({
          type: 'SINGLE',
          exchange: 'NSE',
          symbol: 'RELIANCE',
          action: 'SELL',
          product: 'CNC',
          quantity: 1,
          trigger,
          price: trigger,
          above: true,
        })
        const row = async (id: string): Promise<GttRow | undefined> =>
          (await gtt.book({ fresh: true })).rows.find((r) => r.triggerId === id)

        await stillAnalyzer()
        const placed = await gtt.place(spec(at(1.2)))
        if (placed.kind !== 'ok') throw new Error(`the GTT place answered ${placed.kind}`)
        const id = placed.triggerId
        if (!placed.analyze) {
          // a real GTT at the broker: cancel it before anything else
          await gtt.cancel(id).catch(() => {})
          throw new Error(LIVE_REPLY)
        }
        try {
          // The sandbox scans every 5 s: watch for 12 s, so the first scan is in it, and fail
          // if the row ever leaves active (a trigger in the wrong field fires on that scan).
          const end = Date.now() + 12_000
          do {
            const r = await row(id)
            expect(r?.status).toBe('active')
            await wait(1000)
          } while (Date.now() < end)

          const next = at(1.25)
          await stillAnalyzer()
          const m = await gtt.modify(id, spec(next))
          expect(m).toMatchObject({ kind: 'ok', analyze: true })
          expect((await row(id))?.triggers).toEqual([next])

          await stillAnalyzer()
          const c = await gtt.cancel(id)
          expect(c).toMatchObject({ kind: 'ok', analyze: true })
          expect((await row(id))?.status).toBe('cancelled')
        } catch (e) {
          // Leave nothing active in the sandbox; in LIVE the GTT is not the sandbox's to touch.
          if (
            await stillAnalyzer().then(
              () => true,
              () => false,
            )
          ) {
            await gtt.cancel(id).catch(() => {})
          }
          throw e
        }
      }, 60_000)

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

    describe('chart', () => {
      const api = (): Pick<Api, 'call'> => ({
        call: (id, body, schema, o) => http.request(id, body, schema, o),
      })
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

      test('chart: 5m history for NSE RELIANCE over 5 days, ascending', async () => {
        safe()
        const now = Date.now()
        // 5 trading days can span 9 calendar days, over a weekend and a holiday
        const { rows, dropped } = await http.request(
          'history',
          {
            symbol: 'RELIANCE',
            exchange: 'NSE',
            interval: '5m',
            start_date: day(now - 9 * 86_400_000),
            end_date: day(now),
          },
          HistorySchema,
        )
        expect(dropped).toBe(0)
        expect(rows.length).toBeGreaterThan(0)
        const times = rows.map((r) => r.timestamp)
        expect(times).toEqual([...times].sort((a, b) => a - b))
        expect(new Set(times).size).toBe(times.length)
      })

      test("chart: intervals include 5m and D; the calendar's NSE window is 09:15–15:30 IST after the TZ check", async () => {
        safe()
        const raw = await http.request('intervals', {}, IntervalsSchema)
        const offered = chartIntervals(raw, false)
        expect(offered).toEqual(expect.arrayContaining(['5m', 'D']))

        const cal = await loadCalendars(api(), Date.now())
        console.info(`chart calendar source: ${cal.source} (${istDate(Date.now())})`)
        // on 'defaults' the reads failed: the window then is the app's, so say so
        expect(cal.source).toBe('server')
        expect(cal.calendars.NSE?.sessions[0]).toMatch(/^0915-1530/)
      })

      test('chart: an emulated Depth subscription ticks within 10 s', async () => {
        safe()
        if (!wsUrl) return console.info('chart depth tick skipped: no OPENALGO_TEST_WS_URL')
        if (!isExchangeOpen('NSE', Date.now())) {
          return console.info('chart depth tick skipped: NSE is outside 09:15-15:30 IST')
        }
        const { realtime, store } = await makeRealtime()
        const emulation = createWsEmulation({
          realtime,
          store,
          // 'fail' mode never polls
          polling: { register: () => () => {} },
          orderEvents: { subscribe: () => () => {} },
          feedMode: () => 'live',
          whenPolling: 'fail',
          active: () => true,
          post: (m) => queueMicrotask(() => client.deliver([m])),
        })
        const router = createRequestRouter(createChartRoutes(api()))
        const client = createDomClient(async (m) => {
          const msg = m as DomToNative
          if (msg.kind === 'request')
            return (await router(msg, new AbortController().signal)) as never
          if (msg.kind === 'socket') emulation.handle(msg)
          return { status: 202, body: null } as never
        })
        const feeds = createChartFeeds(client)
        const depths: unknown[] = []
        try {
          realtime.start()
          feeds.live.subscribeDepth({ symbol: 'RELIANCE', exchange: 'NSE', interval: '5m' }, (d) =>
            depths.push(d),
          )
          await until(() => depths.length > 0, TICK_WITHIN_MS, 'a Depth tick')
          expect(depths.length).toBeGreaterThan(0)
          // ltt per adapter: the broker's trade time rides the depth stream too, else the library
          // would bar a new price on an old trade's minute. Read-only: nothing here is placed.
          await until(
            () => store.get('NSE:RELIANCE')?.ltt !== undefined,
            TICK_WITHIN_MS,
            'a trade time (ltt) on the Depth stream',
          )
          const ltt = store.get('NSE:RELIANCE')?.ltt ?? 0
          console.info(`chart depth ltt: ${Math.round((Date.now() - ltt) / 1000)} s old`)
          expect(Math.abs(Date.now() - ltt)).toBeLessThan(10 * 60_000)
        } finally {
          feeds.live.close()
          emulation.closeAll()
          realtime.stop()
          store.reset()
        }
      })
    })

    // The tools' routes and the Greeks (read-only: every call here is a read).
    const toolDeps = () => {
      const fields: FieldGate = { adapt: (_id, body) => body, markUnsupported: () => {} }
      const api: KeyedApi = createApi({ http, scheduler: createScheduler(), fields })
      const clock = createServerClock(() => Date.now())
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const options = createOptionsData({ api, queryClient, pid: 'p0123456789ab', clock })
      const master = createSymbolMaster({
        api,
        db: Promise.resolve(createMemoryMasterDb()),
        pid: 'p0123456789ab',
        now: Date.now,
      })
      const deps: RouteDeps = { options, master, api, now: clock.now }
      return { api, options, master, deps, clock }
    }
    const nearest = async (options: ReturnType<typeof toolDeps>['options']) => {
      const list = await options.expiries('NFO', 'NIFTY', 'options')
      const first = list[0]
      if (first === undefined) throw new Error('no NIFTY option expiry listed')
      return first.replaceAll('-', '')
    }
    const isSuccess = (b: unknown) => (b as { status?: string } | null)?.status === 'success'

    test('tools: each on-device route answers success for NIFTY nearest expiry', async () => {
      safe()
      const { options, deps } = toolDeps()
      const routes = createDeviceRoutes(deps)
      const expiry_date = await nearest(options)
      const body = { underlying: 'NIFTY', exchange: 'NFO', expiry_date }
      const ask = async (method: 'GET' | 'POST', path: string, x: object) => {
        const r = routes.find((v) => v.method === method && v.path === path)
        if (!r) throw new Error(`no route ${method} ${path}`)
        const reply = await r.handle(
          { v: 1, kind: 'request', rid: 1, method, path, ...x },
          new AbortController().signal,
        )
        return { path, status: reply.status, ok: isSuccess(reply.body) }
      }
      const got = [
        await ask('GET', '/search/api/underlyings', { query: { exchange: 'NFO' } }),
        await ask('GET', '/search/api/expiries', {
          query: { exchange: 'NFO', underlying: 'NIFTY', instrumenttype: 'options' },
        }),
        await ask('POST', '/oitracker/api/oi-data', { body }),
        await ask('POST', '/oitracker/api/maxpain', { body }),
        await ask('POST', '/ivsmile/api/iv-smile-data', { body }),
        await ask('POST', '/gex/api/gex-data', { body }),
        await ask('POST', '/gammadensity/api/gamma-data', { body }),
      ]
      expect(got.map((g) => ({ ...g, status: g.status }))).toEqual(
        got.map((g) => ({ path: g.path, status: 200, ok: true })),
      )
    })

    test('tools: the with_greeks mode matches the server on ≥ 98% of legs, the rest within one unit in the last place', async () => {
      safe()
      if (!atLeast(caps.version, '2.0.2.0')) {
        console.info(`with_greeks needs 2.0.2.0; this server is ${caps.version ?? 'unknown'}`)
        return
      }
      const { options } = toolDeps()
      const expiry_date = await nearest(options)
      const raw = await http.request(
        'optionchain',
        { underlying: 'NIFTY', exchange: 'NFO', expiry_date, strike_count: 25, with_greeks: true },
        OptionChainSchema,
      )
      expect(raw.greeks_included).toBe(true)
      const expiryMs =
        typeof raw.expiry_ts === 'number'
          ? raw.expiry_ts * 1000
          : expiryInstantMs(raw.expiry_date, optionsExchangeOf('NFO'))
      expect(expiryMs).not.toBeNull()
      // priced at the server's own clock, from the forward the chain names
      const now = (raw.server_ts ?? Date.now() / 1000) * 1000
      const forward =
        raw.forward_price ?? chainForward(raw.chain, raw.atm_strike, raw.underlying_ltp)
      const mine = withGreeksChain(raw.chain, {
        forward,
        years: serverYears(expiryMs ?? 0, now).years,
      })
      const UNIT = { iv: 0.01, delta: 1e-4, gamma: 1e-6, theta: 1e-4, vega: 1e-4 } as const
      const FIELD = {
        iv: 'implied_volatility',
        delta: 'delta',
        gamma: 'gamma',
        theta: 'theta',
        vega: 'vega',
      } as const
      let legs = 0
      let exact = 0
      const misses: string[] = []
      raw.chain.forEach((row, i) => {
        for (const side of ['ce', 'pe'] as const) {
          const theirs = row[side]
          const ours = mine[i]?.[side] ?? null
          if (!theirs || theirs.delta === undefined) continue
          legs++
          const diffs = (Object.keys(UNIT) as (keyof typeof UNIT)[]).map((k) => {
            const a = theirs[FIELD[k]]
            const b = ours?.[k]
            return a === undefined || b === undefined ? Number.POSITIVE_INFINITY : Math.abs(a - b)
          })
          if (diffs.every((d) => d === 0)) exact++
          else if (!diffs.every((d, j) => d <= (Object.values(UNIT)[j] ?? 0) * 1.0001)) {
            misses.push(`${row.strike}${side}`)
          }
        }
      })
      expect(legs).toBeGreaterThan(10)
      console.info(
        `with_greeks: ${exact}/${legs} legs exact; beyond one unit: ${misses.join(' ') || 'none'}`,
      )
      expect(exact / legs).toBeGreaterThanOrEqual(0.98)
      expect(misses).toEqual([])
    })

    test('tools: the NFO instruments CSV parses and lists NIFTY and BANKNIFTY', async () => {
      safe()
      const { master } = toolDeps()
      expect(await master.ensure('NFO')).toBe('today')
      const { list, source } = await master.underlyingsNow('NFO')
      expect(source).toBe('today')
      expect(list).toEqual(expect.arrayContaining(['NIFTY', 'BANKNIFTY']))
    })

    // Plan B: the checks below arrive with the screens they cover.
    test.todo('tool: portfolio backtest')
    test.todo('tool: SIP backtest')
    test.todo('tool: sector rotation')
  })
}
