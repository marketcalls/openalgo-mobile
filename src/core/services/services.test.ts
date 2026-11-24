import { onlineManager } from '@tanstack/react-query'
import type { Capabilities } from '~/core/capabilities/gates'
import type { ServerProfile } from '~/core/config/profile'
import type { SecureKV } from '~/core/credentials/keyStore'
import { FundsSchema } from '~/core/http/schemas'
import { qk } from '~/core/query/keys'
import { type ConnectionState, useConnection } from '~/core/services/connection'
import { type Route, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { AUTH_OK, fakeSockets, wsError } from '../../../test/helpers/fakeSocket'
import { memoryKV } from '../../../test/helpers/memoryKV'
import {
  type AppDeps,
  bootSession,
  createServices,
  disposeServices,
  type Services,
  shellBanners,
  useSession,
} from './services'

const ORIGIN = 'https://algo.example.com'
const WS_URL = 'wss://algo.example.com/ws'
const PID = 'p0123456789ab'
const KEY = 'ab'.repeat(32)
const KEY2 = 'cd'.repeat(32)
const H = 3_600_000
// A Tuesday; 04:00 UTC is 09:30 IST, inside the NSE session.
const T0 = Date.UTC(2026, 10, 24, 4, 0)

const BAD_KEY = { status: 403, body: { status: 'error', message: 'Invalid openalgo apikey' } }
const BANNED = { status: 403, body: 'Access Denied: Your IP has been banned' }
const FUNDS_OK = { status: 200, body: { status: 'success', data: { availablecash: '320.66' } } }
const SEARCH_OK = { status: 200, body: { status: 'success', data: [] } }
const DEPTH_OK = {
  status: 200,
  body: {
    status: 'success',
    data: {
      ltp: 1424,
      bids: [{ price: 1423.9, quantity: 10 }],
      asks: [{ price: 1424.1, quantity: 7 }],
    },
  },
}
const BASE_ROUTES: Record<string, Route> = {
  'GET /auth/app-info': {
    status: 200,
    body: { status: 'success', version: '2.0.3.5', name: 'OpenAlgo' },
  },
  'GET /api/v1/swagger.json': {
    status: 200,
    body: { paths: { '/multioptiongreeks/': {}, '/funds/': {}, '/search/': {} } },
  },
  'POST /api/v1/funds': FUNDS_OK,
  'POST /api/v1/search': SEARCH_OK,
  'POST /api/v1/depth': DEPTH_OK,
}
const CAPS: Capabilities = {
  host: ORIGIN,
  version: '2.0.3.5',
  versionSource: 'app-info',
  endpoints: ['multioptiongreeks', 'funds', 'search'],
  probed: {},
  fields: {},
  ws: { orderStream: null, ping: null, close1012: true, authDeadline: true },
  probedAt: T0,
}

type SetupOptions = {
  profile?: Partial<ServerProfile>
  routes?: Record<string, Route>
  lockEnabled?: boolean
  authenticate?: () => Promise<boolean>
  storedKey?: boolean
  secureKV?: SecureKV
}

const made: Services[] = []

function setup(o: SetupOptions = {}) {
  const routes: Record<string, Route> = { ...BASE_ROUTES, ...o.routes }
  const fetch = scriptedFetch(routes)
  const ws = fakeSockets()
  const profile: ServerProfile = {
    id: PID,
    restOrigin: ORIGIN,
    wsUrl: WS_URL,
    feedMode: 'live',
    httpWarningAcked: false,
    serverVersion: '2.0.3.5',
    broker: 'zerodha',
    createdAt: T0,
    lastFeedRetryAt: null,
    ...o.profile,
  }
  const kv = memoryKV({
    'oa.profiles.v1': JSON.stringify({ activeId: PID, profiles: [profile] }),
    [`oa.${PID}.hasKey`]: '1',
    [`oa.${PID}.caps`]: JSON.stringify(CAPS),
  })
  const secure = memoryKV(o.storedKey === false ? {} : { [`oa.${PID}.apikey`]: KEY })
  const authenticate = jest.fn(o.authenticate ?? (async () => true))
  const deps: AppDeps = {
    fetch,
    WebSocketImpl: ws.WebSocketImpl,
    secureKV: o.secureKV ?? secure,
    kv,
    now: () => Date.now(),
    uuid: () => '00000000-0000-4000-8000-000000000000',
    allowDevHosts: false,
    lock: {
      settings: () => ({ enabled: o.lockEnabled ?? false, lockAfterMs: 300_000 }),
      authenticate,
      available: async () => true,
    },
  }
  const s = createServices(profile, deps)
  made.push(s)
  const nav = { go: jest.fn(), openUrl: jest.fn() }
  const count = (key: string) =>
    fetch.calls.filter((c) => `${c.method} ${c.url.slice(ORIGIN.length)}` === key).length
  const keyed = () =>
    fetch.calls.filter((c) => (c.body as Record<string, unknown> | undefined)?.apikey).length
  const banners = () => shellBanners(useConnection.getState(), s, nav)
  const banner = (id: string) => banners().find((b) => b.testID === id)
  return { s, fetch, ws, kv, secure, routes, authenticate, nav, count, keyed, banners, banner }
}

type Harness = ReturnType<typeof setup>

const flush = () => jest.advanceTimersByTimeAsync(0)

/** Cold start, unlock, then a live socket. Returns that socket. */
async function ready(h: Harness) {
  await h.s.lifecycle.coldStart()
  await h.s.lock.unlock()
  await flush()
  const sock = h.ws.last()
  sock.serverOpen()
  sock.serverSend(AUTH_OK)
  await flush()
  return sock
}

const conn = (): ConnectionState => useConnection.getState()

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  useConnection.getState().reset()
  useSession.setState({ status: 'loading', profileId: null })
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})

