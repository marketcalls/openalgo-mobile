// Request budgets and error handling: what the app sends, and what it stops sending.

import { ApiError } from '~/core/http/errors'
import { FundsSchema, MultiQuotesSchema, QuotesSchema } from '~/core/http/schemas'
import { shouldRetryQuery } from '~/core/query/queryClient'
import { useConnection } from '~/core/services/connection'
import {
  type App,
  apiCalls,
  makeApp,
  PROFILE_IDS,
  sleep,
  until,
  WRONG_KEY,
} from '../helpers/compatApp'
import { type MockServerProcess, startMockServerProcess } from '../helpers/mockServer'

// A Tuesday 09:30 IST, so the market is open however late the suite runs. The clock moves on.
const T0 = Date.UTC(2026, 10, 24, 4, 0)
const marketClock = () => {
  const start = Date.now()
  return () => T0 + (Date.now() - start)
}
const WATCHLIST = ['RELIANCE', 'TCS', 'INFY'].map((symbol) => ({ symbol, exchange: 'NSE' }))
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
const diff = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(b)
      .map(([k, v]) => [k, v - (a[k] ?? 0)] as const)
      .filter(([, v]) => v > 0),
  )

const mocks: MockServerProcess[] = []
const apps: App[] = []
async function startMock(env: Record<string, string>) {
  const m = await startMockServerProcess(env)
  mocks.push(m)
  return m
}
async function startApp(m: MockServerProcess, o: Parameters<typeof makeApp>[1] = {}) {
  const a = await makeApp(m, o)
  apps.push(a)
  return a
}
afterEach(async () => {
  for (const a of apps.splice(0)) a.dispose()
  await Promise.all(mocks.splice(0).map((m) => m.stop()))
})

/** The unlock's broker check has answered, so it is not counted in a window. */
const settled = async () => {
  await until(() => useConnection.getState().brokerSession === 'active', 3000, 'broker checked')
  await sleep(300)
}

const kindOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    if (e instanceof ApiError) return e.kind
    throw e
  }
  return 'resolved'
}

describe('errors', () => {
  test.each(PROFILE_IDS)('%s: a wrong key is KeyInvalid after one search', async (p) => {
    const m = await startMock({ PROFILE: p })
    const app = await startApp(m, { key: WRONG_KEY })
    // the unlock's broker check, the feed's auth error and this call all meet one search
    expect(await kindOf(app.api.call('funds', {}, FundsSchema))).toBe('KeyInvalid')
    await until(() => useConnection.getState().keyState === 'invalid', 3000, 'key invalid')
    await sleep(1000)
    expect((await m.stats()).requests.search).toBe(1)
  })

  test.each(PROFILE_IDS)('%s: a logged-out broker is BrokerLoggedOut', async (p) => {
    const m = await startMock({ PROFILE: p })
    await m.control({ brokerLoggedOut: true })
    const app = await startApp(m)
    expect(await kindOf(app.api.call('funds', {}, FundsSchema))).toBe('BrokerLoggedOut')
    expect(useConnection.getState()).toMatchObject({
      keyState: 'ok',
      brokerSession: 'logged_out',
    })
  })

  test.each(PROFILE_IDS)('%s: both ban forms are IpBanned, then silence for 10 s', async (p) => {
    const forms = ['text', 'json'] as const
    // Both forms run side by side, so the 10 s window is paid once.
    await Promise.all(
      forms.map(async (form) => {
        const m = await startMock({ PROFILE: p })
        const app = await startApp(m)
        await until(() => app.realtime.status().state === 'live', 3000, 'live')
        await m.control({ banned: form })
        expect(await kindOf(app.api.call('funds', {}, FundsSchema))).toBe('IpBanned')
        expect(useConnection.getState().banned).not.toBeNull()

        // the feed is stopped; a dropped socket must not bring it back
        await m.control({ closeSockets: 1006 })
        await sleep(200)
        const flat = await m.stats()
        const fetched = app.fetchCalls()
        expect(await kindOf(app.api.call('funds', {}, FundsSchema))).toBe('IpBanned')
        await sleep(10_000)
        const end = await m.stats()
        expect(end.requests).toEqual(flat.requests)
        expect(end.wsConnections).toBe(flat.wsConnections)
        expect(end.wsAuthAttempts).toBe(flat.wsAuthAttempts)
        expect(app.fetchCalls()).toBe(fetched)
      }),
    )
  })

  test.each(PROFILE_IDS)('%s: each 429 shape is RateLimited behind a 2 s gate', async (p) => {
    const m = await startMock({ PROFILE: p })
    for (const shape of ['restx', 'busy', 'nginx'] as const) {
      await m.control({ rateLimited: false })
      const app = await startApp(m)
      await m.control({ rateLimited: shape })
      expect(
        await kindOf(app.api.call('quotes', { symbol: 'RELIANCE', exchange: 'NSE' }, QuotesSchema)),
      ).toBe('RateLimited')
      expect(app.scheduler.stats().gated).toContain('quotes')

      // The mock recovers at once, but the gate holds the next read for about 2 s.
      await m.control({ rateLimited: false })
      const at = Date.now()
      await app.api.call('quotes', { symbol: 'RELIANCE', exchange: 'NSE' }, QuotesSchema)
      const waited = Date.now() - at
      expect(waited).toBeGreaterThanOrEqual(1800)
      expect(waited).toBeLessThan(3500)
      app.dispose()
      apps.pop()
    }
  })
})

