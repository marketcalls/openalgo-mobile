import { asyncStorageKV as kv } from '~/core/config/bindings'
import { createApi } from '~/core/http/api'
import { createHttpClient } from '~/core/http/client'
import { ApiError } from '~/core/http/errors'
import { createScheduler } from '~/core/http/scheduler'
import { FundsSchema } from '~/core/http/schemas'
import { CONNECTION_DEFAULTS, useConnection } from '~/core/services/connection'
import { type Route, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { checkKey, createBrokerStatus } from './status'

const KEY = 'ab'.repeat(32)
const BAD_KEY = { status: 403, body: { status: 'error', message: 'Invalid openalgo apikey' } }
const FUNDS_OK = {
  status: 200,
  body: { status: 'success', data: { availablecash: '320.66', collateral: '0' } },
}
const SEARCH_OK = { status: 200, body: { status: 'success', data: [] } }

let clock = 0

beforeEach(() => {
  clock = 0
  useConnection.getState().reset()
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})
afterEach(() => jest.restoreAllMocks())

function setup(routes: Record<string, Route>) {
  const fetch = scriptedFetch(routes)
  const ref: { status?: ReturnType<typeof createBrokerStatus> } = {}
  const http = createHttpClient({
    origin: 'https://algo.example.com',
    getKey: () => KEY,
    fetch,
    resolveAuth403: () => ref.status?.resolveAuth403() as Promise<'key_invalid'>,
  })
  const api = createApi({
    http,
    scheduler: createScheduler(),
    fields: { adapt: (_id, b) => b, markUnsupported: () => {} },
  })
  const status = createBrokerStatus({ api, http, conn: useConnection, now: () => clock })
  ref.status = status
  const searches = () => fetch.calls.filter((c) => c.url.endsWith('/api/v1/search'))
  return { status, http, fetch, searches }
}

test('checkKey sends NIFTY on NSE_INDEX', async () => {
  const { http, searches } = setup({ 'POST /api/v1/search': SEARCH_OK })
  expect(await checkKey(http)).toBe('ok')
  expect(searches()[0]?.body).toEqual({ query: 'NIFTY', exchange: 'NSE_INDEX', apikey: KEY })
})

test('checkKey: a 403 is invalid; any other error is rethrown', async () => {
  expect(await checkKey(setup({ 'POST /api/v1/search': BAD_KEY }).http)).toBe('invalid')
  const down = setup({ 'POST /api/v1/search': 'throw' }).http
  await expect(checkKey(down)).rejects.toMatchObject({ kind: 'Network' })
})

test('check: funds 200 is active', async () => {
  const { status } = setup({ 'POST /api/v1/funds': FUNDS_OK })
  expect(await status.check()).toBe('active')
  expect(useConnection.getState()).toMatchObject({ brokerSession: 'active', keyState: 'ok' })
})

test('check: funds 403 and search 200 is logged_out', async () => {
  const { status } = setup({
    'POST /api/v1/funds': BAD_KEY,
    'POST /api/v1/search': SEARCH_OK,
  })
  expect(await status.check()).toBe('logged_out')
  expect(useConnection.getState()).toMatchObject({ brokerSession: 'logged_out', keyState: 'ok' })
})

test('check: funds 403 and search 403 is an invalid key', async () => {
  const { status } = setup({ 'POST /api/v1/funds': BAD_KEY, 'POST /api/v1/search': BAD_KEY })
  await status.check()
  expect(useConnection.getState().keyState).toBe('invalid')
})

test('check: anything else is unknown', async () => {
  const { status } = setup({ 'POST /api/v1/funds': { status: 500, body: 'oops' } })
  expect(await status.check()).toBe('unknown')
  expect(useConnection.getState()).toMatchObject({ brokerSession: 'unknown', keyState: 'unknown' })
})

test('RF 3: 20 concurrent 403s make one search and all reject with the right kind', async () => {
  const { http, searches, fetch } = setup({
    'POST /api/v1/funds': BAD_KEY,
    'POST /api/v1/search': BAD_KEY,
  })
  const run = () => http.request('funds', {}, FundsSchema)
  const results = await Promise.allSettled(Array.from({ length: 20 }, run))
  expect(results.every((r) => r.status === 'rejected')).toBe(true)
  for (const r of results) {
    expect((r as PromiseRejectedResult).reason).toMatchObject({ kind: 'KeyInvalid' })
  }
  expect(searches()).toHaveLength(1)
  expect(useConnection.getState().keyState).toBe('invalid')

  // A 21st within 30 s reuses the answer.
  clock = 29_999
  await expect(run()).rejects.toMatchObject({ kind: 'KeyInvalid' })
  expect(searches()).toHaveLength(1)
  expect(fetch.calls.filter((c) => c.url.endsWith('/funds'))).toHaveLength(21)

  // After 30 s it asks again.
  clock = 30_000
  await expect(run()).rejects.toMatchObject({ kind: 'KeyInvalid' })
  expect(searches()).toHaveLength(2)
})

test('concurrent 403s with a good key all reject BrokerLoggedOut', async () => {
  const { http, searches } = setup({
    'POST /api/v1/funds': BAD_KEY,
    'POST /api/v1/search': SEARCH_OK,
  })
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => http.request('funds', {}, FundsSchema)),
  )
  for (const r of results) {
    expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ApiError)
    expect((r as PromiseRejectedResult).reason).toMatchObject({ kind: 'BrokerLoggedOut' })
  }
  expect(searches()).toHaveLength(1)
})

