import { createHttpClient } from '~/core/http/client'
import { ENDPOINTS } from '~/core/http/endpoints'
import { type Route, type ScriptedReply, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { type FeatureId, gate, VERSION_GATES } from './gates'
import { type ProbeOutcome, probeServer, readAppVersion } from './probe'

const ORIGIN = 'https://algo.example.com'
const NOW = Date.UTC(2026, 10, 24, 4, 0)

const BASE = [
  'ping',
  'search',
  'funds',
  'analyzer',
  'analyzer/toggle',
  'quotes',
  'multiquotes',
  'depth',
  'history',
  'optionchain',
  'multioptiongreeks',
]
const TOOLS = ['portfolio/backtest', 'sip/backtest']
const ALL_2_0_3_5 = [...BASE, ...TOOLS, 'sectorrotation']

const SPA = '<!doctype html><html><body><div id="root"></div></body></html>'
const html = (status = 200, body = SPA): ScriptedReply => ({
  status,
  contentType: 'text/html; charset=utf-8',
  body,
})
const appInfo = (version: string): ScriptedReply => ({
  status: 200,
  body: { status: 'success', version, name: 'OpenAlgo' },
})
// flask-restx paths keys: "/placeorder/", "/portfolio/backtest", "/market/timings/".
const swagger = (ids: readonly string[]): ScriptedReply => ({
  status: 200,
  body: {
    swagger: '2.0',
    info: { version: '1.0' },
    paths: Object.fromEntries(ids.map((id, i) => [i % 2 ? `/${id}` : `/${id}/`, { post: {} }])),
  },
})
// POST {} to an existing endpoint: 400 JSON, before any key lookup (S7).
const MISSING_KEY: ScriptedReply = {
  status: 400,
  body: { status: 'error', message: { apikey: ['Missing data for required field.'] } },
}
const NOT_FOUND: ScriptedReply = {
  status: 404,
  body: { status: 'error', message: 'Not found', path: '/api/v1/x' },
}
const BAN_TEXT: ScriptedReply = {
  status: 403,
  contentType: 'text/plain',
  body: 'Access Denied: Your IP has been banned',
}
const BAN_JSON: ScriptedReply = { status: 403, body: { error: 'Access Denied' } }

const APP_INFO = 'GET /auth/app-info'
const SWAGGER = 'GET /api/v1/swagger.json'
const post = (id: string) => `POST /api/v1/${id}`

/** Every route the probe could touch answers `reply`. */
function everything(reply: Route): Record<string, Route> {
  const routes: Record<string, Route> = { [APP_INFO]: reply, [SWAGGER]: reply }
  for (const id of Object.keys(ENDPOINTS)) routes[post(id)] = reply
  return routes
}

/** A stock server: app-info when `version` is set, swagger unless false, and its endpoints. */
function stock(s: {
  version?: string
  endpoints: readonly string[]
  swagger?: boolean
  json404?: boolean
}): Record<string, Route> {
  const missing = s.json404 ? NOT_FOUND : html()
  const routes = everything(missing)
  for (const id of s.endpoints) routes[post(id)] = MISSING_KEY
  if (s.version) routes[APP_INFO] = appInfo(s.version)
  if (s.swagger !== false) routes[SWAGGER] = swagger(s.endpoints)
  return routes
}

function setup(routes: Record<string, Route>) {
  const fetch = scriptedFetch(routes)
  const http = createHttpClient({
    origin: ORIGIN,
    getKey: () => {
      throw new Error('the probe never sends the key')
    },
    fetch,
    resolveAuth403: async () => {
      throw new Error('the probe never splits a 403')
    },
  })
  const posts = () => fetch.calls.filter((c) => c.method === 'POST')
  const posted = () => posts().map((c) => c.url.replace(`${ORIGIN}/api/v1/`, ''))
  return { http, fetch, posts, posted }
}

function okCaps(out: ProbeOutcome) {
  if (out.kind !== 'ok') throw new Error(`expected ok, got ${out.kind}`)
  return out.caps
}

const FEATURES: FeatureId[] = [
  ...(Object.keys(VERSION_GATES) as (keyof typeof VERSION_GATES)[]),
  'historySource',
]

beforeEach(() => {
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})
afterEach(() => jest.restoreAllMocks())

describe('a stock server with app-info', () => {
  test('2.0.3.5: every gate on, zero POST probes', async () => {
    const { http, fetch, posts } = setup(
      stock({ version: '2.0.3.5', endpoints: ALL_2_0_3_5, json404: true }),
    )
    const caps = okCaps(await probeServer({ http, host: ORIGIN, now: NOW }))
    expect(caps).toEqual({
      host: ORIGIN,
      version: '2.0.3.5',
      versionSource: 'app-info',
      endpoints: ALL_2_0_3_5,
      probed: {},
      fields: {},
      ws: { orderStream: null, ping: null, close1012: true, authDeadline: true },
      probedAt: NOW,
    })
    for (const f of FEATURES) expect([f, gate(caps, f).on]).toEqual([f, true])
    expect(posts()).toEqual([])
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${ORIGIN}/auth/app-info`,
      `GET ${ORIGIN}/api/v1/swagger.json`,
    ])
  })

  test('2.0.1.6: orderStream on, optionchainGreeks off needing 2.0.2.0, portfolioTools off', async () => {
    const { http, posts } = setup(stock({ version: '2.0.1.6', endpoints: BASE }))
    const caps = okCaps(await probeServer({ http, host: ORIGIN, now: NOW }))
    expect(caps.ws).toEqual({ orderStream: null, ping: null, close1012: false, authDeadline: true })
    expect(gate(caps, 'orderStream').on).toBe(true)
    expect(gate(caps, 'optionchainGreeks')).toMatchObject({ on: false, needs: '2.0.2.0' })
    expect(gate(caps, 'portfolioTools')).toMatchObject({ on: false, needs: '2.0.1.8' })
    expect(posts()).toEqual([])
  })

  test("app-info's 2.0.1.17 reads as 2.0.1.7", async () => {
    const { http } = setup(stock({ version: '2.0.1.17', endpoints: BASE }))
    expect(okCaps(await probeServer({ http, host: ORIGIN, now: NOW })).version).toBe('2.0.1.7')
  })

  test('app-info below 2.0.0.0 → too_old with its version', async () => {
    const { http } = setup(stock({ version: '1.9.9.9', endpoints: BASE }))
    expect(await probeServer({ http, host: ORIGIN, now: NOW })).toEqual({
      kind: 'too_old',
      version: '1.9.9.9',
    })
  })

  test('without swagger, the tool endpoints are probed, and the evidence gates them', async () => {
    const { http, posted } = setup(
      stock({ version: '2.0.2.0', endpoints: [...BASE, ...TOOLS], swagger: false }),
    )
    const caps = okCaps(await probeServer({ http, host: ORIGIN, now: NOW }))
    expect(caps).toMatchObject({
      version: '2.0.2.0',
      versionSource: 'app-info',
      endpoints: null,
      probed: { 'portfolio/backtest': true, 'sip/backtest': true, sectorrotation: false },
    })
    expect(posted()).toEqual(['portfolio/backtest', 'sip/backtest', 'sectorrotation'])
    expect(gate(caps, 'portfolioTools').on).toBe(true)
    expect(gate(caps, 'sectorRotation').on).toBe(false)
  })

  test('a network error on swagger counts as no swagger', async () => {
    const routes = stock({ version: '2.0.3.5', endpoints: ALL_2_0_3_5, json404: true })
    routes[SWAGGER] = 'throw'
    const { http, posted } = setup(routes)
    const caps = okCaps(await probeServer({ http, host: ORIGIN, now: NOW }))
    expect(caps.endpoints).toBeNull()
    expect(posted()).toEqual(['portfolio/backtest', 'sip/backtest', 'sectorrotation'])
  })
})

describe('no app-info: the 2.0.0.0 marker', () => {
  test('the marker in swagger → ok, version null, versionSource marker, no probes', async () => {
    const { http, posts } = setup(stock({ endpoints: [...BASE, ...TOOLS] }))
    const caps = okCaps(await probeServer({ http, host: ORIGIN, now: NOW }))
    expect(caps).toMatchObject({ version: null, versionSource: 'marker', probed: {} })
    expect(caps.ws).toEqual({
      orderStream: null,
      ping: null,
      close1012: false,
      authDeadline: false,
    })
    expect(gate(caps, 'portfolioTools').on).toBe(true)
    expect(gate(caps, 'optionchainGreeks')).toMatchObject({
      on: false,
      reason: 'server version unknown',
    })
    expect(posts()).toEqual([])
  })

  test('swagger without the marker → too_old(null)', async () => {
    const { http, posts } = setup(stock({ endpoints: ['ping', 'search', 'funds'] }))
    expect(await probeServer({ http, host: ORIGIN, now: NOW })).toEqual({
      kind: 'too_old',
      version: null,
    })
    expect(posts()).toEqual([])
  })

  test('all HTML, but multioptiongreeks answers 400 JSON → ok, and the tools are probed', async () => {
    const routes = everything(html())
    routes[post('multioptiongreeks')] = MISSING_KEY
    const { http, posts, posted } = setup(routes)
    const caps = okCaps(await probeServer({ http, host: ORIGIN, now: NOW }))
    expect(caps).toMatchObject({
      version: null,
      versionSource: 'marker',
      endpoints: null,
      probed: {
        multioptiongreeks: true,
        'portfolio/backtest': false,
        'sip/backtest': false,
        sectorrotation: false,
      },
    })
    expect(posted()).toEqual([
      'multioptiongreeks',
      'portfolio/backtest',
      'sip/backtest',
      'sectorrotation',
    ])
    expect(posts().length).toBeLessThanOrEqual(10)
    // Probes are keyless POST {} with a JSON content type (GC).
    for (const c of posts()) {
      expect(c.body).toEqual({})
      expect(c.headers['content-type']).toBe('application/json')
    }
  })

  test('no marker, but ping answers like OpenAlgo → too_old(null)', async () => {
    const routes = everything(html(404))
    routes[post('ping')] = MISSING_KEY
    const { http, posted } = setup(routes)
    expect(await probeServer({ http, host: ORIGIN, now: NOW })).toEqual({
      kind: 'too_old',
      version: null,
    })
    expect(posted()).toEqual(['multioptiongreeks', 'ping'])
  })

  test('maxProbes caps the total', async () => {
    const routes = everything(html())
    routes[post('multioptiongreeks')] = MISSING_KEY
    const { http, posted } = setup(routes)
    const caps = okCaps(await probeServer({ http, host: ORIGIN, now: NOW, maxProbes: 2 }))
    expect(posted()).toEqual(['multioptiongreeks', 'portfolio/backtest'])
    expect(caps.probed).toEqual({ multioptiongreeks: true, 'portfolio/backtest': false })
  })

  test('an inconclusive probe is not recorded', async () => {
    const routes = everything(html())
    routes[post('multioptiongreeks')] = MISSING_KEY
    routes[post('sip/backtest')] = { status: 500, body: 'An unexpected error occurred' }
    const { http } = setup(routes)
    const caps = okCaps(await probeServer({ http, host: ORIGIN, now: NOW }))
    expect(caps.probed).toEqual({
      multioptiongreeks: true,
      'portfolio/backtest': false,
      sectorrotation: false,
    })
  })
})

describe('(RF 2) something else answers', () => {
  test.each<[string, ScriptedReply]>([
    ['everything 200 html (captive portal)', html()],
    [
      'an ngrok interstitial',
      html(
        200,
        '<!DOCTYPE html><html><head><title>ngrok</title></head><body>Visit Site</body></html>',
      ),
    ],
    ['an nginx 502 error page', html(502, '<html><body><h1>502 Bad Gateway</h1></body></html>')],
    ['an nginx 404 error page', html(404, '<html><body><h1>404 Not Found</h1></body></html>')],
    ['plain text 500', { status: 500, body: 'Internal Server Error' }],
  ])('%s → not_openalgo, never too_old, ≤ 10 probes', async (_name, reply) => {
    const { http, posts } = setup(everything(reply))
    expect(await probeServer({ http, host: ORIGIN, now: NOW })).toEqual({ kind: 'not_openalgo' })
    expect(posts().length).toBeLessThanOrEqual(10)
  })
})

describe('bans and network errors', () => {
  test.each<[string, string, 'text' | 'json', ScriptedReply]>([
    ['app-info', APP_INFO, 'text', BAN_TEXT],
    ['app-info', APP_INFO, 'json', BAN_JSON],
    ['swagger', SWAGGER, 'json', BAN_JSON],
    ['the marker probe', post('multioptiongreeks'), 'text', BAN_TEXT],
  ])('a ban on %s → banned (%s)', async (_name, route, form, reply) => {
    const routes = everything(html())
    routes[route] = reply
    const { http } = setup(routes)
    expect(await probeServer({ http, host: ORIGIN, now: NOW })).toEqual({ kind: 'banned', form })
  })

  test('a ban stops the probe at once', async () => {
    const routes = everything(html())
    routes[SWAGGER] = BAN_TEXT
    const { http, fetch } = setup(routes)
    await probeServer({ http, host: ORIGIN, now: NOW })
    expect(fetch.calls).toHaveLength(2)
  })

  test('a network error on app-info → unreachable, and nothing else is sent', async () => {
    const routes = stock({ version: '2.0.3.5', endpoints: ALL_2_0_3_5 })
    routes[APP_INFO] = 'throw'
    const { http, fetch } = setup(routes)
    expect(await probeServer({ http, host: ORIGIN, now: NOW })).toEqual({ kind: 'unreachable' })
    expect(fetch.calls).toHaveLength(1)
  })
})

describe('readAppVersion', () => {
  test.each<[string, ScriptedReply, string | null]>([
    ['JSON with a string version, normalized', appInfo('v2.0.1.17'), '2.0.1.7'],
    ['JSON with a numeric version', { status: 200, body: { status: 'success', version: 2 } }, null],
    ['the SPA shell', html(), null],
    ['a 404 JSON', NOT_FOUND, null],
  ])('%s', async (_name, reply, out) => {
    const { http } = setup({ [APP_INFO]: reply })
    expect(await readAppVersion(http)).toBe(out)
  })

  test('throws Network and IpBanned', async () => {
    await expect(readAppVersion(setup({ [APP_INFO]: 'throw' }).http)).rejects.toMatchObject({
      kind: 'Network',
    })
    await expect(readAppVersion(setup({ [APP_INFO]: BAN_JSON }).http)).rejects.toMatchObject({
      kind: 'IpBanned',
    })
  })
})
