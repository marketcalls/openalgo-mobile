import type { Api } from '~/core/http/api'
import { createHttpClient } from '~/core/http/client'
import { ApiError } from '~/core/http/errors'
import { type Route, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { createGttApi, type GttApi, type GttSeen } from './api'
import { type GttSpec, gttCancelBody, gttModifyBody, gttPlaceBody } from './schemas'

const SPEC: GttSpec = {
  type: 'SINGLE',
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'SELL',
  product: 'CNC',
  quantity: 1,
  trigger: 1500,
  price: 1499,
  above: false,
}

const SANDBOX_501: Route = {
  status: 501,
  body: {
    mode: 'analyze',
    status: 'error',
    message: 'Sandbox GTT support not yet implemented',
  },
}
const BROKER_501: Route = {
  status: 501,
  body: { status: 'error', message: "GTT orders are not supported for broker 'angel' yet" },
}
/** A server without the route: Flask's HTML 404. */
const NO_ROUTE: Route = {
  status: 404,
  contentType: 'text/html; charset=utf-8',
  body: '<!doctype html><title>404 Not Found</title>',
}
const NOT_ACTIVE: Route = {
  status: 404,
  body: { status: 'error', message: "No active GTT with trigger_id '1001'" },
}
const QUEUED: Route = {
  status: 200,
  body: {
    status: 'success',
    message: 'Order queued for approval in Action Center',
    mode: 'semi_auto',
    pending_order_id: 3,
  },
}
const ok = (body: Record<string, unknown>): Route => ({
  status: 200,
  body: { status: 'success', ...body },
})

/** The GTT API over the real HTTP client, so each reply goes through its classification. */
function overHttp(routes: Record<string, Route>) {
  const fetch = scriptedFetch(routes)
  const http = createHttpClient({
    origin: 'https://algo.example.com',
    getKey: () => 'ab'.repeat(32),
    fetch,
    resolveAuth403: async () => 'key_invalid',
  })
  const api: Api = { call: (id, body, schema, o) => http.request(id, body, schema, o) }
  const recorded: [boolean, 'live' | 'analyze'][] = []
  const seen: GttSeen = { record: (ok, mode) => void recorded.push([ok, mode]) }
  const bodies = (id: string) =>
    fetch.calls
      .filter((c) => c.url.endsWith(`/api/v1/${id}`))
      .map((c) => {
        const { apikey: _, ...rest } = c.body as Record<string, unknown>
        return rest
      })
  return { gtt: createGttApi(api, seen), recorded, bodies }
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('expected the call to fail')
}

beforeEach(() => {
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})
afterEach(() => jest.restoreAllMocks())

describe('the calls', () => {
  test('each write posts its body once; book asks for every status', async () => {
    const reply = ok({ trigger_id: '1001' })
    const h = overHttp({
      'POST /api/v1/placegttorder': reply,
      'POST /api/v1/modifygttorder': reply,
      'POST /api/v1/cancelgttorder': reply,
      'POST /api/v1/gttorderbook': ok({ data: [] }),
    })
    const done = { kind: 'ok', triggerId: '1001', analyze: false }
    await expect(h.gtt.place(SPEC)).resolves.toEqual(done)
    await expect(h.gtt.modify('1001', SPEC)).resolves.toEqual(done)
    await expect(h.gtt.cancel('1001')).resolves.toEqual(done)
    await expect(h.gtt.book()).resolves.toEqual({ rows: [], dropped: 0, analyze: false })
    expect(h.bodies('placegttorder')).toEqual([gttPlaceBody(SPEC)])
    expect(h.bodies('modifygttorder')).toEqual([gttModifyBody('1001', SPEC)])
    expect(h.bodies('cancelgttorder')).toEqual([gttCancelBody('1001')])
    expect(h.bodies('gttorderbook')).toEqual([{ status: 'all' }])
  })

  test('the options reach the request: an aborted call rejects', async () => {
    const h = overHttp({ 'POST /api/v1/gttorderbook': ok({ data: [] }) })
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await failure(h.gtt.book({ signal: ctrl.signal }))).toMatchObject({ kind: 'Network' })
  })

  test('a write that gets no reply is MaybePlaced (the order lane)', async () => {
    const h = overHttp({ 'POST /api/v1/placegttorder': 'throw' })
    expect(await failure(h.gtt.place(SPEC))).toMatchObject({ kind: 'MaybePlaced', status: 0 })
  })
})