describe('budgets', () => {
  test.each(PROFILE_IDS)('%s: a live watchlist makes one multiquotes call in 10 s', async (p) => {
    const m = await startMock({ PROFILE: p })
    const app = await startApp(m)
    await until(() => app.realtime.status().state === 'live', 3000, 'live')
    await settled()
    const before = (await m.stats()).requests

    // what the Watchlist tab does: one seed, a socket subscription and a polling consumer
    const keys = WATCHLIST.map((w) => `${w.exchange}:${w.symbol}`)
    const seed = await app.api.call('multiquotes', { symbols: WATCHLIST }, MultiQuotesSchema)
    expect(seed).toHaveLength(WATCHLIST.length)
    for (const w of WATCHLIST) app.realtime.acquire({ ...w, mode: 2 })
    app.polling.register({ kind: 'quotes', keys: () => keys }, true)
    await sleep(10_000)

    const sent = diff(before, (await m.stats()).requests)
    expect(sent).toEqual({ multiquotes: 1 })
    expect(app.store.get(keys[0] as string)?.source).toBe('ws')
  })

  test.each(PROFILE_IDS)(
    '%s: home-rate polling makes at most 6 multiquotes calls in 10 s',
    async (p) => {
      const m = await startMock({ PROFILE: p, WS_PORT: 'off' })
      const app = await startApp(m, { wsUrl: null, now: marketClock() })
      await until(() => app.realtime.status().state === 'polling', 3000, 'polling')
      await settled()
      const before = (await m.stats()).requests

      const keys = WATCHLIST.map((w) => `${w.exchange}:${w.symbol}`)
      app.polling.register({ kind: 'quotes', keys: () => keys }, true)
      // what the rows show, sampled each second: polling must keep them moving
      const seen = new Map(keys.map((k) => [k, new Set<number>()]))
      for (let i = 0; i < 10; i++) {
        await sleep(1000)
        for (const k of keys) {
          const ltp = app.store.get(k)?.ltp
          if (ltp !== undefined) seen.get(k)?.add(ltp)
        }
      }

      const sent = diff(before, (await m.stats()).requests)
      expect(Object.keys(sent)).toEqual(['multiquotes'])
      expect(sent.multiquotes).toBeGreaterThanOrEqual(3)
      expect(sent.multiquotes).toBeLessThanOrEqual(6)
      expect(app.store.get(keys[0] as string)?.source).toBe('poll')
      expect([...seen.values()].some((prices) => prices.size > 1)).toBe(true)
    },
  )

  test.each([
    ['403 from a proxy', { status: 403, body: '<html>Forbidden</html>', contentType: 'text/html' }],
    ['404 from a proxy', { status: 404, body: '<html>Not Found</html>', contentType: 'text/html' }],
    ['404 JSON', { status: 404, body: { status: 'error', message: 'Not found' } }],
  ])('no request repeats after a %s', async (_name, failure) => {
    const m = await startMock({ PROFILE: '2.0.3.5' })
    const app = await startApp(m)
    await sleep(300)
    const before = (await m.stats()).requests

    // The failure is one-shot: a retry would succeed, so a second request would show.
    await m.control({ failNext: { path: 'quotes', ...failure } })
    const retry = app.queryClient.getDefaultOptions().queries?.retry
    expect(retry).toBe(shouldRetryQuery)
    const q = app.queryClient.fetchQuery({
      queryKey: ['compat', 'quotes'],
      queryFn: () => app.api.call('quotes', { symbol: 'RELIANCE', exchange: 'NSE' }, QuotesSchema),
      retry: retry as typeof shouldRetryQuery,
      retryDelay: 10,
    })
    await expect(q).rejects.toBeInstanceOf(ApiError)
    await sleep(1000)
    expect(diff(before, (await m.stats()).requests).quotes).toBe(1)
    expect(sum(apiCalls(diff(before, (await m.stats()).requests)))).toBe(1)
  })
})
