import type { Capabilities } from '~/core/capabilities/gates'
import { newProfileId, type ServerProfile } from '~/core/config/profile'
import { ApiError } from '~/core/http/errors'
import { clearLogs, getLogLines } from '~/core/log/logger'
import { bootSession, useSession } from '~/core/services/services'
import { type Route, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { AUTH_OK, fakeSockets, PONG, wsError } from '../../../test/helpers/fakeSocket'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { feedStep, keyStep, saveOnboarding, serverStep } from './flow'

const ORIGIN = 'https://algo.example.com'
const WS_URL = 'wss://algo.example.com/ws'
const KEY = 'ab'.repeat(32)
const UUID = '0123abcd-4567-4890-a123-456789abcdef'
const T0 = Date.UTC(2026, 10, 24, 4, 0)

const APP_INFO = (version: string): Route => ({
  status: 200,
  body: { status: 'success', version, name: 'OpenAlgo' },
})
const SWAGGER: Route = {
  status: 200,
  body: { paths: { '/multioptiongreeks/': {}, '/funds/': {}, '/search/': {} } },
}
const BAD_KEY: Route = {
  status: 403,
  body: { status: 'error', message: 'Invalid openalgo apikey' },
}
const SEARCH_OK: Route = { status: 200, body: { status: 'success', data: [] } }
const FUNDS_OK: Route = { status: 200, body: { status: 'success', data: { availablecash: '1' } } }
const PING_OK: Route = {
  status: 200,
  body: { status: 'success', data: { message: 'pong', broker: 'angel' } },
}

const CAPS: Capabilities = {
  host: ORIGIN,
  version: '2.0.3.5',
  versionSource: 'app-info',
  endpoints: ['multioptiongreeks'],
  probed: {},
  fields: {},
  ws: { orderStream: null, ping: null, close1012: true, authDeadline: true },
  probedAt: T0,
}

beforeEach(() => {
  clearLogs()
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})
afterEach(() => jest.restoreAllMocks())

const paths = (f: ReturnType<typeof scriptedFetch>) =>
  f.calls.map((c) => `${c.method} ${c.url.replace(/^https?:\/\/[^/]+/, '')}`)

describe('serverStep', () => {
  const deps = (fetch: typeof globalThis.fetch, allowDevHosts = false) => ({
    fetch,
    allowDevHosts,
    now: () => T0,
  })

  test("'192.168.1.20' becomes http://192.168.1.20:5000 and is probed there", async () => {
    const fetch = scriptedFetch({
      'GET /auth/app-info': APP_INFO('2.0.3.5'),
      'GET /api/v1/swagger.json': SWAGGER,
    })
    const r = await serverStep('192.168.1.20', deps(fetch))
    expect(r).toMatchObject({ kind: 'ok', url: 'http://192.168.1.20:5000' })
    if (r.kind !== 'ok') throw new Error('not ok')
    expect(r.caps).toMatchObject({ host: 'http://192.168.1.20:5000', version: '2.0.3.5' })
    expect(r.caps.probedAt).toBe(T0)
    expect(fetch.calls.map((c) => c.url)).toEqual([
      'http://192.168.1.20:5000/auth/app-info',
      'http://192.168.1.20:5000/api/v1/swagger.json',
    ])
  })

  test('a URL the rule refuses sends nothing', async () => {
    const fetch = scriptedFetch({})
    expect(await serverStep('http://algo.example.com', deps(fetch))).toEqual({
      kind: 'url_error',
      reason: 'cleartext_public',
    })
    expect(await serverStep('localhost:5000', deps(fetch))).toEqual({
      kind: 'url_error',
      reason: 'dev_host_in_release',
    })
    expect(fetch.calls).toHaveLength(0)
  })

  test('localhost is allowed when dev hosts are', async () => {
    const fetch = scriptedFetch({
      'GET /auth/app-info': APP_INFO('2.0.0.0'),
      'GET /api/v1/swagger.json': SWAGGER,
    })
    const r = await serverStep('localhost', deps(fetch, true))
    expect(r).toMatchObject({ kind: 'ok', url: 'http://localhost:5000' })
  })

  test('an old server is too_old, with its version', async () => {
    const fetch = scriptedFetch({
      'GET /auth/app-info': APP_INFO('1.0.0.41'),
      'GET /api/v1/swagger.json': SWAGGER,
    })
    expect(await serverStep(ORIGIN, deps(fetch))).toEqual({ kind: 'too_old', version: '1.0.0.41' })
  })

  test('no reply is unreachable', async () => {
    const fetch = scriptedFetch({ 'GET /auth/app-info': 'throw' })
    expect(await serverStep(ORIGIN, deps(fetch))).toEqual({ kind: 'unreachable' })
  })
})

describe('keyStep', () => {
  test('a format error sends nothing', async () => {
    const fetch = scriptedFetch({})
    expect(await keyStep(ORIGIN, `api key: ${KEY}`, { fetch })).toEqual({ kind: 'format' })
    expect(await keyStep(ORIGIN, KEY.slice(1), { fetch })).toEqual({ kind: 'format' })
    expect(fetch.calls).toHaveLength(0)
  })

  test('search 403 is invalid, and nothing else is sent', async () => {
    const fetch = scriptedFetch({ 'POST /api/v1/search': BAD_KEY })
    expect(await keyStep(ORIGIN, KEY, { fetch })).toEqual({ kind: 'invalid' })
    expect(paths(fetch)).toEqual(['POST /api/v1/search'])
  })

  test('search 200 with funds 403 is ok with a logged-out broker, after one search', async () => {
    const fetch = scriptedFetch({
      'POST /api/v1/search': SEARCH_OK,
      'POST /api/v1/funds': BAD_KEY,
      'POST /api/v1/ping': BAD_KEY,
    })
    expect(await keyStep(ORIGIN, KEY, { fetch })).toEqual({
      kind: 'ok',
      key: KEY,
      brokerSession: 'logged_out',
      broker: null,
    })
    expect(paths(fetch)).toEqual(['POST /api/v1/search', 'POST /api/v1/funds', 'POST /api/v1/ping'])
  })

  test('ping supplies the broker; search, funds and ping go in that order with the key', async () => {
    const fetch = scriptedFetch({
      'POST /api/v1/search': SEARCH_OK,
      'POST /api/v1/funds': FUNDS_OK,
      'POST /api/v1/ping': PING_OK,
    })
    // as scanned: uppercase, spaced and broken over lines
    const raw = ` ${KEY.toUpperCase().slice(0, 32)}\n${KEY.toUpperCase().slice(32)} `
    expect(await keyStep(ORIGIN, raw, { fetch })).toEqual({
      kind: 'ok',
      key: KEY,
      brokerSession: 'active',
      broker: 'angel',
    })
    expect(paths(fetch)).toEqual(['POST /api/v1/search', 'POST /api/v1/funds', 'POST /api/v1/ping'])
    for (const c of fetch.calls) {
      expect(c.url.startsWith(`${ORIGIN}/api/v1/`)).toBe(true)
      expect((c.body as { apikey?: string }).apikey).toBe(KEY)
    }
    expect(getLogLines().join('\n')).not.toContain(KEY)
  })

  test('a funds reply that proves nothing leaves the broker session unknown', async () => {
    const fetch = scriptedFetch({
      'POST /api/v1/search': SEARCH_OK,
      'POST /api/v1/funds': { status: 500, body: { status: 'error', message: 'broker down' } },
      'POST /api/v1/ping': PING_OK,
    })
    expect(await keyStep(ORIGIN, KEY, { fetch })).toMatchObject({
      kind: 'ok',
      brokerSession: 'unknown',
      broker: 'angel',
    })
  })

  test('no reply to search is an error', async () => {
    const fetch = scriptedFetch({ 'POST /api/v1/search': 'throw' })
    const r = await keyStep(ORIGIN, KEY, { fetch })
    expect(r.kind).toBe('error')
    if (r.kind !== 'error') throw new Error('not an error')
    expect(r.error).toBeInstanceOf(ApiError)
    expect((r.error as ApiError).kind).toBe('Network')
  })

  test('a ban after search is an error, and stops there', async () => {
    const fetch = scriptedFetch({
      'POST /api/v1/search': SEARCH_OK,
      'POST /api/v1/funds': { status: 403, body: 'Access Denied: Your IP has been banned' },
    })
    const r = await keyStep(ORIGIN, KEY, { fetch })
    expect(r.kind).toBe('error')
    expect((r as { error: ApiError }).error.kind).toBe('IpBanned')
    expect(paths(fetch)).toEqual(['POST /api/v1/search', 'POST /api/v1/funds'])
  })
})

describe('feedStep', () => {
  afterEach(() => jest.useRealTimers())

  test('authenticate then pong is live, with the broker', async () => {
    const ws = fakeSockets()
    const p = feedStep(WS_URL, KEY, { WebSocketImpl: ws.WebSocketImpl })
    const s = ws.last()
    expect(s.url).toBe(WS_URL)
    s.serverOpen()
    s.serverSend(AUTH_OK)
    s.serverSend(PONG)
    await expect(p).resolves.toEqual({ mode: 'live', broker: 'zerodha' })
    expect(s.frames()[0]).toEqual({ action: 'authenticate', api_key: KEY })
  })

  test('3 failed handshakes give polling, and no fourth is tried', async () => {
    jest.useFakeTimers()
    const ws = fakeSockets()
    const p = feedStep(WS_URL, KEY, { WebSocketImpl: ws.WebSocketImpl })
    ws.last().serverClose(1006)
    await jest.advanceTimersByTimeAsync(1000)
    expect(ws.sockets).toHaveLength(2)
    ws.last().serverClose(1006)
    await jest.advanceTimersByTimeAsync(2000)
    expect(ws.sockets).toHaveLength(3)
    ws.last().serverClose(1006)
    await expect(p).resolves.toEqual({ mode: 'polling', reason: 'closed' })
    await jest.advanceTimersByTimeAsync(60_000)
    expect(ws.sockets).toHaveLength(3)
  })

  test('an auth error gives polling at once', async () => {
    const ws = fakeSockets()
    const p = feedStep(WS_URL, KEY, { WebSocketImpl: ws.WebSocketImpl })
    ws.last().serverOpen()
    ws.last().serverSend(wsError('AUTHENTICATION_ERROR', 'Invalid API key'))
    await expect(p).resolves.toEqual({ mode: 'polling', reason: 'auth_error' })
    expect(ws.sockets).toHaveLength(1)
  })
})

describe('saveOnboarding', () => {
  const RESULT = {
    url: ORIGIN,
    caps: CAPS,
    key: KEY,
    broker: 'zerodha',
    wsUrl: WS_URL,
    feedMode: 'live' as const,
    httpWarningAcked: false,
  }

  function stores(seed: Record<string, string> = {}) {
    const kv = memoryKV(seed)
    const secureKV = memoryKV()
    return { kv, secureKV, uuid: () => UUID, now: () => T0 }
  }

  const saved = (kv: ReturnType<typeof memoryKV>) =>
    JSON.parse(kv.data.get('oa.profiles.v1') ?? 'null') as {
      activeId: string
      profiles: ServerProfile[]
    }

  test('writes the key, its marker and the profile, under a new id', async () => {
    const d = stores()
    const profile = await saveOnboarding(RESULT, d)
    const id = newProfileId(UUID)
    expect(profile).toEqual({
      id,
      restOrigin: ORIGIN,
      wsUrl: WS_URL,
      feedMode: 'live',
      httpWarningAcked: false,
      serverVersion: '2.0.3.5',
      broker: 'zerodha',
      createdAt: T0,
      lastFeedRetryAt: null,
    })
    expect(d.secureKV.data.get(`oa.${id}.apikey`)).toBe(KEY)
    expect(d.kv.data.get(`oa.${id}.hasKey`)).toBe('1')
    expect(saved(d.kv)).toEqual({ activeId: id, profiles: [profile] })
    // the key is in the secure store only
    for (const v of d.kv.data.values()) expect(v).not.toContain(KEY)
  })

  test('stores the probed caps, so the first cold start needs no re-probe', async () => {
    const d = stores()
    const { id } = await saveOnboarding(RESULT, d)
    expect(JSON.parse(d.kv.data.get(`oa.${id}.caps`) ?? 'null')).toEqual(CAPS)
  })

  test('reuses the existing profile id, and keeps its creation time and http ack', async () => {
    const old: ServerProfile = {
      id: 'pexisting0001',
      restOrigin: 'https://old.trycloudflare.com',
      wsUrl: null,
      feedMode: 'polling',
      httpWarningAcked: true,
      serverVersion: '2.0.1.6',
      broker: 'angel',
      createdAt: 1000,
      lastFeedRetryAt: 2000,
    }
    const d = stores({
      'oa.profiles.v1': JSON.stringify({ activeId: old.id, profiles: [old] }),
      'oa.pexisting0001.watchlists': '[]',
    })
    const profile = await saveOnboarding(RESULT, d)
    expect(profile).toMatchObject({
      id: old.id,
      restOrigin: ORIGIN,
      createdAt: 1000,
      httpWarningAcked: true,
      feedMode: 'live',
      lastFeedRetryAt: null,
    })
    expect(saved(d.kv).profiles).toEqual([profile])
    expect(d.secureKV.data.get('oa.pexisting0001.apikey')).toBe(KEY)
    expect(d.kv.data.get('oa.pexisting0001.watchlists')).toBe('[]')
  })

  test('a polling save records the live-feed try, so the next waits 10 minutes (ruling 7)', async () => {
    const d = stores()
    const profile = await saveOnboarding({ ...RESULT, feedMode: 'polling' }, d)
    expect(profile).toMatchObject({ feedMode: 'polling', lastFeedRetryAt: T0, wsUrl: WS_URL })
  })

  test('after a save, boot goes to the app', async () => {
    const d = stores()
    const { id } = await saveOnboarding(RESULT, d)
    useSession.setState({ status: 'loading', profileId: null })
    await bootSession(d)
    expect(useSession.getState()).toMatchObject({ status: 'ready', profileId: id })
  })
})
