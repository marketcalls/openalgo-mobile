// The on-device routes against the server's own Python (design 9.2): each recorded case in
// test/golden/inputs answered by the five ported services, and compared with what
// scripts/golden/harness.py made of the same recording in test/golden/expected.
import { QueryClient } from '@tanstack/react-query'
import type { Api } from '~/core/http/api'
import { isRecord } from '~/core/http/errors'
import { createServerClock } from '~/core/http/serverClock'
import { createOptionsData } from '~/market/options/data'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import {
  fakeApi,
  type GoldenInput,
  type GoldenRoute,
  goldenCases,
} from '../../../test/helpers/golden'
import {
  gammaDensity,
  gexData,
  ivSmile,
  maxPain,
  oiData,
  type RouteDeps,
  RouteError,
  type ToolQuery,
} from './index'

/** How far a density may sit from the server's (the IV solvers differ in the last digits). */
const DENSITY_BOUND = 1e-9
/** The phone's clock is 3 minutes behind the server's. */
const SKEW_MS = 180_000

const ROUTES: readonly [GoldenRoute, (q: ToolQuery, d: RouteDeps) => Promise<unknown>][] = [
  ['get_oi_data', oiData],
  ['calculate_max_pain', maxPain],
  ['get_iv_smile_data', ivSmile],
  ['get_gex_data', gexData],
  ['calculate_gamma_density', gammaDensity],
]

/**
 * The routes' dependencies over the recording: the fake Api answers by request key, and every
 * key it has no reply for is noted, also where the caller swallows the error (the futures price
 * is null on any failure, as the server's is). The device clock is SKEW_MS behind; the chain's
 * `server_ts` sets the server clock (fakeApi stamps serverNowMs on every chain), or, for a
 * recording from a server before 2.0.2.0, the `Date` header the HTTP client notes.
 */
function goldenDeps(input: GoldenInput) {
  const fake = fakeApi(input)
  const misses: string[] = []
  const api: Pick<Api, 'call'> = {
    call: (id, body, schema, o) =>
      fake.call(id, body, schema, o).catch((e: unknown) => {
        misses.push(e instanceof Error ? e.message : String(e))
        throw e
      }),
  }
  const deviceNow = input.serverNowMs - SKEW_MS
  const clock = createServerClock(() => deviceNow)
  const stamped = Object.entries(input.responses).every(
    ([key, body]) => !key.startsWith('optionchain ') || (isRecord(body) && 'server_ts' in body),
  )
  if (!stamped) clock.noteDate(new Date(input.serverNowMs).toUTCString(), deviceNow)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const deps: RouteDeps = {
    options: createOptionsData({ api, queryClient, pid: 'golden', clock }),
    master: { underlyingsNow: async () => ({ list: [], source: 'defaults' }) },
    api,
    now: clock.now,
  }
  return { deps, misses, queryClient }
}

/** What the web route sends for a service result: the body with 200, or the service's error. */
async function answer(
  f: (q: ToolQuery, d: RouteDeps) => Promise<unknown>,
  q: ToolQuery,
  d: RouteDeps,
) {
  try {
    return { status: 200, body: await f(q, d) }
  } catch (e) {
    if (e instanceof RouteError) return { status: e.status, body: e.body }
    throw e
  }
}

type Density = { density_intraday: number; density_expiry: number }
const DENSITIES = ['density_intraday', 'density_expiry'] as const

/** The rows whose densities are not within DENSITY_BOUND (relative) of the server's. */
function densityMisses(got: unknown, want: unknown): string[] {
  const rows = (b: unknown) => (isRecord(b) && Array.isArray(b.chain) ? (b.chain as Density[]) : [])
  const ours = rows(got)
  return rows(want).flatMap((w, i) =>
    DENSITIES.flatMap((k) => {
      const a = ours[i]?.[k]
      const b = w[k]
      const close =
        a !== undefined &&
        (a === b || Math.abs(a - b) <= DENSITY_BOUND * Math.max(Math.abs(a), Math.abs(b)))
      return close ? [] : [`row ${i} ${k}: ${a} for ${b}`]
    }),
  )
}

/** The body with the densities left out, for the exact comparison of every other field. */
function withoutDensities(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.chain)) return body
  return {
    ...body,
    chain: body.chain.map((r) =>
      isRecord(r)
        ? Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('density_')))
        : r,
    ),
  }
}

beforeEach(() => keepExpectedLogs())
afterEach(() => jest.restoreAllMocks())

test.each(goldenCases())(
  '$id: oiData, maxPain, ivSmile, gexData and gammaDensity equal the Python output',
  async ({ input, expected }) => {
    const { deps, misses, queryClient } = goldenDeps(input)
    const q = { underlying: input.underlying, exchange: input.exchange, expiry_date: input.expiry }
    for (const [name, route] of ROUTES) {
      const want = expected.routes[name]
      const got = await answer(route, q, deps)
      expect([name, got.status]).toEqual([name, want.status])
      if (name === 'calculate_gamma_density') {
        expect(densityMisses(got.body, want.body)).toEqual([])
        expect(withoutDensities(got.body)).toEqual(withoutDensities(want.body))
      } else {
        expect([name, got.body]).toEqual([name, want.body])
      }
    }
    // the server's clock, not the phone's: every Greek above priced at serverNowMs
    expect(deps.now()).toBe(input.serverNowMs)
    expect(misses).toEqual([])
    queryClient.clear()
  },
)

test('an unknown request key fails the test (the route sent a body the server never got)', async () => {
  const [c] = goldenCases()
  if (!c) throw new Error('no golden case recorded')
  const q = {
    underlying: c.input.underlying,
    exchange: c.input.exchange,
    expiry_date: c.input.expiry,
  }

  // a chain the recording does not hold rejects the route
  const one = goldenDeps(c.input)
  await expect(oiData({ ...q, expiry_date: '07JAN27' }, one.deps)).rejects.toThrow(
    /no recorded reply for optionchain/,
  )
  expect(one.misses).toHaveLength(1)

  // a futures quote it does not hold is swallowed by the route (null, as the server's), but noted
  const responses = Object.fromEntries(
    Object.entries(c.input.responses).filter(([key]) => !key.startsWith('quotes ')),
  )
  const two = goldenDeps({ ...c.input, responses })
  const warned = expectLog('warn', /\[options\] futures price/)
  const r = await oiData(q, two.deps)
  expect(r.futures_price).toBeNull()
  expect(warned).toHaveLength(1)
  expect(two.misses).toEqual([expect.stringMatching(/no recorded reply for quotes/)])
  one.queryClient.clear()
  two.queryClient.clear()
})