afterEach(() => {
  for (const s of made.splice(0)) disposeServices(s)
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('bootSession', () => {
  function bootDeps(seed: Record<string, string>) {
    const secureKV = { get: jest.fn(), set: jest.fn(), del: jest.fn() }
    return { kv: memoryKV(seed), secureKV }
  }
  const PROFILES = JSON.stringify({
    activeId: PID,
    profiles: [
      {
        id: PID,
        restOrigin: ORIGIN,
        wsUrl: WS_URL,
        feedMode: 'live',
        httpWarningAcked: false,
        serverVersion: null,
        broker: null,
        createdAt: T0,
        lastFeedRetryAt: null,
      },
    ],
  })

  test('a profile and the key marker go to ready, without reading the secure store', async () => {
    const d = bootDeps({ 'oa.profiles.v1': PROFILES, [`oa.${PID}.hasKey`]: '1' })
    await bootSession(d)
    expect(useSession.getState()).toMatchObject({ status: 'ready', profileId: PID })
    expect(d.secureKV.get).not.toHaveBeenCalled()
  })

  test('no profile, or a profile without the marker, goes to onboarding', async () => {
    const none = bootDeps({})
    await bootSession(none)
    expect(useSession.getState()).toMatchObject({ status: 'onboarding', profileId: null })
    const noMarker = bootDeps({ 'oa.profiles.v1': PROFILES })
    await bootSession(noMarker)
    expect(useSession.getState()).toMatchObject({ status: 'onboarding', profileId: PID })
    expect(none.secureKV.get).not.toHaveBeenCalled()
    expect(noMarker.secureKV.get).not.toHaveBeenCalled()
  })
})

describe('services', () => {
  test('cold start while locked sends no key and opens no socket until unlock (ruling 6)', async () => {
    let answer: (ok: boolean) => void = () => {}
    const h = setup({
      lockEnabled: true,
      authenticate: () =>
        new Promise<boolean>((r) => {
          answer = r
        }),
    })
    await h.s.lifecycle.coldStart()
    const unlocking = h.s.lock.unlock()
    await flush()
    expect(h.count('GET /auth/app-info')).toBe(1)
    expect(h.keyed()).toBe(0)
    expect(h.ws.sockets).toHaveLength(0)
    expect(h.s.scheduler.stats().paused).toBe(true)

    answer(true)
    await unlocking
    await flush()
    expect(h.s.scheduler.stats().paused).toBe(false)
    expect(h.count('POST /api/v1/funds')).toBe(1)
    expect(h.fetch.calls.find((c) => c.url.endsWith('/funds'))?.body).toEqual({ apikey: KEY })
    expect(h.ws.sockets).toHaveLength(1)
    expect(conn()).toMatchObject({ keyState: 'ok', brokerSession: 'active', transport: 'https' })
  })

  test('IpBanned halts the scheduler and stops realtime; "Try again" unhalts, re-probes and restarts realtime', async () => {
    const h = setup()
    const sock = await ready(h)
    expect(conn().feed).toBe('live')
    h.routes['POST /api/v1/funds'] = BANNED
    await expect(h.s.broker.check()).resolves.toBe('unknown')
    expect(h.s.scheduler.stats().halted).toBe(true)
    expect(h.s.realtime.status().state).toBe('stopped')
    expect(sock.closeCode).toBe(1000)
    expect(conn().banned).toBe('text')
    const b = h.banner('banner-banned')
    expect(b?.text).toBe(
      "This server has banned your IP address. Unban it in OpenAlgo's Security page from another network, then try again.",
    )
    expect(b?.action.label).toBe('Try again')

    // all traffic stops: no read, no re-probe and no broker check on resume
    const sent = h.fetch.calls.length
    await expect(h.s.api.call('funds', {}, FundsSchema)).rejects.toMatchObject({ kind: 'IpBanned' })
    await h.s.lifecycle.appState('background')
    jest.setSystemTime(T0 + 25 * H)
    await h.s.lifecycle.appState('active')
    expect(h.fetch.calls).toHaveLength(sent)
    expect(h.ws.sockets).toHaveLength(1)

    h.routes['POST /api/v1/funds'] = FUNDS_OK
    b?.action.onPress()
    await flush()
    expect(conn().banned).toBeNull()
    expect(h.s.scheduler.stats().halted).toBe(false)
    expect(h.count('GET /auth/app-info')).toBe(2)
    expect(h.count('GET /api/v1/swagger.json')).toBe(1)
    expect(h.ws.sockets).toHaveLength(2)
    expect(h.banner('banner-banned')).toBeUndefined()
  })

  test('a successful "Try again" checks the broker and refetches the profile\'s queries', async () => {
    const h = setup()
    await ready(h)
    h.routes['POST /api/v1/funds'] = BANNED
    await h.s.broker.check()
    expect(conn()).toMatchObject({ banned: 'text', brokerSession: 'unknown' })
    const funds = h.count('POST /api/v1/funds')
    const invalidate = jest.spyOn(h.s.queryClient, 'invalidateQueries')

    h.routes['POST /api/v1/funds'] = FUNDS_OK
    await h.s.lifecycle.retryAfterBan()
    expect(h.count('POST /api/v1/funds')).toBe(funds + 1)
    expect(conn()).toMatchObject({ banned: null, keyState: 'ok', brokerSession: 'active' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.root(PID) })
  })

  test('a "Try again" that is still banned sends no broker check and refetches nothing', async () => {
    const h = setup()
    await ready(h)
    h.routes['POST /api/v1/funds'] = BANNED
    await h.s.broker.check()
    const funds = h.count('POST /api/v1/funds')
    const sockets = h.ws.sockets.length
    const invalidate = jest.spyOn(h.s.queryClient, 'invalidateQueries')

    h.routes['GET /auth/app-info'] = BANNED
    await h.s.lifecycle.retryAfterBan()
    expect(conn().banned).toBe('text')
    expect(h.s.scheduler.stats().halted).toBe(true)
    expect(h.count('POST /api/v1/funds')).toBe(funds)
    expect(h.ws.sockets).toHaveLength(sockets)
    expect(invalidate).not.toHaveBeenCalled()
  })

  test('RF 3: 20 concurrent 403s with search 403 make one search, banner-key, then nothing; a replace restarts', async () => {
    const h = setup()
    await ready(h)
    h.routes['POST /api/v1/funds'] = BAD_KEY
    h.routes['POST /api/v1/search'] = BAD_KEY

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => h.s.http.request('funds', {}, FundsSchema)),
    )
    for (const r of results) {
      expect(r.status).toBe('rejected')
      expect((r as PromiseRejectedResult).reason).toMatchObject({ kind: 'KeyInvalid' })
    }
    expect(h.count('POST /api/v1/search')).toBe(1)
    const b = h.banner('banner-key')
    expect(b?.text).toBe('Your API key no longer works on this server. Enter it again.')
    expect(b?.action.label).toBe('Enter key')
    b?.action.onPress()
    expect(h.nav.go).toHaveBeenCalledWith('/account/key')
    expect(h.s.scheduler.stats().halted).toBe(true)
    expect(h.s.realtime.status().state).toBe('stopped')
    expect(h.ws.sockets.every((x) => x.closeCode !== undefined)).toBe(true)

    // no further fetch and no socket
    const sent = h.fetch.calls.length
    const sockets = h.ws.sockets.length
    await expect(h.s.api.call('funds', {}, FundsSchema)).rejects.toMatchObject({
      kind: 'KeyInvalid',
    })
    await h.s.lifecycle.appState('background')
    await jest.advanceTimersByTimeAsync(60_000)
    await h.s.lifecycle.appState('active')
    await jest.advanceTimersByTimeAsync(60_000)
    expect(h.fetch.calls).toHaveLength(sent)
    expect(h.ws.sockets).toHaveLength(sockets)

    h.routes['POST /api/v1/funds'] = FUNDS_OK
    await h.s.vault.replace(KEY2)
    expect(conn().keyState).toBe('ok')
    expect(h.banner('banner-key')).toBeUndefined()
    expect(h.s.scheduler.stats().halted).toBe(false)
    expect(h.ws.sockets).toHaveLength(sockets + 1)
    h.ws.last().serverOpen()
    expect(h.ws.last().frames()[0]).toEqual({ action: 'authenticate', api_key: KEY2 })
    await expect(h.s.api.call('funds', {}, FundsSchema)).resolves.toBeDefined()
  })

  test('a replace forgets the cached 403 split, so a broker logout right after is not a bad key (ruling 16)', async () => {
    const h = setup({ routes: { 'POST /api/v1/funds': BAD_KEY, 'POST /api/v1/search': BAD_KEY } })
    await h.s.lifecycle.coldStart()
    await h.s.lock.unlock()
    await flush()
    expect(conn().keyState).toBe('invalid')

    h.routes['POST /api/v1/search'] = SEARCH_OK
    await h.s.vault.replace(KEY2)
    await expect(h.s.broker.check()).resolves.toBe('logged_out')
    expect(conn()).toMatchObject({ keyState: 'ok', brokerSession: 'logged_out' })
    expect(h.s.scheduler.stats().halted).toBe(false)
  })

  test('a WS AUTHENTICATION_ERROR shows the same banner-key', async () => {
    const h = setup()
    const sock = await ready(h)
    h.routes['POST /api/v1/search'] = BAD_KEY
    sock.serverSend(wsError('AUTHENTICATION_ERROR', 'Invalid API key'))
    await flush()
    expect(h.count('POST /api/v1/search')).toBe(1)
    expect(conn().keyState).toBe('invalid')
    expect(h.banner('banner-key')).toBeDefined()
    expect(h.s.scheduler.stats().halted).toBe(true)
    expect(h.s.realtime.status().state).toBe('stopped')
    expect(h.ws.sockets).toHaveLength(1)
  })

  test('BROKER_ERROR with funds 403 and search 200 is logged_out with banner-broker; active again restarts realtime', async () => {
    const h = setup()
    const sock = await ready(h)
    h.routes['POST /api/v1/funds'] = BAD_KEY
    sock.serverSend(wsError('BROKER_ERROR', 'No broker configuration found for user'))
    await flush()
    expect(conn()).toMatchObject({ keyState: 'ok', brokerSession: 'logged_out' })
    expect(h.s.realtime.status().state).toBe('broker_logged_out')
    const b = h.banner('banner-broker')
    expect(b?.text).toBe(
      'Your broker session has ended. Log in to your broker on the OpenAlgo web.',
    )
    expect(b?.action.label).toBe('Log in to your broker')
    b?.action.onPress()
    expect(h.nav.openUrl).toHaveBeenCalledWith(`${ORIGIN}/login`)
    expect(h.ws.sockets).toHaveLength(1)

    h.routes['POST /api/v1/funds'] = FUNDS_OK
    await h.s.lifecycle.appState('background')
    await h.s.lifecycle.appState('active')
    expect(conn().brokerSession).toBe('active')
    expect(h.banner('banner-broker')).toBeUndefined()
    expect(h.ws.sockets).toHaveLength(2)
  })

  test('BROKER_CONNECTION_ERROR with funds 200 shows no broker badge and reconnects at 1 s', async () => {
    const h = setup()
    const sock = await ready(h)
    sock.serverSend(wsError('BROKER_CONNECTION_ERROR', 'Failed to connect to broker'))
    await flush()
    expect(conn().brokerSession).toBe('active')
    expect(h.banner('banner-broker')).toBeUndefined()
    expect(h.s.realtime.status().state).toBe('reconnecting')
    await jest.advanceTimersByTimeAsync(999)
    expect(h.ws.sockets).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(h.ws.sockets).toHaveLength(2)
  })

  test('1012 makes a forced re-probe, then a broker check', async () => {
    const h = setup()
    const sock = await ready(h)
    const funds = h.count('POST /api/v1/funds')
    jest.setSystemTime(T0 + 60_000)
    sock.serverClose(1012, 'Broker credentials changed')
    await flush()
    expect(h.count('GET /auth/app-info')).toBe(2)
    expect(h.count('GET /api/v1/swagger.json')).toBe(1)
    expect(h.count('POST /api/v1/funds')).toBe(funds + 1)
    const probe = h.fetch.calls.findIndex((c) => c.url.endsWith('/swagger.json'))
    const check = h.fetch.calls.findLastIndex((c) => c.url.endsWith('/funds'))
    expect(probe).toBeLessThan(check)
    expect(h.s.caps.get()?.probedAt).toBe(T0 + 60_000)
    expect(h.ws.sockets).toHaveLength(2)
  })

  test('a resume at 25 h makes one re-probe; at 23 h, none', async () => {
    const h = setup()
    await ready(h)
    const resume = async (at: number) => {
      await h.s.lifecycle.appState('background')
      jest.setSystemTime(at)
      await h.s.lifecycle.appState('active')
    }
    const funds = h.count('POST /api/v1/funds')
    await resume(T0 + 23 * H)
    expect(h.count('GET /api/v1/swagger.json')).toBe(0)
    expect(h.count('POST /api/v1/funds')).toBe(funds + 1)

    await resume(T0 + 25 * H)
    expect(h.count('GET /api/v1/swagger.json')).toBe(1)
    expect(h.s.caps.get()?.probedAt).toBe(T0 + 25 * H)
    expect(h.count('POST /api/v1/funds')).toBe(funds + 2)

    await resume(T0 + 26 * H)
    expect(h.count('GET /api/v1/swagger.json')).toBe(1)
  })

  test('with the app lock on, a resume at 25 h re-probes while locked, then checks the broker on unlock', async () => {
    const h = setup({ lockEnabled: true })
    await ready(h)
    const funds = h.count('POST /api/v1/funds')
    const keyed = h.keyed()
    await h.s.lifecycle.appState('background')
    jest.setSystemTime(T0 + 25 * H)
    await h.s.lifecycle.appState('active')
    // the resume locked (25 h > lockAfterMs), and the keyless re-probe still ran
    expect(h.s.lock.isLocked()).toBe(true)
    expect(h.count('GET /api/v1/swagger.json')).toBe(1)
    expect(h.s.caps.get()?.probedAt).toBe(T0 + 25 * H)
    expect(h.keyed()).toBe(keyed)
    expect(h.count('POST /api/v1/funds')).toBe(funds)
    expect(h.ws.sockets).toHaveLength(1)

    await h.s.lock.unlock()
    await flush()
    expect(h.count('POST /api/v1/funds')).toBe(funds + 1)
    expect(h.ws.sockets).toHaveLength(2)
    // no second re-probe at unlock or at the next short resume
    await h.s.lifecycle.appState('background')
    jest.setSystemTime(T0 + 25 * H + 60_000)
    await h.s.lifecycle.appState('active')
    expect(h.count('GET /api/v1/swagger.json')).toBe(1)
  })

  test('a failed polling retry still writes lastFeedRetryAt', async () => {
    const h = setup({ profile: { feedMode: 'polling' } })
    await h.s.lifecycle.coldStart()
    await h.s.lock.unlock()
    await flush()
    expect(conn().feed).toBe('polling')
    // the unlock re-reads the foreground, so the 10-minute retry runs now (B8)
    expect(h.ws.sockets).toHaveLength(1)
    h.ws.last().serverClose(1006)
    await flush()
    expect(h.s.profile.get()).toMatchObject({ lastFeedRetryAt: T0, feedMode: 'polling' })
    const stored = JSON.parse(h.kv.data.get('oa.profiles.v1') ?? '{}')
    expect(stored.profiles[0]).toMatchObject({ lastFeedRetryAt: T0, feedMode: 'polling' })
  })

  test('the handoff to polling reads polling at once and is stored (ruling 7)', async () => {
    const h = setup()
    await h.s.lifecycle.coldStart()
    await h.s.lock.unlock()
    await flush()
    for (let i = 1; i <= 10; i++) {
      h.ws.last().serverClose(1006)
      if (i < 10) await jest.advanceTimersByTimeAsync(Math.min(1000 * 2 ** (i - 1), 30_000))
    }
    // read at once, before the write lands
    expect(h.s.realtime.status().state).toBe('polling')
    expect(h.s.profile.get()).toMatchObject({ feedMode: 'polling', lastFeedRetryAt: Date.now() })
    await flush()
    const stored = JSON.parse(h.kv.data.get('oa.profiles.v1') ?? '{}')
    expect(stored.profiles[0].feedMode).toBe('polling')

    // a lock and unlock (stop, start) opens no new socket
    const sockets = h.ws.sockets.length
    h.s.realtime.stop()
    h.s.realtime.start()
    expect(h.s.realtime.status().state).toBe('polling')
    expect(h.ws.sockets).toHaveLength(sockets)
  })

  test('a lost network is not counted toward the handoff, and its return reconnects at once', async () => {
    const h = setup()
    await h.s.lifecycle.coldStart()
    await h.s.lock.unlock()
    await flush()
    onlineManager.setOnline(false)
    try {
      for (let i = 0; i < 15; i++) {
        h.ws.last().serverClose(1006)
        expect(h.s.realtime.status()).toMatchObject({ state: 'reconnecting', failures: 0 })
        await jest.advanceTimersByTimeAsync(30_000)
      }
      expect(h.s.profile.get().feedMode).toBe('live')
      h.ws.last().serverClose(1006)
      const sockets = h.ws.sockets.length
      onlineManager.setOnline(true)
      expect(h.ws.sockets).toHaveLength(sockets + 1)
      h.ws.last().serverOpen()
      h.ws.last().serverSend(AUTH_OK)
      expect(h.s.realtime.status().state).toBe('live')
    } finally {
      onlineManager.setOnline(true)
    }
  })

  test('a server that REST cannot reach either keeps the feed reconnecting, not polling', async () => {
    const h = setup()
    await h.s.lifecycle.coldStart()
    await h.s.lock.unlock()
    await flush()
    // the home server is out of reach while the watchlist polls it
    h.routes['POST /api/v1/multiquotes'] = 'throw'
    h.s.polling.register({ kind: 'quotes', keys: () => ['NSE:RELIANCE'] }, true)
    for (let i = 1; i <= 12; i++) {
      h.ws.last().serverClose(1006)
      await jest.advanceTimersByTimeAsync(30_000)
    }
    expect(h.count('POST /api/v1/multiquotes')).toBeGreaterThan(50)
    expect(h.s.realtime.status().failures).toBeGreaterThanOrEqual(12)
    expect(h.s.realtime.status().state).not.toBe('polling')
    expect(h.s.profile.get()).toMatchObject({ feedMode: 'live', lastFeedRetryAt: null })
  })

  const MULTIQUOTES_OK: Route = {
    status: 200,
    body: {
      status: 'success',
      results: [{ symbol: 'RELIANCE', exchange: 'NSE', data: { ltp: 1424, prev_close: 1418 } }],
    },
  }
  const watch = (h: Harness) =>
    h.s.polling.register({ kind: 'quotes', keys: () => ['NSE:RELIANCE'] }, true)

  test('design 7.1: a logged-out broker dims prices in polling mode; logging in lifts it', async () => {
    const h = setup({
      profile: { wsUrl: null, feedMode: 'polling' },
      routes: { 'POST /api/v1/multiquotes': MULTIQUOTES_OK },
    })
    await h.s.lifecycle.coldStart()
    await h.s.lock.unlock()
    await flush()
    watch(h)
    await jest.advanceTimersByTimeAsync(5000)
    expect(h.s.store.isStale()).toBe(false)
    h.routes['POST /api/v1/funds'] = BAD_KEY // search still takes the key: the broker logged out
    await h.s.broker.check()
    expect(conn().brokerSession).toBe('logged_out')
    expect(h.s.store.isStale()).toBe(true)
    h.routes['POST /api/v1/funds'] = FUNDS_OK
    await h.s.broker.check()
    expect(h.s.store.isStale()).toBe(false)
  })

  test('design 7.1: a REST broker logout dims prices while the socket stays live', async () => {
    const h = setup()
    await ready(h)
    expect(h.s.realtime.status().state).toBe('live')
    expect(h.s.store.isStale()).toBe(false)
    h.routes['POST /api/v1/funds'] = BAD_KEY
    await h.s.broker.check()
    expect(h.s.realtime.status().state).toBe('live')
    expect(h.s.store.isStale()).toBe(true)
  })

  test('in polling mode a failing poll dims prices, and the next good poll lifts it', async () => {
    const h = setup({ profile: { wsUrl: null, feedMode: 'polling' } })
    await h.s.lifecycle.coldStart()
    await h.s.lock.unlock()
    await flush()
    h.routes['POST /api/v1/multiquotes'] = 'throw' // a dead tunnel
    watch(h)
    expect(h.s.store.isStale()).toBe(false)
    await jest.advanceTimersByTimeAsync(5000)
    expect(h.s.store.isStale()).toBe(true)
    h.routes['POST /api/v1/multiquotes'] = MULTIQUOTES_OK
    await jest.advanceTimersByTimeAsync(5000)
    expect(h.s.store.isStale()).toBe(false)
  })

  test('while the socket reconnects, prices that polling keeps fresh are not dimmed', async () => {
    const h = setup({ routes: { 'POST /api/v1/multiquotes': MULTIQUOTES_OK } })
    const sock = await ready(h)
    h.s.realtime.acquire({ exchange: 'NSE', symbol: 'RELIANCE', mode: 2 })
    watch(h)
    await jest.advanceTimersByTimeAsync(5000)
    expect(h.count('POST /api/v1/multiquotes')).toBe(0) // the socket carries it
    sock.serverClose(1006)
    expect(h.s.realtime.status().state).toBe('reconnecting')
    expect(h.s.store.isStale()).toBe(true) // the last tick may be old
    await jest.advanceTimersByTimeAsync(5000)
    expect(h.count('POST /api/v1/multiquotes')).toBeGreaterThan(0)
    expect(h.s.realtime.status().state).not.toBe('live')
    expect(h.s.store.isStale()).toBe(false)
  })

  test('polling mode shows the polling banner, whose link opens the setup help', async () => {
    const h = setup({ profile: { wsUrl: null, feedMode: 'polling' } })
    await h.s.lifecycle.coldStart()
    await h.s.lock.unlock()
    await flush()
    const b = h.banner('banner-polling')
    expect(b?.text).toBe('Live feed unavailable: prices refresh every few seconds')
    expect(b?.action.label).toBe('Setup help')
    b?.action.onPress()
    expect(h.nav.go).toHaveBeenCalledWith('/help')
    expect(h.banners().map((x) => x.testID)).toEqual(['banner-polling'])
  })

  test('a healthy connection shows no banner', async () => {
    const h = setup()
    await ready(h)
    expect(h.banners()).toEqual([])
  })

  test('order_update pokes the books', async () => {
    const h = setup()
    const sock = await ready(h)
    await jest.advanceTimersByTimeAsync(1000)
    const invalidate = jest.spyOn(h.s.queryClient, 'invalidateQueries')
    sock.serverSend({
      type: 'order_update',
      orderid: '250101000000001',
      symbol: 'RELIANCE',
      exchange: 'NSE',
      order_status: 'complete',
      filled_quantity: 1,
    })
    await jest.advanceTimersByTimeAsync(499)
    expect(invalidate).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.orderbook(PID) })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.funds(PID) })
  })

  test('locking stops the feed and pauses reads; unlocking checks the broker, restarts the feed and resyncs', async () => {
    const h = setup({ lockEnabled: true })
    await ready(h)
    const funds = h.count('POST /api/v1/funds')
    await h.s.lifecycle.appState('background')
    await jest.advanceTimersByTimeAsync(300_000)
    await h.s.lifecycle.appState('active')
    expect(h.s.lock.isLocked()).toBe(true)
    expect(h.s.vault.has()).toBe(false)
    expect(h.s.realtime.status().state).toBe('stopped')
    expect(h.s.scheduler.stats().paused).toBe(true)
    expect(h.count('POST /api/v1/funds')).toBe(funds)
    expect(h.ws.sockets).toHaveLength(1)

    const invalidate = jest.spyOn(h.s.queryClient, 'invalidateQueries')
    await h.s.lock.unlock()
    await flush()
    expect(h.s.scheduler.stats().paused).toBe(false)
    expect(h.count('POST /api/v1/funds')).toBe(funds + 1)
    expect(h.ws.sockets).toHaveLength(2)
    await jest.advanceTimersByTimeAsync(500)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.orderbook(PID) })
  })

  test('no stored key at unlock goes to onboarding', async () => {
    const h = setup({ storedKey: false })
    useSession.setState({ status: 'ready', profileId: PID })
    await h.s.lock.unlock()
    expect(useSession.getState().status).toBe('onboarding')
    expect(h.kv.data.has(`oa.${PID}.hasKey`)).toBe(false)
  })

  test('an unreadable key can be forgotten, which goes to onboarding', async () => {
    const secureKV: SecureKV = {
      get: jest.fn(async () => {
        throw new Error('keystore unavailable')
      }),
      set: jest.fn(async () => {}),
      del: jest.fn(async () => {}),
    }
    const h = setup({ secureKV })
    useSession.setState({ status: 'ready', profileId: PID })
    expect(await h.s.lock.unlock()).toBe(false)
    expect(h.s.lock.keyUnreadable()).toBe(false)
    expect(await h.s.lock.unlock()).toBe(false)
    expect(h.s.lock.keyUnreadable()).toBe(true)
    await h.s.lifecycle.forgetKey()
    expect(secureKV.del).toHaveBeenCalledWith(`oa.${PID}.apikey`)
    expect(h.kv.data.has(`oa.${PID}.hasKey`)).toBe(false)
    expect(useSession.getState().status).toBe('onboarding')
  })

  test('forgetting clears the marker even when the secure delete throws, then goes to onboarding', async () => {
    const broken = new Error('keystore unavailable')
    const secureKV: SecureKV = {
      get: jest.fn(async () => {
        throw broken
      }),
      set: jest.fn(async () => {}),
      del: jest.fn(async () => {
        throw broken
      }),
    }
    const h = setup({ secureKV })
    useSession.setState({ status: 'ready', profileId: PID })
    await h.s.lock.unlock()
    await h.s.lock.unlock()
    expect(h.s.lock.keyUnreadable()).toBe(true)
    await expect(h.s.lifecycle.forgetKey()).resolves.toBeUndefined()
    expect(secureKV.del).toHaveBeenCalledWith(`oa.${PID}.apikey`)
    expect(h.kv.data.has(`oa.${PID}.hasKey`)).toBe(false)
    expect(useSession.getState().status).toBe('onboarding')
    // the next boot reads the marker alone, so it starts in onboarding, not at the lock
    await bootSession({ kv: h.kv, secureKV })
    expect(useSession.getState().status).toBe('onboarding')
  })

  test('a quote-only subscription does not stop depth polling; delivered depth does', async () => {
    const h = setup()
    const sock = await ready(h)
    h.s.realtime.acquire({ exchange: 'NSE', symbol: 'RELIANCE', mode: 2 })
    await jest.advanceTimersByTimeAsync(100)
    expect(h.s.realtime.isLive('NSE', 'RELIANCE')).toBe(true)
    h.s.polling.register({ kind: 'quotes', keys: () => ['NSE:RELIANCE'] }, true)
    h.s.polling.register({ kind: 'depth', key: () => 'NSE:RELIANCE' }, true)
    await jest.advanceTimersByTimeAsync(5000)
    expect(h.count('POST /api/v1/depth')).toBe(1)
    expect(h.count('POST /api/v1/multiquotes')).toBe(0)

    h.s.realtime.acquire({ exchange: 'NSE', symbol: 'RELIANCE', mode: 3 })
    await jest.advanceTimersByTimeAsync(100)
    sock.serverSend({
      type: 'market_data',
      symbol: 'RELIANCE',
      exchange: 'NSE',
      mode: 3,
      data: {
        ltp: 1424,
        depth: { buy: [{ price: 1423.9, quantity: 10 }], sell: [{ price: 1424.1, quantity: 7 }] },
      },
    })
    await jest.advanceTimersByTimeAsync(10_000)
    expect(h.count('POST /api/v1/depth')).toBe(1)
  })

  test('dispose locks the vault, resets the store, clears the queries and stops the feed', async () => {
    const h = setup()
    const sock = await ready(h)
    h.s.store.put('NSE:RELIANCE', { ltp: 1424 }, 'ws')
    h.s.queryClient.setQueryData(qk.funds(PID), { availablecash: 1 })
    disposeServices(h.s)
    expect(h.s.vault.has()).toBe(false)
    expect(h.s.store.get('NSE:RELIANCE')).toBeUndefined()
    expect(h.s.queryClient.getQueryData(qk.funds(PID))).toBeUndefined()
    expect(h.s.realtime.status().state).toBe('stopped')
    expect(sock.closeCode).toBe(1000)

    // a disposed container no longer reacts to the connection state
    useConnection.getState().set({ brokerSession: 'logged_out' })
    useConnection.getState().set({ brokerSession: 'active' })
    expect(h.ws.sockets).toHaveLength(1)
  })
})
