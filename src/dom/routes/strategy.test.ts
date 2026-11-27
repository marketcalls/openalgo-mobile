// The Strategy Builder's routes on the phone: the strategy chart and multi-strike OI (which legs
// count, the one history batch, the reference, the windows, Python's sum for the entry premium),
// the intervals and the futures picker, and the blueprints' own refusals (the golden test holds
// the figures to the server's Python).
import type { Api } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import type { DomReply, JSONValue } from '~/dom/bridge/protocol'
import type { HistoryRequest } from '~/market/history/batch'
import type { MasterRow } from '~/market/master/db'
import { pyRound } from '~/market/options/pyRound'
import { keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { type RouteDepsOverrides, testRouteDeps } from '../../../test/helpers/routeDeps'
import { RouteError } from './deps'
import { createDeviceRoutes } from './index'
import { FAILED_COPY } from './query'
import { explicitWindow } from './strategyChart'

const IST_OFFSET_MS = 330 * 60_000
/** An IST wall time on a date, epoch seconds. */
const istSec = (iso: string, hhmm: string) =>
  (Date.parse(`${iso}T${hhmm}:00Z`) - IST_OFFSET_MS) / 1000

// Fri 27 Nov 2026, 16:00 IST
const NOW = istSec('2026-11-27', '16:00') * 1000
const CHART = '/strategybuilder/api/strategy-chart'
const OI = '/strategybuilder/api/multi-strike-oi'
const FUTURES = '/scalping/api/futures'
const LTP = 24_101.35

const CE = 'NIFTY01DEC2624000CE'
const PE = 'NIFTY01DEC2624000PE'
const CE2 = 'NIFTY01DEC2624100CE'
const FUT = 'NIFTY29DEC26FUT'

type Candle = { t: number; close: number; oi?: number }
type Body = Record<string, unknown>

const ok = (data: unknown) => ({ status: 'success', data })
const r2 = (x: number) => pyRound(x, 2)
const rowsOf = (candles: readonly Candle[]) =>
  candles.map(({ t, close, oi }) => ({
    timestamp: t,
    open: close,
    high: close,
    low: close,
    close,
    ...(oi === undefined ? {} : { oi }),
  }))
const failed = (endpoint: string, status = 400) =>
  new ApiError({ kind: 'Validation', status, endpoint, serverMessage: 'Invalid symbol' })

/** A leg as the builder posts it. */
const leg = (symbol: string, side: 'BUY' | 'SELL', price: number, extra: Body = {}): Body => ({
  symbol,
  exchange: 'NFO',
  side,
  segment: 'OPTION',
  active: true,
  price,
  ...extra,
})

/**
 * A fake server: the candles of each `${symbol} ${exchange}` (none for any other), or an ApiError
 * to fail that read; the reference's quote; the broker's intervals; and /symbol by symbol, a 404
 * for any other.
 */
function server(
  o: {
    history?: Record<string, readonly Candle[] | ApiError>
    ltp?: number
    symbols?: Record<string, Body>
  } = {},
) {
  const sent: { id: string; body: Body }[] = []
  const api: Pick<Api, 'call'> = {
    async call(id, body, schema) {
      sent.push({ id, body: { ...body } })
      if (id === 'intervals') {
        return schema.parse(ok({ seconds: [], minutes: ['1m', '5m'], hours: ['1h'], days: ['D'] }))
      }
      if (id === 'quotes') return schema.parse(ok({ ltp: o.ltp ?? LTP }))
      if (id === 'history') {
        const got = o.history?.[`${String(body.symbol)} ${String(body.exchange)}`] ?? []
        if (got instanceof ApiError) throw got
        return schema.parse(ok(rowsOf(got)))
      }
      if (id === 'symbol') {
        const row = o.symbols?.[String(body.symbol)]
        if (!row) {
          throw new ApiError({ kind: 'Unsupported', status: 404, endpoint: 'symbol' })
        }
        return schema.parse(ok(row))
      }
      throw new Error(`no reply for ${id} ${JSON.stringify(body)}`)
    },
  }
  const history = () => sent.filter((s) => s.id === 'history').map((s) => s.body as HistoryRequest)
  const quotes = () => sent.filter((s) => s.id === 'quotes').map((s) => s.body)
  return { api, sent, history, quotes }
}

function routes(api: Pick<Api, 'call'>, o: RouteDepsOverrides = {}) {
  const d = testRouteDeps({ api, now: () => NOW, ...o })
  const all = createDeviceRoutes(d)
  const call = (
    method: 'GET' | 'POST',
    path: string,
    extra: Body,
    signal = new AbortController().signal,
  ): Promise<DomReply> => {
    const route = all.find((r) => r.method === method && r.path === path)
    if (!route) throw new Error(`no route ${method} ${path}`)
    return route.handle({ v: 1, kind: 'request', rid: 1, method, path, ...extra }, signal)
  }
  return {
    post: (path: string, body: unknown, signal?: AbortSignal) =>
      call('POST', path, { body: body as JSONValue }, signal),
    get: (path: string, query: Record<string, string>) => call('GET', path, { query }),
  }
}

const error = (status: number, message: string) => ({ status, body: { status: 'error', message } })
const dataOf = (reply: DomReply) => (reply.body as { data: Record<string, unknown> }).data

/** Two candles a day, Wed 25 to Fri 27 Nov. */
const T = [
  istSec('2026-11-25', '09:15'),
  istSec('2026-11-25', '09:20'),
  istSec('2026-11-26', '09:15'),
  istSec('2026-11-26', '09:20'),
  istSec('2026-11-27', '09:15'),
  istSec('2026-11-27', '09:20'),
] as const
const at = (i: number) => T[i] as number
const REF: Candle[] = T.map((t, i) => ({ t, close: 24_000.125 + i * 10 }))
const closeOf = (symbol: string, t: number) =>
  (symbol === PE ? 95.111 : symbol === CE2 ? 60.337 : 110.229) + ((t / 300) % 7) * 1.05

const BODY = { underlying: 'NIFTY', exchange: 'NFO' }
const legsAt = (symbols: readonly string[], times: readonly number[] = T) =>
  Object.fromEntries(
    symbols.map((s) => [`${s} NFO`, times.map((t) => ({ t, close: closeOf(s, t) }))]),
  )

beforeEach(() => keepExpectedLogs())
afterEach(() => jest.restoreAllMocks())

test('one history per unique active option leg plus the reference; FUTURE and inactive legs are skipped', async () => {
  // PE has no candle at 09:15 on the 26th: that candle is not charted
  const history = {
    'NIFTY NSE_INDEX': REF,
    ...legsAt([CE]),
    [`${PE} NFO`]: T.filter((t) => t !== at(2)).map((t) => ({ t, close: closeOf(PE, t) })),
    ...legsAt([CE2, FUT]),
  }
  const s = server({ history })
  const legs = [
    leg(CE, 'SELL', 120.5, { strike: 24_000, optionType: 'CE', expiry: '01DEC26' }),
    leg(FUT, 'BUY', 24_150, { segment: 'FUTURE' }),
    leg(PE, 'SELL', 110.25),
    leg(CE2, 'BUY', 80, { active: false }),
    // a second leg on the same contract: one read, and both legs count
    leg(CE, 'BUY', 121),
  ]
  const reply = await routes(s.api).post(CHART, { ...BODY, legs })

  // the reference first, then each contract once, in leg order, over the 3-day trading window
  expect(s.history()).toEqual(
    [
      ['NIFTY', 'NSE_INDEX'],
      [CE, 'NFO'],
      [PE, 'NFO'],
    ].map(([symbol, exchange]) => ({
      symbol,
      exchange,
      interval: '5m',
      start_date: '2026-11-16',
      end_date: '2026-11-27',
    })),
  )
  const net = (t: number) => 0 + closeOf(CE, t) + closeOf(PE, t) + -1 * closeOf(CE, t)
  expect(reply).toEqual({
    status: 200,
    body: {
      status: 'success',
      data: {
        underlying: 'NIFTY',
        underlying_ltp: LTP,
        interval: '5m',
        tag: 'credit',
        entry_net_premium: 109.75,
        entry_abs_premium: 109.75,
        legs_used: 3,
        underlying_available: true,
        series: [0, 1, 3, 4, 5].map((i) => ({
          time: at(i),
          net_premium: r2(net(at(i))),
          combined_premium: r2(Math.abs(net(at(i)))),
          underlying: r2((REF[i] as Candle).close),
        })),
      },
    },
  })
  expect(s.quotes()).toEqual([{ symbol: 'NIFTY', exchange: 'NSE_INDEX' }])
})

test('no reference history: the series comes from the legs and underlying_available is false', async () => {
  // the legs' candles out of order; PE lacks the first, CE the last: the common times, ascending
  const history = {
    [`${CE} NFO`]: [at(3), at(1), at(0), at(2)].map((t) => ({ t, close: closeOf(CE, t), oi: 5 })),
    [`${PE} NFO`]: [at(1), at(3), at(4), at(2)].map((t) => ({ t, close: closeOf(PE, t), oi: 7 })),
  }
  const legs = [leg(CE, 'SELL', 100), leg(PE, 'BUY', 90)]
  const net = (t: number) => 0 + closeOf(CE, t) + -1 * closeOf(PE, t)
  const series = [1, 2, 3].map((i) => ({
    time: at(i),
    net_premium: r2(net(at(i))),
    combined_premium: r2(Math.abs(net(at(i)))),
  }))

  for (const ref of [failed('history'), []]) {
    const s = server({ history: { ...history, 'NIFTY NSE_INDEX': ref } })
    const chart = await routes(s.api).post(CHART, { ...BODY, legs })
    expect(chart.status).toBe(200)
    expect(dataOf(chart)).toMatchObject({ underlying_available: false, tag: 'credit', series })

    const oi = await routes(s.api).post(OI, { ...BODY, legs })
    expect(oi.status).toBe(200)
    expect(dataOf(oi)).toMatchObject({ underlying_available: false, underlying_series: [] })
    expect((dataOf(oi).legs as { has_oi: boolean }[]).map((l) => l.has_oi)).toEqual([true, true])
  }

  // no candle every leg has: the service's 404
  const none = server({ history: { [`${CE} NFO`]: history[`${CE} NFO`] } })
  expect(await routes(none.api).post(CHART, { ...BODY, legs })).toEqual(
    error(
      404,
      'No overlapping history across legs — option data may be unavailable for the selected range',
    ),
  )
})

test('an explicit window is served as asked and not capped; an inverted or 401-day window is a 400 with the server message', async () => {
  const s = server({ history: { 'NIFTY NSE_INDEX': REF, ...legsAt([CE]) } })
  const r = routes(s.api)
  const legs = [leg(CE, 'SELL', 100)]
  const timesOf = (reply: DomReply) =>
    (dataOf(reply).series as { time: number }[]).map((p) => p.time)

  // days 1 keeps the last date of the trading window
  const capped = await r.post(CHART, { ...BODY, legs, days: 1 })
  expect(timesOf(capped)).toEqual([at(4), at(5)])
  expect(s.history()[0]).toMatchObject({ start_date: '2026-11-22', end_date: '2026-11-27' })

  // an explicit window: every date it has, whatever `days` says
  s.sent.length = 0
  const window = { start_date: ' 2026-10-01 ', end_date: '2026-11-27' }
  const paged = await r.post(CHART, { ...BODY, legs, days: 1, ...window })
  expect(timesOf(paged)).toEqual([...T])
  expect(s.history().map((h) => [h.start_date, h.end_date])).toEqual([
    ['2026-10-01', '2026-11-27'],
    ['2026-10-01', '2026-11-27'],
  ])
  const oi = dataOf(await r.post(OI, { ...BODY, legs, days: 1, ...window }))
  expect((oi.underlying_series as unknown[]).length).toBe(6)
  expect((oi.legs as { series: unknown[] }[])[0]?.series.length).toBe(6)

  // a start alone runs to today; an end alone is no window
  s.sent.length = 0
  await r.post(CHART, { ...BODY, legs, start_date: '2026-11-01' })
  await r.post(CHART, { ...BODY, legs, end_date: '2026-11-01' })
  expect(s.history().map((h) => [h.start_date, h.end_date])).toEqual([
    ['2026-11-01', '2026-11-27'],
    ['2026-11-01', '2026-11-27'],
    ['2026-11-16', '2026-11-27'],
    ['2026-11-16', '2026-11-27'],
  ])

  // refused before any read, by both routes
  s.sent.length = 0
  for (const path of [CHART, OI]) {
    expect(
      await r.post(path, { ...BODY, legs, start_date: '2026-10-20', end_date: '2026-10-01' }),
    ).toEqual(error(400, 'end_date cannot be earlier than start_date'))
    expect(
      await r.post(path, { ...BODY, legs, start_date: '2025-01-01', end_date: '2026-02-06' }),
    ).toEqual(error(400, 'the window cannot be wider than 400 days'))
  }
  expect(s.sent).toEqual([])
})

test("explicitWindow is _resolve_explicit_window: strptime's YYYY-MM-DD, from 2000, at most 400 days", () => {
  const refused = (start: string | undefined, end: string | undefined) => {
    try {
      explicitWindow(start, end, NOW)
    } catch (e) {
      if (e instanceof RouteError) return [e.status, e.body.message]
      throw e
    }
    throw new Error('not refused')
  }
  expect(explicitWindow(undefined, '2026-11-01', NOW)).toBeNull()
  expect(explicitWindow('2025-01-01', '2026-02-05', NOW)).toEqual({
    start_date: '2025-01-01',
    end_date: '2026-02-05',
  })
  // strptime takes one-digit months and days; the window is written back zero-padded
  expect(explicitWindow('2026-1-5', '2026-1-31', NOW)).toEqual({
    start_date: '2026-01-05',
    end_date: '2026-01-31',
  })
  // the future is allowed
  expect(explicitWindow('2026-11-27', '2026-12-31', NOW)?.end_date).toBe('2026-12-31')

  const FORM = 'must be a date in YYYY-MM-DD form'
  expect(refused('2026-02-30', undefined)).toEqual([400, `start_date ${FORM}`])
  expect(refused('27-11-2026', undefined)).toEqual([400, `start_date ${FORM}`])
  expect(refused('2026-11-01', '2026-13-01')).toEqual([400, `end_date ${FORM}`])
  expect(refused('0000-01-01', undefined)).toEqual([400, `start_date ${FORM}`])
  // the start is read first
  expect(refused('2026-11-1x', '2026-13-01')).toEqual([400, `start_date ${FORM}`])
  expect(refused('1999-12-31', '2000-01-05')).toEqual([
    400,
    'start_date cannot be earlier than 2000-01-01',
  ])
  expect(refused('2026-11-02', '2026-11-01')).toEqual([
    400,
    'end_date cannot be earlier than start_date',
  ])
  // no end: today, IST
  expect(refused('2025-10-22', undefined)).toEqual([
    400,
    'the window cannot be wider than 400 days',
  ])
  expect(explicitWindow('2025-10-23', undefined, NOW)?.end_date).toBe('2026-11-27')
})

test('2.0.0.0 without underlying_symbol: NIFTY reads NSE_INDEX, CRUDEOIL its near FUT (RF 4)', async () => {
  const crude = 'CRUDEOIL18DEC26FUT'
  const option = 'CRUDEOIL16DEC266000CE'
  const history = {
    'NIFTY NSE_INDEX': REF,
    ...legsAt([CE]),
    [`${crude} MCX`]: REF,
    [`${option} MCX`]: T.map((t) => ({ t, close: 150.5 })),
  }
  const expiries = jest.fn(async (exchange: string, underlying: string, type: string) =>
    exchange === 'MCX' && underlying === 'CRUDEOIL' && type === 'futures'
      ? ['18-DEC-26', '19-JAN-27']
      : [],
  )
  const ref = (s: ReturnType<typeof server>) => [s.history()[0], s.quotes()]

  const nifty = server({ history })
  const n = await routes(nifty.api).post(CHART, { ...BODY, legs: [leg(CE, 'SELL', 100)] })
  expect(dataOf(n).underlying_available).toBe(true)
  expect(ref(nifty)).toEqual([
    expect.objectContaining({ symbol: 'NIFTY', exchange: 'NSE_INDEX' }),
    [{ symbol: 'NIFTY', exchange: 'NSE_INDEX' }],
  ])

  const mcx = { underlying: 'CRUDEOIL', exchange: 'MCX' }
  const crudeLegs = [{ ...leg(option, 'SELL', 150), exchange: 'MCX' }]
  for (const path of [CHART, OI]) {
    const s = server({ history })
    const reply = await routes(s.api, { options: { expiries } }).post(path, {
      ...mcx,
      legs: crudeLegs,
    })
    expect([path, reply.status, dataOf(reply).underlying_available]).toEqual([path, 200, true])
    expect(ref(s)).toEqual([
      expect.objectContaining({ symbol: crude, exchange: 'MCX' }),
      [{ symbol: crude, exchange: 'MCX' }],
    ])
  }

  // 2.0.2.0: the chain's own pair wins, and no expiry is read
  expiries.mockClear()
  const given = server({ history })
  await routes(given.api, { options: { expiries } }).post(CHART, {
    ...mcx,
    underlying_symbol: crude.toLowerCase(),
    underlying_exchange: ' mcx ',
    legs: crudeLegs,
  })
  expect(expiries).not.toHaveBeenCalled()
  expect(ref(given)[1]).toEqual([{ symbol: crude, exchange: 'MCX' }])

  // no future listed: the service's 404, before any history
  const none = server({ history })
  const empty = routes(none.api, { options: { expiries: async () => [] } })
  for (const path of [CHART, OI]) {
    expect(await empty.post(path, { ...mcx, exchange: 'mcx', legs: crudeLegs })).toEqual(
      error(404, 'No unexpired futures found for CRUDEOIL on MCX'),
    )
  }
  expect(none.sent).toEqual([])
})

test('entry_net uses Python sum; the tag is credit, debit or flat', async () => {
  const A = 'NIFTY01DEC2623000CE'
  const B = 'NIFTY01DEC2623100CE'
  const C = 'NIFTY01DEC2623200CE'
  const s = server({ history: { 'NIFTY NSE_INDEX': REF, ...legsAt([A, B, C]) } })
  const r = routes(s.api)
  const entry = async (legs: Body[]) => {
    const d = dataOf(await r.post(CHART, { ...BODY, legs }))
    return [d.tag, d.entry_net_premium, d.entry_abs_premium]
  }
  // 1e16 + 1 − 1e16 is 0 added left to right, but 1 as sum() adds it
  expect(0 + 1e16 + 1 - 1e16).toBe(0)
  expect(await entry([leg(A, 'SELL', 1e16), leg(B, 'SELL', 1), leg(C, 'BUY', 1e16)])).toEqual([
    'credit',
    1,
    1,
  ])
  expect(await entry([leg(A, 'BUY', 50.125)])).toEqual(['debit', -50.12, 50.12])
  expect(await entry([leg(A, 'SELL', 75.5), leg(B, 'BUY', 75.5)])).toEqual(['flat', 0, 0])
  // price is float(price or 0), 0 for what float() refuses
  expect(
    await entry([
      leg(A, 'SELL', ' 12.5 ' as never),
      leg(B, 'SELL', 'abc' as never),
      leg(C, 'BUY', null as never),
    ]),
  ).toEqual(['credit', 12.5, 12.5])
})

test('multi-strike OI: an all-zero leg has has_oi false', async () => {
  const history = {
    'NIFTY NSE_INDEX': REF,
    [`${CE} NFO`]: T.map((t, i) => ({ t, close: 1, oi: 1_000.125 + i * 100.333 })),
    // no OI at all: the history service's 0
    [`${PE} NFO`]: T.map((t) => ({ t, close: 1 })),
    // OI only on the 26th, which the cap drops: has_oi is read before the cap
    [`${CE2} NFO`]: T.map((t, i) => ({ t, close: 1, oi: i === 2 || i === 3 ? 50 : 0 })),
  }
  const s = server({ history })
  const legs = [
    leg(CE, 'SELL', 100, { strike: 24_000, optionType: 'CE', expiry: '01DEC26', lots: 2 }),
    leg(FUT, 'BUY', 24_150, { segment: 'FUTURE' }),
    leg(PE, 'BUY', 90),
    leg(CE2, 'SELL', 60, { strike: 24_100, optionType: 'CE', expiry: '01DEC26' }),
    leg(CE, 'SELL', 100, { active: false }),
  ]
  const reply = await routes(s.api).post(OI, { ...BODY, legs, days: 1 })

  const last = [4, 5]
  expect(reply).toEqual({
    status: 200,
    body: {
      status: 'success',
      data: {
        underlying: 'NIFTY',
        underlying_ltp: LTP,
        interval: '5m',
        underlying_available: true,
        underlying_series: last.map((i) => ({ time: at(i), value: r2((REF[i] as Candle).close) })),
        // the page's order, its strike, optionType and expiry as sent (null when not sent)
        legs: [
          {
            symbol: CE,
            exchange: 'NFO',
            side: 'SELL',
            strike: 24_000,
            option_type: 'CE',
            expiry: '01DEC26',
            has_oi: true,
            series: last.map((i) => ({ time: at(i), value: r2(1_000.125 + i * 100.333) })),
          },
          {
            symbol: PE,
            exchange: 'NFO',
            side: 'BUY',
            strike: null,
            option_type: null,
            expiry: null,
            has_oi: false,
            series: last.map((i) => ({ time: at(i), value: 0 })),
          },
          {
            symbol: CE2,
            exchange: 'NFO',
            side: 'SELL',
            strike: 24_100,
            option_type: 'CE',
            expiry: '01DEC26',
            has_oi: true,
            series: last.map((i) => ({ time: at(i), value: 0 })),
          },
        ],
      },
    },
  })
  expect(s.history().map((h) => h.symbol)).toEqual(['NIFTY', CE, PE, CE2])
})

test('the bodies are refused as strategy_chart.py and _normalize_leg refuse them', async () => {
  const s = server({ history: { 'NIFTY NSE_INDEX': REF, ...legsAt([CE]) } })
  const r = routes(s.api)
  const legs = [leg(CE, 'SELL', 100)]
  const PAIR = 'underlying and exchange are required'
  const LEGS = 'At least one leg is required'
  const cases: [string, unknown, number, string][] = [
    ['no body', undefined, 400, PAIR],
    ['a blank underlying', { underlying: '  ', exchange: 'NFO', legs }, 400, PAIR],
    ['a null exchange', { underlying: 'NIFTY', exchange: null, legs }, 400, PAIR],
    ['no legs', BODY, 400, LEGS],
    ['an empty list', { ...BODY, legs: [] }, 400, LEGS],
    ['legs that are not a list', { ...BODY, legs: 'abc' }, 400, LEGS],
    [
      '31 legs',
      { ...BODY, legs: Array(31).fill(legs[0]) },
      400,
      'A strategy cannot have more than 30 legs',
    ],
    [
      'a 65-character symbol',
      { ...BODY, legs: [leg('N'.repeat(65), 'SELL', 1)] },
      400,
      "A leg's symbol cannot be longer than 64 characters",
    ],
    [
      'no active option leg',
      {
        ...BODY,
        legs: [
          leg(FUT, 'BUY', 1, { segment: 'FUTURE' }),
          leg(CE, 'SELL', 1, { active: false }),
          // side is upper-cased, never trimmed
          { ...leg(CE, 'SELL', 1), side: ' SELL' },
          leg(CE, 'SELL', 1, { exchange: ' ' }),
          leg('  ', 'SELL', 1),
          'NIFTY',
          null,
        ],
      },
      400,
      'No active option legs provided',
    ],
    ['an underlying that is not a string', { ...BODY, underlying: 5, legs }, 500, FAILED_COPY],
    [
      'a segment that is not a string',
      { ...BODY, legs: [{ ...legs[0], segment: 1 }] },
      500,
      FAILED_COPY,
    ],
  ]
  for (const path of [CHART, OI]) {
    for (const [name, body, status, message] of cases) {
      expect([path, name, await r.post(path, body)]).toEqual([path, name, error(status, message)])
    }
  }
  expect(s.sent).toEqual([])

  // an inactive leg is dropped before its fields are read; segment defaults to OPTION, any case
  const kept = await r.post(CHART, {
    ...BODY,
    legs: [{ ...legs[0], segment: undefined }, leg(CE, 'SELL', 1, { active: false, segment: 1 })],
  })
  expect([kept.status, dataOf(kept).legs_used]).toEqual([200, 1])
  const lower = await r.post(CHART, { ...BODY, legs: [{ ...legs[0], segment: 'option' }] })
  expect(dataOf(lower).legs_used).toBe(1)

  // interval '5m' and days 3 unless sent; days kept within 1..30, 3 for what int() refuses
  s.sent.length = 0
  await r.post(CHART, { ...BODY, legs, interval: '', days: 'x' })
  await r.post(CHART, { ...BODY, legs, interval: ' 1m ', days: 99 })
  await r.post(CHART, { ...BODY, legs, days: -4 })
  expect(
    s
      .history()
      .filter((h) => h.symbol === 'NIFTY')
      .map((h) => [h.interval, h.start_date]),
  ).toEqual([
    ['5m', '2026-11-16'],
    ['1m', '2026-08-27'],
    ['5m', '2026-11-22'],
  ])
})

test('a hidden screen starts no history read until it is shown; an aborted request answers nothing', async () => {
  const s = server({ history: { 'NIFTY NSE_INDEX': REF, ...legsAt([CE]) } })
  let shown = false
  const waiting: (() => void)[] = []
  const r = routes(s.api, {
    active: () => shown,
    untilActive: () => new Promise<void>((resolve) => waiting.push(resolve)),
  })
  const pending = r.post(CHART, { ...BODY, legs: [leg(CE, 'SELL', 100)] })
  await new Promise((resolve) => setImmediate(resolve))
  expect(s.history()).toEqual([])
  shown = true
  for (const show of waiting) show()
  expect((await pending).status).toBe(200)
  expect(s.history().length).toBe(2)

  const abort = new AbortController()
  const gone = routes(s.api).post(OI, { ...BODY, legs: [leg(CE, 'SELL', 100)] }, abort.signal)
  abort.abort()
  await expect(gone).rejects.toMatchObject({ name: 'AbortError' })
})

test('GET /strategybuilder/api/intervals is the broker intervals body as it is', async () => {
  const s = server()
  expect(await routes(s.api).get('/strategybuilder/api/intervals', {})).toEqual({
    status: 200,
    body: ok({ seconds: [], minutes: ['1m', '5m'], hours: ['1h'], days: ['D'] }),
  })
})

describe('futures', () => {
  const row = (symbol: string, expiry: string, extra: Partial<MasterRow> = {}): MasterRow => ({
    symbol,
    name: 'NIFTY',
    exchange: 'NFO',
    expiry,
    strike: 0,
    lotsize: 65,
    tick: 0.1,
    itype: 'FUT',
    underlying: 'NIFTY',
    ...extra,
  })

  test('futures: master rows by expiry; BSE is a 400; no master costs ≤ 4 calls', async () => {
    const rows = [
      row('NIFTY26JAN27FUT', '26-JAN-27'),
      row('BANKNIFTY29DEC26FUT', '29-DEC-26', { name: 'BANKNIFTY', lotsize: 30 }),
      row('NIFTY29DEC26FUT', '29-DEC-26'),
      row('NIFTYNXT5029DEC26FUT', '29-DEC-26', { name: 'NIFTYNXT50' }),
      row('NIFTY23FEB27FUT', '23-FEB-27', { lotsize: 75, tick: 0.05 }),
      // a row the server's instrumenttype == 'FUT' leaves out
      row('NIFTY30MAR27FUT', '30-MAR-27', { itype: 'FUTIDX' }),
    ]
    const futures = jest.fn(async (exchange: string) => (exchange === 'NFO' ? rows : []))
    const s = server()
    const r = routes(s.api, { master: { futures } })

    expect(await r.get(FUTURES, { underlying: ' nifty ', exchange: 'nfo' })).toEqual({
      status: 200,
      body: {
        status: 'success',
        data: [
          { symbol: 'NIFTY29DEC26FUT', expiry: '29-DEC-26', lotsize: 65, tick_size: 0.1 },
          { symbol: 'NIFTY26JAN27FUT', expiry: '26-JAN-27', lotsize: 65, tick_size: 0.1 },
          { symbol: 'NIFTY23FEB27FUT', expiry: '23-FEB-27', lotsize: 75, tick_size: 0.05 },
        ],
      },
    })
    expect(futures).toHaveBeenCalledWith('NFO')

    expect(await r.get(FUTURES, { underlying: 'RELIANCE', exchange: 'BSE' })).toEqual(
      error(400, 'Invalid exchange: BSE'),
    )
    expect(await r.get(FUTURES, { underlying: 'NIFTY' })).toEqual(error(400, 'Invalid exchange: '))
    expect(await r.get(FUTURES, { exchange: 'NFO' })).toEqual(error(400, 'underlying is required'))
    expect(s.sent).toEqual([])

    // no master: /expiry's futures, then /symbol for the nearest three, a 404 left out
    const expiries = jest.fn(async () => ['29-DEC-26', '26-JAN-27', '23-FEB-27', '30-MAR-27'])
    const fallback = server({
      symbols: {
        NIFTY29DEC26FUT: {
          symbol: 'NIFTY29DEC26FUT',
          exchange: 'NFO',
          expiry: '29-DEC-26',
          lotsize: 65,
          tick_size: 0.1,
        },
        NIFTY23FEB27FUT: {
          symbol: 'NIFTY23FEB27FUT',
          exchange: 'NFO',
          expiry: '23-FEB-27',
          lotsize: 65,
        },
        NIFTY30MAR27FUT: {
          symbol: 'NIFTY30MAR27FUT',
          exchange: 'NFO',
          expiry: '30-MAR-27',
          lotsize: 65,
          tick_size: 0.1,
        },
      },
    })
    const none = routes(fallback.api, { options: { expiries } })
    expect(await none.get(FUTURES, { underlying: 'NIFTY', exchange: 'NFO' })).toEqual({
      status: 200,
      body: {
        status: 'success',
        data: [
          { symbol: 'NIFTY29DEC26FUT', expiry: '29-DEC-26', lotsize: 65, tick_size: 0.1 },
          { symbol: 'NIFTY23FEB27FUT', expiry: '23-FEB-27', lotsize: 65, tick_size: null },
        ],
      },
    })
    expect(expiries).toHaveBeenCalledWith('NFO', 'NIFTY', 'futures')
    expect(expiries.mock.calls.length + fallback.sent.length).toBeLessThanOrEqual(4)
    expect(fallback.sent.map((x) => x.body)).toEqual(
      ['NIFTY29DEC26FUT', 'NIFTY26JAN27FUT', 'NIFTY23FEB27FUT'].map((symbol) => ({
        symbol,
        exchange: 'NFO',
      })),
    )

    // any other failed read is the route's error reply
    const down = routes(
      {
        call: async () => {
          throw new ApiError({ kind: 'Server', status: 500, endpoint: 'symbol' })
        },
      },
      { options: { expiries } },
    )
    expect((await down.get(FUTURES, { underlying: 'NIFTY', exchange: 'NFO' })).status).toBe(502)
  })
})