test('a failed search is not cached', async () => {
  let n = 0
  const { status, searches } = setup({
    'POST /api/v1/search': () => (n++ === 0 ? 'throw' : SEARCH_OK),
  })
  await expect(status.resolveAuth403()).rejects.toMatchObject({ kind: 'Network' })
  await expect(status.resolveAuth403()).resolves.toBe('broker_logged_out')
  expect(searches()).toHaveLength(2)
})

test('reset forgets the cached split', async () => {
  const { status, searches } = setup({ 'POST /api/v1/search': BAD_KEY })
  await status.resolveAuth403()
  status.reset()
  await status.resolveAuth403()
  expect(searches()).toHaveLength(2)
})

test('fetchBrokerName reads ping; null when it fails', async () => {
  const ok = setup({
    'POST /api/v1/ping': {
      status: 200,
      body: { status: 'success', data: { message: 'pong', broker: 'zerodha' } },
    },
  })
  expect(await ok.status.fetchBrokerName()).toBe('zerodha')
  expect(useConnection.getState().broker).toBe('zerodha')
  expect(await setup({ 'POST /api/v1/ping': 'throw' }).status.fetchBrokerName()).toBeNull()
})

test('the serialized state never contains the key', async () => {
  const { status } = setup({ 'POST /api/v1/funds': BAD_KEY, 'POST /api/v1/search': BAD_KEY })
  await status.check()
  const state = JSON.stringify(useConnection.getState())
  const stored = JSON.stringify(await Promise.all((await kv.keys('oa.')).map((k) => kv.get(k))))
  expect(state).not.toContain(KEY)
  expect(stored).not.toContain(KEY)
  expect(Object.keys(useConnection.getState())).toEqual(
    expect.arrayContaining(Object.keys(CONNECTION_DEFAULTS)),
  )
})

test('a search that finishes after reset() is dropped', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((r) => {
    release = r
  })
  const { status, searches } = setup({
    'POST /api/v1/search': async () => {
      await gate
      return BAD_KEY
    },
  })
  const old = status.resolveAuth403()
  await Promise.resolve()
  status.reset()
  release?.()
  await expect(old).resolves.toBe('key_invalid')
  expect(useConnection.getState().keyState).toBe(CONNECTION_DEFAULTS.keyState)
  clock = 1
  // Nothing was cached, so the next call searches again.
  await status.resolveAuth403().catch(() => {})
  expect(searches()).toHaveLength(2)
})

test('funds 200 clears the cached broker_logged_out split', async () => {
  let funds = 0
  const { status, searches } = setup({
    'POST /api/v1/search': SEARCH_OK,
    'POST /api/v1/funds': () => (funds++ === 0 ? FUNDS_OK : BAD_KEY),
  })
  await expect(status.resolveAuth403()).resolves.toBe('broker_logged_out')
  expect(searches()).toHaveLength(1)
  await expect(status.check()).resolves.toBe('active')
  clock = 5_000 // still inside the 30 s window
  await status.resolveAuth403()
  expect(searches()).toHaveLength(2)
})
