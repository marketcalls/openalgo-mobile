// Checks the app's layers against a real OpenAlgo test server: the openalgo checkout on this Mac,
// in analyzer mode and logged in to the broker, never the live trading server. The suite reads
// the mode and never toggles it. `.env.test.local` holds the address and key; the key is never
// printed.
import { WebSocket } from 'ws'
import { type Capabilities, VERSION_GATES } from '~/core/capabilities/gates'
import { createCapabilityStore } from '~/core/capabilities/store'
import { profileStorage } from '~/core/config/storage'
import { atLeast } from '~/core/config/version'
import { checkKey } from '~/core/credentials/status'
import { createHttpClient, type HttpClient } from '~/core/http/client'
import { AnalyzerSchema, DepthSchema, MultiQuotesSchema } from '~/core/http/schemas'
import { isExchangeOpen } from '~/core/realtime/marketHours'
import { type Inbound, parseInbound } from '~/core/realtime/protocol'
import { createTickStore } from '~/core/realtime/tickStore'
import { createRealtime, type WebSocketCtor } from '~/core/realtime/wsClient'
import { capabilityReport } from '~/features/account/diagnostics'
import { feedStep, keyStep, serverStep } from '~/features/onboarding/flow'
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

    // Plan B: the checks below arrive with the screens they cover.
    test.todo('books: orderbook, tradebook, positionbook, holdings')
    test.todo('analyzer orders: place a market order and read it back')
    test.todo('modify an order')
    test.todo('cancel an order')
    test.todo('tool: portfolio backtest')
    test.todo('tool: SIP backtest')
    test.todo('tool: sector rotation')
    test.todo('tool: option chain with greeks')
  })
}
