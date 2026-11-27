// The Straddle Chart and Straddle PnL routes on the phone: the strikes they read history for (the
// ATM strikes of the kept dates, then older dates only while the chart lacks a date), the
// simulation's entry, roll and exit, the lot size, and the services' own refusals (the golden
// test holds the figures to the server's Python).
import type { Api } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import type { DomReply, JSONValue } from '~/dom/bridge/protocol'
import type { HistoryRequest } from '~/market/history/batch'
import { pyRound } from '~/market/options/pyRound'
import { OptionChainSchema } from '~/market/options/schemas'
import { chainReply } from '../../../test/helpers/chains'
import { keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { type RouteDepsOverrides, testRouteDeps } from '../../../test/helpers/routeDeps'
import { createDeviceRoutes } from './index'
import { FAILED_COPY } from './query'
import { daysToExpiry, strikeLadder } from './straddle'

const IST_OFFSET_MS = 330 * 60_000
/** An IST wall time on a date, epoch seconds. */
const istSec = (iso: string, hhmm: string) =>
  (Date.parse(`${iso}T${hhmm}:00Z`) - IST_OFFSET_MS) / 1000

// Fri 27 Nov 2026, 16:00 IST
const NOW = istSec('2026-11-27', '16:00') * 1000
const EXPIRY = '01DEC26'
/** 23,800 to 24,300 in steps of 50. */
const LADDER = Array.from({ length: 11 }, (_, i) => 23_800 + i * 50)
const QUERY = { underlying: 'NIFTY', exchange: 'NFO', expiry_date: EXPIRY, interval: '1m' }
const CHART = '/straddle/api/straddle-data'
const SIMULATE = '/straddlepnl/api/simulate'
const LOTSIZE = '/straddlepnl/api/lotsize'
const LTP = 24_101.5

type Candle = [sec: number, close: number]
type Body = Record<string, unknown>

const ok = (data: unknown) => ({ status: 'success', data })
const rowsOf = (candles: readonly Candle[]) =>
  candles.map(([timestamp, close]) => ({ timestamp, open: close, high: close, low: close, close }))

/**
 * A fake server: the reference's candles, each option's (by symbol; none for any other), the
 * reference's quote, and the broker's intervals; `ref` an ApiError to fail the reference read, or
 * 'nan' for candles whose close is not a number (no schema lets one through: the fake hands them
 * over unparsed).
 */
function server(o: {
  ref: readonly Candle[] | ApiError | 'nan'
  legs?: Record<string, readonly Candle[]>
  ltp?: number | ApiError
}) {
  const sent: { id: string; body: Body }[] = []
  const api: Pick<Api, 'call'> = {
    async call(id, body, schema) {
      sent.push({ id, body: { ...body } })
      if (id === 'intervals') {
        return schema.parse(ok({ seconds: [], minutes: ['1m', '5m'], hours: ['1h'], days: ['D'] }))
      }
      if (id === 'quotes') {
        if (o.ltp instanceof ApiError) throw o.ltp
        return schema.parse(ok({ ltp: o.ltp ?? LTP }))
      }
      if (id === 'history') {
        const symbol = String(body.symbol)
        if (symbol === 'NIFTY' || symbol.endsWith('FUT')) {
          if (o.ref instanceof ApiError) throw o.ref
          if (o.ref === 'nan') {
            const close = Number.NaN
            return {
              rows: [{ timestamp: istSec('2026-11-27', '09:15'), close }],
              dropped: 0,
            } as never
          }
          return schema.parse(ok(rowsOf(o.ref)))
        }
        return schema.parse(ok(rowsOf(o.legs?.[symbol] ?? [])))
      }
      throw new Error(`no reply for ${id} ${JSON.stringify(body)}`)
    },
  }
  const history = () => sent.filter((s) => s.id === 'history').map((s) => s.body as HistoryRequest)
  return { api, sent, history }
}

function routes(api: Pick<Api, 'call'>, o: RouteDepsOverrides = {}) {
  const d = testRouteDeps({
    api,
    now: () => NOW,
    ...o,
    master: { strikes: async () => [...LADDER], ...o.master },
  })
  const all = createDeviceRoutes(d)
  const call = (method: 'GET' | 'POST', path: string, extra: Body): Promise<DomReply> => {
    const route = all.find((r) => r.method === method && r.path === path)
    if (!route) throw new Error(`no route ${method} ${path}`)
    return route.handle(
      { v: 1, kind: 'request', rid: 1, method, path, ...extra },
      new AbortController().signal,
    )
  }
  return {
    post: (path: string, body: Body) => call('POST', path, { body: body as JSONValue }),
    get: (path: string, query: Record<string, string>) => call('GET', path, { query }),
  }
}

/** A deterministic option close for a strike at a candle, with cents to round. */
const premium = (type: 'CE' | 'PE', K: number, sec: number) => {
  const step = (sec % 3_600) / 60
  return type === 'CE' ? 300.127 - (K - 23_800) / 4 + step * 0.35 : 50.113 + (K - 23_800) / 5 - step
}
const symbolOf = (K: number, type: 'CE' | 'PE') => `NIFTY${EXPIRY}${K}${type}`

/** Every strike's CE and PE at each of `times`, priced by `premium`. */
function allLegs(times: readonly number[]): Record<string, Candle[]> {
  const out: Record<string, Candle[]> = {}
  for (const K of LADDER) {
    for (const type of ['CE', 'PE'] as const) {
      out[symbolOf(K, type)] = times.map((sec) => [sec, premium(type, K, sec)])
    }
  }
  return out
}

/** Two candles a day, Tue 24 to Fri 27 Nov, each with its own ATM strike. */
const REF: Candle[] = [
  [istSec('2026-11-24', '09:15'), 23_810],
  [istSec('2026-11-24', '09:16'), 23_830],
  [istSec('2026-11-25', '09:15'), 23_905],
  [istSec('2026-11-25', '09:16'), 23_960],
  [istSec('2026-11-26', '09:15'), 24_010],
  [istSec('2026-11-26', '09:16'), 24_040],
  [istSec('2026-11-27', '09:15'), 24_120],
  [istSec('2026-11-27', '09:16'), 24_180],
]
const TIMES = REF.map(([sec]) => sec)
/** The ATM strike of each REF candle. */
const ATMS = [23_800, 23_850, 23_900, 23_950, 24_000, 24_050, 24_100, 24_200]

/** The symbols the history reads named, the reference's first, then the options' sorted. */
const readSymbols = (h: readonly HistoryRequest[]) => [
  h[0]?.symbol,
  ...h
    .slice(1)
    .map((r) => r.symbol)
    .sort(),
]
const legSymbols = (strikes: readonly number[]) =>
  strikes.flatMap((K) => [symbolOf(K, 'CE'), symbolOf(K, 'PE')]).sort()

/** The chart's point for REF candle `i`, as straddle_chart_service.py:297-313 builds it. */
function point(i: number) {
  const [sec, spot] = REF[i] as Candle
  const K = ATMS[i] as number
  const ce = premium('CE', K, sec)
  const pe = premium('PE', K, sec)
  const r2 = (x: number) => pyRound(x, 2)
  return {
    time: sec,
    spot,
    atm_strike: K,
    ce_price: r2(ce),
    pe_price: r2(pe),
    straddle: r2(ce + pe),
    synthetic_future: r2(K + ce - pe),
  }
}

beforeEach(() => keepExpectedLogs())
afterEach(() => jest.restoreAllMocks())

test('CE and PE are read only for the ATM strikes of the kept dates', async () => {
  const s = server({ ref: REF, legs: allLegs(TIMES) })
  const reply = await routes(s.api).post(CHART, { ...QUERY, days: 2 })

  expect(reply).toEqual({
    status: 200,
    body: {
      status: 'success',
      data: {
        underlying: 'NIFTY',
        underlying_ltp: LTP,
        expiry_date: EXPIRY,
        interval: '1m',
        days_to_expiry: 3,
        series: [4, 5, 6, 7].map(point),
      },
    },
  })
  // the reference over the trading window, then the 26th's and 27th's strikes only
  expect(readSymbols(s.history())).toEqual([
    'NIFTY',
    ...legSymbols([24_000, 24_050, 24_100, 24_200]),
  ])
  for (const r of s.history()) {
    expect(r).toMatchObject({ interval: '1m', start_date: '2026-11-19', end_date: '2026-11-27' })
  }
  expect(s.history()[0]?.exchange).toBe('NSE_INDEX')
  expect(
    new Set(
      s
        .history()
        .slice(1)
        .map((r) => r.exchange),
    ),
  ).toEqual(new Set(['NFO']))
  expect(s.sent.filter((x) => x.id === 'quotes').map((x) => x.body)).toEqual([
    { symbol: 'NIFTY', exchange: 'NSE_INDEX' },
  ])
})

test('a kept date with no option history pulls in the next older date, as the server would', async () => {
  // no option traded on the 27th: the server's full-window merge holds the 24th to the 26th,
  // and its last two dates are the 25th and the 26th
  const s = server({ ref: REF, legs: allLegs(TIMES.slice(0, 6)) })
  const reply = await routes(s.api).post(CHART, { ...QUERY, days: 2 })

  expect(reply.status).toBe(200)
  expect((reply.body as { data: { series: unknown } }).data.series).toEqual([2, 3, 4, 5].map(point))
  // the 25th's strikes were read once the 27th gave nothing; the 24th's never
  expect(readSymbols(s.history())).toEqual([
    'NIFTY',
    ...legSymbols([23_900, 23_950, 24_000, 24_050, 24_100, 24_200]),
  ])
  // and one batch per date: the kept dates', then the 25th's
  const batches = s.history().map((r) => r.symbol)
  expect(batches.slice(-4).sort()).toEqual(legSymbols([23_900, 23_950]))

  // with no option history at all every date is tried before the 404
  const none = server({ ref: REF })
  expect(await routes(none.api).post(CHART, { ...QUERY, days: 2 })).toEqual({
    status: 404,
    body: {
      status: 'error',
      message: 'No straddle data available (option history may be missing)',
    },
  })
  expect(readSymbols(none.history())).toEqual(['NIFTY', ...legSymbols(ATMS)])
})

test('days_to_expiry floors like timedelta.days and is 0 after expiry', () => {
  // 15:30 IST on 1 Dec 2026, whatever the exchange
  const cutoff = istSec('2026-12-01', '15:30') * 1000
  const DAY = 86_400_000
  expect(daysToExpiry(EXPIRY, cutoff - 2 * DAY)).toBe(2)
  expect(daysToExpiry(EXPIRY, cutoff - 2 * DAY + 1)).toBe(1)
  expect(daysToExpiry(EXPIRY, cutoff - 1)).toBe(0)
  expect(daysToExpiry(EXPIRY, cutoff + 1)).toBe(0)
  expect(daysToExpiry(EXPIRY, cutoff + 3 * DAY)).toBe(0)
  // strptime refuses a day the month does not have: 0
  expect(daysToExpiry('31NOV26', cutoff - 9 * DAY)).toBe(0)
})

test('simulate: entry, a roll after 50 points, exit; a missing leg candle keeps the last unrealized P&L', async () => {
  const at = (iso: string, hhmm: string) => istSec(iso, hhmm)
  const thu = (m: number) => at('2026-11-26', `09:${15 + m}`)
  const fri = (m: number) => at('2026-11-27', `09:${15 + m}`)
  const ref: Candle[] = [
    // the 25th is not simulated: its strike is never read
    [at('2026-11-25', '09:15'), 23_905],
    [thu(0), 24_010],
    [thu(1), 24_020],
    [thu(2), 24_030],
    [thu(3), 24_040],
    [thu(4), 24_045],
    [thu(5), 24_044],
    [fri(0), 24_100],
    [fri(1), 24_110],
    [fri(2), 24_105],
  ]
  const legs: Record<string, Candle[]> = {
    [symbolOf(24_000, 'CE')]: [
      [thu(0), 100],
      [thu(1), 110],
      [thu(2), 120],
    ],
    [symbolOf(24_000, 'PE')]: [
      [thu(0), 90],
      [thu(1), 85],
      [thu(2), 80],
    ],
    // no CE candle at 09:19 on Thursday
    [symbolOf(24_050, 'CE')]: [
      [thu(2), 95],
      [thu(3), 90],
      [thu(5), 85],
    ],
    [symbolOf(24_050, 'PE')]: [
      [thu(2), 105],
      [thu(3), 100],
      [thu(4), 98],
      [thu(5), 95],
    ],
    // none at Friday's last candle either: the exit takes the last unrealized P&L
    [symbolOf(24_100, 'CE')]: [
      [fri(0), 70],
      [fri(1), 65],
    ],
    [symbolOf(24_100, 'PE')]: [
      [fri(0), 60],
      [fri(1), 62],
      [fri(2), 61],
    ],
  }
  const s = server({ ref, legs })
  const reply = await routes(s.api).post(SIMULATE, {
    ...QUERY,
    days: 2,
    adjustment_points: 50,
    lot_size: 10,
    lots: 2,
  })

  const p = (
    time: number,
    pnl: number,
    spot: number,
    atm: number,
    entry: number,
    ce: number,
    pe: number,
    synthetic: number,
    adjustments: number,
  ) => ({
    time,
    pnl,
    spot,
    atm_strike: atm,
    entry_strike: entry,
    ce_price: ce,
    pe_price: pe,
    straddle: ce + pe,
    synthetic_future: synthetic,
    adjustments,
  })
  expect(reply).toEqual({
    status: 200,
    body: {
      status: 'success',
      data: {
        underlying: 'NIFTY',
        underlying_ltp: LTP,
        expiry_date: EXPIRY,
        interval: '1m',
        days_to_expiry: 3,
        adjustment_points: 50,
        lot_size: 10,
        lots: 2,
        quantity: 20,
        pnl_series: [
          p(thu(0), 0, 24_010, 24_000, 24_000, 100, 90, 24_010, 0),
          // ((100 - 110) + (90 - 85)) × 20
          p(thu(1), -100, 24_020, 24_000, 24_000, 110, 85, 24_025, 0),
          // rolled at 50 points: -200 realized, the new straddle flat
          p(thu(2), -200, 24_030, 24_050, 24_050, 95, 105, 24_040, 1),
          p(thu(3), 0, 24_040, 24_050, 24_050, 90, 100, 24_040, 1),
          // no CE candle: the last unrealized (+200) holds; the synthetic is the spot
          p(thu(4), 0, 24_045, 24_050, 24_050, 0, 98, 24_045, 1),
          p(thu(5), 200, 24_044, 24_050, 24_050, 85, 95, 24_040, 1),
          p(fri(0), 200, 24_100, 24_100, 24_100, 70, 60, 24_110, 1),
          p(fri(1), 260, 24_110, 24_100, 24_100, 65, 62, 24_103, 1),
          p(fri(2), 260, 24_105, 24_100, 24_100, 0, 61, 24_105, 1),
        ],
        trades: [
          {
            time: thu(0),
            type: 'ENTRY',
            strike: 24_000,
            ce_price: 100,
            pe_price: 90,
            straddle: 190,
            spot: 24_010,
            leg_pnl: 0,
            cumulative_pnl: 0,
          },
          {
            time: thu(2),
            type: 'ADJUSTMENT',
            old_strike: 24_000,
            strike: 24_050,
            exit_ce: 120,
            exit_pe: 80,
            exit_straddle: 200,
            ce_price: 95,
            pe_price: 105,
            straddle: 200,
            spot: 24_030,
            leg_pnl: -200,
            cumulative_pnl: -200,
          },
          {
            time: thu(5),
            type: 'EXIT',
            strike: 24_050,
            ce_price: 85,
            pe_price: 95,
            straddle: 180,
            spot: 24_044,
            leg_pnl: 400,
            cumulative_pnl: 200,
          },
          {
            time: fri(0),
            type: 'ENTRY',
            strike: 24_100,
            ce_price: 70,
            pe_price: 60,
            straddle: 130,
            spot: 24_100,
            leg_pnl: 0,
            cumulative_pnl: 200,
          },
          {
            time: fri(2),
            type: 'EXIT',
            strike: 24_100,
            ce_price: 0,
            pe_price: 61,
            straddle: 61,
            spot: 24_105,
            leg_pnl: 60,
            cumulative_pnl: 260,
          },
        ],
        summary: { total_pnl: 260, total_adjustments: 1, max_pnl: 260, min_pnl: -200 },
      },
    },
  })
  // the last two dates' strikes only: the simulation never pulls in an older date
  expect(readSymbols(s.history())).toEqual(['NIFTY', ...legSymbols([24_000, 24_050, 24_100])])
  expect(s.history()[0]).toMatchObject({ start_date: '2026-11-19', end_date: '2026-11-27' })
})

test("the summary's min keeps Python's first of equal values: a -0 P&L after the entry's 0", async () => {
  const at = (m: number) => istSec('2026-11-27', `09:${15 + m}`)
  const ref: Candle[] = [
    [at(0), 24_010],
    [at(1), 24_012],
    [at(2), 24_014],
  ]
  const legs: Record<string, Candle[]> = {
    // 0.1 + 0.2 is a hair over 0.3: the P&L at 09:16 is about -5.6e-17, which rounds to -0
    [symbolOf(24_000, 'CE')]: [
      [at(0), 0.3],
      [at(1), 0.1 + 0.2],
      [at(2), 0.2],
    ],
    [symbolOf(24_000, 'PE')]: [
      [at(0), 10],
      [at(1), 10],
      [at(2), 9],
    ],
  }
  const reply = await routes(server({ ref, legs }).api).post(SIMULATE, {
    ...QUERY,
    lot_size: 1,
    lots: 1,
  })
  const data = (reply.body as { data: { pnl_series: { pnl: number }[]; summary: unknown } }).data
  expect(data.pnl_series.map((p) => p.pnl)).toEqual([0, -0, 1.1])
  // Math.min(0, -0) is -0; Python's min keeps the 0 it saw first
  expect(data.summary).toEqual({ total_pnl: 1.1, total_adjustments: 0, max_pnl: 1.1, min_pnl: 0 })
})

test("lotsize from the master; without one, from the nearest expiry's chain", async () => {
  const s = server({ ref: REF })
  const asked: unknown[] = []
  const lotSizeLike = jest.fn(async () => 65 as number | null | undefined)
  const r = routes(s.api, { master: { lotSizeLike } })
  // request.args, trimmed and upper-cased
  expect(await r.get(LOTSIZE, { underlying: ' nifty ', exchange: 'nfo' })).toEqual({
    status: 200,
    body: { status: 'success', lotsize: 65 },
  })
  expect(lotSizeLike).toHaveBeenCalledWith('NFO', 'NIFTY')

  // a master with no such row: null, and nothing read
  lotSizeLike.mockResolvedValueOnce(null)
  expect(await r.get(LOTSIZE, { underlying: 'NIFTY', exchange: 'NFO' })).toEqual({
    status: 200,
    body: { status: 'success', lotsize: null },
  })

  // no master stored: the nearest expiry's one-strike chain
  const expiries = jest.fn(async () => ['01-DEC-26', '08-DEC-26'])
  const noMaster = routes(s.api, {
    master: { lotSizeLike: async () => undefined },
    options: {
      expiries,
      chain: async (q) => {
        asked.push(q)
        return OptionChainSchema.parse(
          chainReply({ expiry: EXPIRY, spot: 24_010, each: 1, lot: 75 }),
        )
      },
    },
  })
  expect(await noMaster.get(LOTSIZE, { underlying: 'NIFTY', exchange: 'NFO' })).toEqual({
    status: 200,
    body: { status: 'success', lotsize: 75 },
  })
  expect(expiries).toHaveBeenCalledWith('NFO', 'NIFTY', 'options')
  expect(asked).toEqual([
    { underlying: 'NIFTY', exchange: 'NFO', expiry_date: EXPIRY, strike_count: 1 },
  ])
  // nothing listed: null
  expiries.mockResolvedValueOnce([])
  expect(await noMaster.get(LOTSIZE, { underlying: 'NIFTY', exchange: 'NFO' })).toEqual({
    status: 200,
    body: { status: 'success', lotsize: null },
  })

  expect(await r.get(LOTSIZE, { underlying: ' ', exchange: 'NFO' })).toEqual({
    status: 400,
    body: { status: 'error', message: 'underlying and exchange required' },
  })
  expect(await r.get(LOTSIZE, { underlying: 'NIFTY' })).toEqual({
    status: 400,
    body: { status: 'error', message: 'underlying and exchange required' },
  })
  expect(s.sent).toEqual([])
})

test("strikeLadder: the master's call strikes; without a master, one 40-strike chain's", async () => {
  const strikes = jest.fn(async () => [24_000, 24_050] as number[] | null)
  const asked: unknown[] = []
  const chain = async (q: unknown) => {
    asked.push(q)
    const reply = chainReply({ expiry: EXPIRY, spot: 24_010, each: 2 })
    // a strike that lists no call is not on the ladder
    const [lowest] = reply.chain as { ce: unknown }[]
    if (lowest) lowest.ce = null
    return OptionChainSchema.parse(reply)
  }
  const d = testRouteDeps({ master: { strikes }, options: { chain } })
  expect(await strikeLadder('NIFTY', EXPIRY, 'NFO', d)).toEqual([24_000, 24_050])
  expect(strikes).toHaveBeenCalledWith('NFO', 'NIFTY', EXPIRY, 'CE')
  expect(asked).toEqual([])

  strikes.mockResolvedValueOnce(null)
  expect(await strikeLadder('NIFTY', EXPIRY, 'NFO', d)).toEqual([23_950, 24_000, 24_050, 24_100])
  expect(asked).toEqual([
    { underlying: 'NIFTY', exchange: 'NFO', expiry_date: EXPIRY, strike_count: 40 },
  ])
})

describe('no strikes, or an empty reference history, give the server messages and statuses', () => {
  const error = (status: number, message: string) => ({
    status,
    body: { status: 'error', message },
  })
  const both = async (
    s: ReturnType<typeof server>,
    o: RouteDepsOverrides = {},
    query: Body = QUERY,
  ) => {
    const r = routes(s.api, o)
    return [await r.post(CHART, query), await r.post(SIMULATE, query)]
  }

  test('no strikes listed for the expiry: 404', async () => {
    const s = server({ ref: REF })
    expect(await both(s, { master: { strikes: async () => [] } })).toEqual([
      error(404, `No strikes found for NIFTY ${EXPIRY} on NFO`),
      error(404, `No strikes found for NIFTY ${EXPIRY} on NFO`),
    ])
    expect(s.history()).toEqual([])
  })

  test('a failed reference read: 400 with its message, else Unknown error and Unknown', async () => {
    const said = new ApiError({
      kind: 'Server',
      status: 500,
      endpoint: 'history',
      serverMessage: 'Broker said no',
    })
    expect(await both(server({ ref: said }))).toEqual([
      error(400, 'Failed to fetch underlying history: Broker said no'),
      error(400, 'Failed to fetch underlying history: Broker said no'),
    ])
    const silent = new ApiError({ kind: 'Network', status: 0, endpoint: 'history' })
    expect(await both(server({ ref: silent }))).toEqual([
      error(400, 'Failed to fetch underlying history: Unknown error'),
      error(400, 'Failed to fetch underlying history: Unknown'),
    ])
  })

  test('an empty reference history: 404; no finite close: 400; no option history: 404', async () => {
    expect(await both(server({ ref: [] }))).toEqual([
      error(404, 'No underlying history data available'),
      error(404, 'No underlying history data'),
    ])
    expect(await both(server({ ref: 'nan' }))).toEqual([
      error(400, 'Could not determine any ATM strikes'),
      error(400, 'Could not determine ATM strikes'),
    ])
    expect(await both(server({ ref: REF }))).toEqual([
      error(404, 'No straddle data available (option history may be missing)'),
      error(404, 'No simulation data (option history may be missing)'),
    ])
  })

  test("a no-spot venue with no future listed, or CRYPTO with no perpetual: 404, each route's words", async () => {
    const s = server({ ref: REF })
    const mcx = { underlying: 'CRUDEOIL', exchange: 'MCX', expiry_date: '16DEC26' }
    expect(await both(s, { options: { expiries: async () => [] } }, mcx)).toEqual([
      error(404, 'No unexpired futures found for CRUDEOIL on MCX'),
      error(404, 'No unexpired futures found for CRUDEOIL on MCX'),
    ])
    const btc = { underlying: 'BTC', exchange: 'CRYPTO', expiry_date: '26DEC26' }
    expect(await both(s, { master: { futures: async () => [] } }, btc)).toEqual([
      error(404, 'No perpetual futures found for BTC on CRYPTO'),
      error(404, 'No perpetual futures found for BTC'),
    ])
    expect(s.history()).toEqual([])
  })

  test('the bodies: an interval the broker does not offer, the simulation’s limits, in the route’s order', async () => {
    const s = server({ ref: REF })
    const r = routes(s.api)
    const allowed = 'Invalid interval. Allowed: 1m, 5m, 1h'
    expect(await r.post(CHART, { ...QUERY, interval: 'D' })).toEqual(error(400, allowed))
    expect(await r.post(SIMULATE, { ...QUERY, interval: ' 2h ' })).toEqual(error(400, allowed))
    expect(s.sent.map((x) => x.id)).toEqual(['intervals', 'intervals'])

    expect(await r.post(SIMULATE, { ...QUERY, adjustment_points: 0 })).toEqual(
      error(400, 'adjustment_points must be >= 1'),
    )
    expect(await r.post(SIMULATE, { ...QUERY, lot_size: 0 })).toEqual(
      error(400, 'lot_size and lots must be >= 1'),
    )
    expect(await r.post(SIMULATE, { ...QUERY, lots: '0' })).toEqual(
      error(400, 'lot_size and lots must be >= 1'),
    )
    // custom_straddle.py:53-62: the required fields first, then the points, then the lots
    expect(await r.post(SIMULATE, { exchange: 'NFO', adjustment_points: 0, lots: 0 })).toEqual(
      error(400, 'underlying, exchange, and expiry_date are required'),
    )
    expect(await r.post(SIMULATE, { ...QUERY, adjustment_points: 0, lots: 0 })).toEqual(
      error(400, 'adjustment_points must be >= 1'),
    )
    // int() raises before any check: the route's 500
    expect(await r.post(SIMULATE, { expiry_date: EXPIRY, days: 'one' })).toEqual(
      error(500, FAILED_COPY),
    )
    expect(await r.post(CHART, { ...QUERY, days: 2.5, interval: 5 })).toEqual(
      error(500, FAILED_COPY),
    )
    expect(s.sent.map((x) => x.id)).toEqual(['intervals', 'intervals'])
  })

  test('days: 5 for the chart and 1 for the simulation when none is sent, kept within 1 to 30', async () => {
    const starts = async (path: string, body: Body) => {
      const s = server({ ref: [] })
      await routes(s.api).post(path, body)
      return s.history()[0]?.start_date
    }
    // max(2, 3·days + 2) calendar days before the 27th
    expect(await starts(CHART, QUERY)).toBe('2026-11-10')
    expect(await starts(SIMULATE, QUERY)).toBe('2026-11-22')
    expect(await starts(CHART, { ...QUERY, days: 99 })).toBe('2026-08-27')
    expect(await starts(SIMULATE, { ...QUERY, days: '0' })).toBe('2026-11-22')
  })
})

test('a page that aborts while the strikes are read gets no reply and no older date is read', async () => {
  const s = server({ ref: REF })
  const page = new AbortController()
  const api: Pick<Api, 'call'> = {
    call: (id, body, schema, o) => {
      if (id === 'history' && String(body.symbol) !== 'NIFTY') page.abort()
      return s.api.call(id, body, schema, o)
    },
  }
  const d = testRouteDeps({ api, now: () => NOW, master: { strikes: async () => [...LADDER] } })
  const route = createDeviceRoutes(d).find((x) => x.path === CHART)
  if (!route) throw new Error('no chart route')
  await expect(
    route.handle(
      { v: 1, kind: 'request', rid: 1, method: 'POST', path: CHART, body: { ...QUERY, days: 2 } },
      page.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' })
  // the kept dates' batch only, and no quote
  expect(readSymbols(s.history())).toEqual([
    'NIFTY',
    ...legSymbols([24_000, 24_050, 24_100, 24_200]),
  ])
  expect(s.sent.some((x) => x.id === 'quotes')).toBe(false)
})