describe('what a reply shows about support, by its own mode (RF 2)', () => {
  test('a success records its mode: the sandbox tag is analyze, none is live', async () => {
    const h = overHttp({
      'POST /api/v1/placegttorder': ok({ trigger_id: '1001', mode: 'analyze' }),
      'POST /api/v1/cancelgttorder': ok({ trigger_id: '1001' }),
    })
    await h.gtt.place(SPEC)
    await h.gtt.cancel('1001')
    expect(h.recorded).toEqual([
      [true, 'analyze'],
      [true, 'live'],
    ])
  })

  test("a book success with mode:'analyze' records analyze", async () => {
    const h = overHttp({ 'POST /api/v1/gttorderbook': ok({ data: [], mode: 'analyze' }) })
    await h.gtt.book()
    expect(h.recorded).toEqual([[true, 'analyze']])
  })

  test('a 501 on place records live as unsupported and rethrows', async () => {
    const h = overHttp({ 'POST /api/v1/placegttorder': BROKER_501 })
    expect(await failure(h.gtt.place(SPEC))).toMatchObject({ kind: 'Unsupported', status: 501 })
    expect(h.recorded).toEqual([[false, 'live']])
  })

  test("the sandbox's 501 records analyze only, on place and on the book", async () => {
    const h = overHttp({
      'POST /api/v1/placegttorder': SANDBOX_501,
      'POST /api/v1/gttorderbook': SANDBOX_501,
    })
    await failure(h.gtt.place(SPEC))
    await failure(h.gtt.book())
    expect(h.recorded).toEqual([
      [false, 'analyze'],
      [false, 'analyze'],
    ])
  })

  test('a missing route (HTML) on the book or place records both modes', async () => {
    const h = overHttp({
      'POST /api/v1/gttorderbook': NO_ROUTE,
      'POST /api/v1/placegttorder': NO_ROUTE,
    })
    expect(await failure(h.gtt.book())).toMatchObject({ kind: 'Unsupported', status: 404 })
    await failure(h.gtt.place(SPEC))
    expect(h.recorded).toEqual([
      [false, 'live'],
      [false, 'analyze'],
      [false, 'live'],
      [false, 'analyze'],
    ])
  })

  test("a JSON 404 on place is the broker's refusal, not a missing route: nothing recorded", async () => {
    const h = overHttp({
      'POST /api/v1/placegttorder': {
        status: 404,
        body: { status: 'error', message: 'Not found' },
      },
    })
    expect(await failure(h.gtt.place(SPEC))).toMatchObject({
      kind: 'Unsupported',
      serverMessage: 'Not found',
    })
    expect(h.recorded).toEqual([])
  })

  test('a 404 "No active GTT…" on cancel or modify rethrows unrecorded', async () => {
    const h = overHttp({
      'POST /api/v1/cancelgttorder': NOT_ACTIVE,
      'POST /api/v1/modifygttorder': NOT_ACTIVE,
    })
    const cancel = await failure(h.gtt.cancel('1001'))
    expect(cancel).toMatchObject({
      kind: 'Unsupported',
      status: 404,
      endpoint: 'cancelgttorder',
      serverMessage: "No active GTT with trigger_id '1001'",
    })
    await failure(h.gtt.modify('1001', SPEC))
    expect(h.recorded).toEqual([])
  })

  test('modify and cancel never record false, not even on a 501 or a missing route', async () => {
    const h = overHttp({
      'POST /api/v1/modifygttorder': BROKER_501,
      'POST /api/v1/cancelgttorder': NO_ROUTE,
    })
    await failure(h.gtt.modify('1001', SPEC))
    await failure(h.gtt.cancel('1001'))
    expect(h.recorded).toEqual([])
  })

  test('a queued reply or one without an id records nothing (Semi-Auto queues before any check)', async () => {
    const h = overHttp({
      'POST /api/v1/placegttorder': QUEUED,
      'POST /api/v1/modifygttorder': ok({}),
    })
    await expect(h.gtt.place(SPEC)).resolves.toEqual({ kind: 'queued', pendingId: '3' })
    await expect(h.gtt.modify('1001', SPEC)).resolves.toEqual({ kind: 'no_id' })
    expect(h.recorded).toEqual([])
  })

  test('other failures record nothing: a validation refusal, a server error, no reply', async () => {
    const h = overHttp({
      'POST /api/v1/placegttorder': {
        status: 400,
        body: {
          status: 'error',
          message:
            'GTT supports only CNC (delivery) or NRML (overnight F&O); MIS is intraday-only.',
        },
      },
      'POST /api/v1/gttorderbook': {
        status: 500,
        body: { status: 'error', message: 'Failed to fetch GTT book' },
      },
    })
    expect(await failure(h.gtt.place(SPEC))).toMatchObject({ kind: 'Validation' })
    expect(await failure(h.gtt.book())).toMatchObject({ kind: 'Server' })
    expect(h.recorded).toEqual([])
  })
})

describe('GttApi', () => {
  test('has exactly place, modify, cancel and book', () => {
    const gtt: GttApi = overHttp({}).gtt
    expect(Object.keys(gtt).sort()).toEqual(['book', 'cancel', 'modify', 'place'])
  })
})
