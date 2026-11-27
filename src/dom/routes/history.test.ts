// The Option Greeks and OI Profile routes on the phone: their history reads through the history
// lane, OI Profile's early answer and the previous-day OI it loads on into its cache (RF 3), and
// the per-candle IV and Greeks (the golden test holds their figures to the server's Python).
import { QueryClient } from '@tanstack/react-query'
import { profileStorage } from '~/core/config/storage'
import { createApi, type FieldGate } from '~/core/http/api'
import type { HttpClient } from '~/core/http/client'
import { ApiError } from '~/core/http/errors'
import { createScheduler } from '~/core/http/scheduler'
import { createServerClock } from '~/core/http/serverClock'
import type { DomReply, JSONValue } from '~/dom/bridge/protocol'
import type { ToolProgress } from '~/dom/routes/deps'
import { createPrevOiCache } from '~/market/history/prevOi'
import { rawGreeks, rawIvAny } from '~/market/options/black76'
import { createOptionsData } from '~/market/options/data'
import { pyRound } from '~/market/options/pyRound'
import { chainReply } from '../../../test/helpers/chains'
import { keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { testRouteDeps } from '../../../test/helpers/routeDeps'
import { createDeviceRoutes, OI_BACKGROUND_MS, OI_FIRST_ANSWER_MS, oiPartialNote } from './index'

const IST_OFFSET_MS = 330 * 60_000
/** An IST wall time on a date, epoch seconds. */
const istSec = (iso: string, hhmm: string) =>
  (Date.parse(`${iso}T${hhmm}:00Z`) - IST_OFFSET_MS) / 1000

// Wed 25 Nov 2026, 10:30 IST
const NOW = istSec('2026-11-25', '10:30') * 1000
const EXPIRY = '01DEC26'
const SPOT = 24000
const FUTURES = ['29-DEC-26', '26-JAN-27', '23-FEB-27']
const PROFILE = '/oiprofile/api/profile-data'
const IV = '/ivchart/api/iv-data'
const QUERY = { underlying: 'NIFTY', exchange: 'NFO', expiry_date: EXPIRY }
/** Every leg's OI on Tuesday 24 Nov, the daily candles' data[-2]. */
const PREV_OI = 20_000
const READ_MS = 1_000
const PASS_THROUGH: FieldGate = { adapt: (_id, body) => body, markUnsupported: () => {} }

type Body = Record<string, unknown>
/** What the fake server answers: a reply body, or an ApiError to fail with. */
type Answer = (id: string, body: Body) => unknown

/** The FUT's 5m candles, 09:15 to 15:25 on each of the last 5 sessions and to 10:25 today. */
function futCandles(): Body[] {
  const dates = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24']
  const at = (sec: number, i: number) => ({
    timestamp: sec,
    open: 24_100 + i,
    high: 24_110 + i,
    low: 24_090 + i,
    close: 24_105 + i,
    volume: 1_000,
    oi: 500_000,
  })
  const past = dates.flatMap((iso) =>
    Array.from({ length: 75 }, (_, i) => at(istSec(iso, '09:15') + i * 300, i)),
  )
  const today = Array.from({ length: 15 }, (_, i) => at(istSec('2026-11-25', '09:15') + i * 300, i))
  return [...past, ...today]
}

/** A leg's daily candles to today, the last still forming: data[-2] is Tuesday's. */
const dailyRows = (prevOi = PREV_OI) =>
  ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25'].map((iso, i) => ({
    timestamp: istSec(iso, '00:00'),
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 5_000,
    oi: iso === '2026-11-24' ? prevOi : 10_000 + i,
  }))

const ok = (data: unknown) => ({ status: 'success', data })

/** The default server: the chain at 24,000, the FUT list, the FUT's candles and daily legs. */
const serve: Answer = (id, body) => {
  if (id === 'optionchain') {
    return chainReply({
      expiry: String(body.expiry_date),
      spot: SPOT,
      each: Number(body.strike_count),
      serverTs: Math.floor(Date.now() / 1000),
    })
  }
  if (id === 'expiry') return ok(FUTURES)
  if (id === 'intervals') return ok({ seconds: [], minutes: ['1m', '5m', '15m'], hours: ['1h'] })
  if (id === 'history' && String(body.symbol).endsWith('FUT')) return ok(futCandles())
  if (id === 'history' && body.interval === 'D') return ok(dailyRows())
  throw new Error(`no reply for ${id} ${JSON.stringify(body)}`)
}

/**
 * The real api and scheduler (the history lane: 3 in flight, 3 a second) over a server whose
 * history replies take a second and any other 50 ms; the screen shown until the test hides it.
 */
function setup(o: { answer?: Answer; storage?: ReturnType<typeof profileStorage> } = {}) {
  const answer = o.answer ?? serve
  const sent: Body[] = []
  let historyOut = 0
  let mostHistoryOut = 0
  const http: Pick<HttpClient, 'request'> = {
    request: (id, body, schema, opt) =>
      new Promise((resolve, reject) => {
        sent.push({ id, ...body })
        const history = id === 'history'
        if (history) mostHistoryOut = Math.max(mostHistoryOut, ++historyOut)
        const timer = setTimeout(
          () => {
            if (history) historyOut--
            try {
              const r = answer(id, body)
              if (r instanceof Error) reject(r)
              else resolve(schema.parse(r))
            } catch (e) {
              reject(e)
            }
          },
          history ? READ_MS : 50,
        )
        opt?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          if (history) historyOut--
          reject(new ApiError({ kind: 'Network', status: 0, endpoint: id }))
        })
      }),
  }
  const api = createApi({ http, scheduler: createScheduler(), fields: PASS_THROUGH })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const clock = createServerClock(() => Date.now())
  const options = createOptionsData({ api, queryClient, pid: 'p1', clock })
  const storage = o.storage ?? profileStorage(memoryKV(), 'p1')
  const prevOi = createPrevOiCache(storage)
  const progressed: ToolProgress[] = []
  const screen = { active: true, waiting: [] as (() => void)[] }

  /** One tool screen: its lifetime, and its device routes. */
  function open() {
    const lifetime = new AbortController()
    const deps = testRouteDeps({
      options,
      api,
      now: clock.now,
      lifetime: lifetime.signal,
      progress: (p) => progressed.push(p),
      active: () => screen.active,
      untilActive: (signal) =>
        screen.active
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
              screen.waiting.push(resolve)
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            }),
      prevOi,
    })
    const routes = createDeviceRoutes(deps)
    let rid = 0
    const post = (path: string, body: JSONValue): Promise<DomReply> => {
      const route = routes.find((r) => r.method === 'POST' && r.path === path)
      if (!route) throw new Error(`no route ${path}`)
      return route.handle(
        { v: 1, kind: 'request', rid: ++rid, method: 'POST', path, body },
        new AbortController().signal,
      )
    }
    return { post, close: () => lifetime.abort() }
  }

  return {
    sent,
    open,
    storage,
    prevOi,
    progressed,
    mostHistoryOut: () => mostHistoryOut,
    hide: () => {
      screen.active = false
    },
    show: () => {
      screen.active = true
      for (const w of screen.waiting) w()
      screen.waiting = []
    },
  }
}

const daily = (sent: Body[]) => sent.filter((b) => b.id === 'history' && b.interval === 'D')
const symbolsOf = (bodies: Body[]) => bodies.map((b) => String(b.symbol))

type OiRow = {
  strike: number
  ce_oi: number
  pe_oi: number
  ce_oi_change: number
  pe_oi_change: number
}
type Profile = {
  status: string
  message?: string
  oi_change_loaded?: number
  oi_change_requested?: number
  futures_symbol: string | null
  lot_size: number
  candles: { time: number; timestamp: number }[]
  oi_chain: OiRow[]
}
const profileOf = (r: DomReply) => r.body as unknown as Profile

/** The legs whose change shows (OI less the previous day's), and those at 0. */
function changes(p: Profile) {
  const shown = p.oi_chain.flatMap((row) => [
    row.ce_oi_change === row.ce_oi - PREV_OI ? 1 : 0,
    row.pe_oi_change === row.pe_oi - PREV_OI ? 1 : 0,
  ])
  const zero = p.oi_chain.flatMap((row) => [row.ce_oi_change === 0, row.pe_oi_change === 0])
  return { shown: shown.filter(Boolean).length, zero: zero.filter(Boolean).length }
}

/** Waits for `p` while the clock runs, a step at a time; the device ms it settled at. */
async function settle<T>(p: Promise<T>, maxMs = 120_000): Promise<{ value: T; at: number }> {
  let out: { value: T; at: number } | undefined
  void p.then((value) => {
    out = { value, at: Date.now() }
  })
  for (let t = 0; t < maxMs && out === undefined; t += 100) await jest.advanceTimersByTimeAsync(100)
  if (out === undefined) throw new Error('still waiting')
  return out
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW })
  keepExpectedLogs()
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('OI Profile', () => {
  const BODY = { ...QUERY, interval: '5m', days: 5 }

  test('first load: chain 20, futures expiry, FUT history, 82 daily reads with ≤ 3 in flight; progress ends 82 of 82', async () => {
    const h = setup()
    const { value: r } = await settle(h.open().post(PROFILE, BODY))
    expect(r.status).toBe(200)
    await jest.advanceTimersByTimeAsync(60_000)

    const [chain, expiry, fut, ...rest] = h.sent
    expect(chain).toEqual({ id: 'optionchain', ...QUERY, strike_count: 20 })
    expect(expiry).toEqual({
      id: 'expiry',
      symbol: 'NIFTY',
      exchange: 'NFO',
      instrumenttype: 'futures',
    })
    // the nearest FUT (none expires on 01 Dec) at 5m over 5·3 + 2 calendar days to today
    expect(fut).toEqual({
      id: 'history',
      symbol: 'NIFTY29DEC26FUT',
      exchange: 'NFO',
      interval: '5m',
      start_date: '2026-11-08',
      end_date: '2026-11-25',
    })
    expect(rest).toHaveLength(82)
    expect(new Set(symbolsOf(rest)).size).toBe(82)
    for (const b of rest) {
      expect(b).toMatchObject({
        id: 'history',
        exchange: 'NFO',
        interval: 'D',
        start_date: '2026-11-11',
        end_date: '2026-11-25',
      })
    }
    expect(h.mostHistoryOut()).toBe(3)
    expect(h.progressed.every((p) => p.label === 'Previous-day OI' && p.total === 82)).toBe(true)
    expect(h.progressed.at(-1)).toEqual({ label: 'Previous-day OI', done: 82, total: 82 })
    // every leg is cached under its data[-2] date
    expect(await h.prevOi.get('NFO', 'NIFTY01DEC2624000CE', '2026-11-24')).toBe(PREV_OI)
  })

  test('at 8 s the page gets candles, current OI and the note; the rest load on; Refresh then costs 2 calls (RF 3)', async () => {
    const h = setup()
    const page = h.open()
    const started = Date.now()
    const { value: r, at } = await settle(page.post(PROFILE, BODY))
    // the chain and the FUT come first; the daily reads then get 8 s
    expect(at - started).toBeGreaterThanOrEqual(OI_FIRST_ANSWER_MS)
    expect(at - started).toBeLessThan(OI_FIRST_ANSWER_MS + 2_000)

    const p = profileOf(r)
    expect(r.status).toBe(200)
    expect(p.futures_symbol).toBe('NIFTY29DEC26FUT')
    expect(p.lot_size).toBe(75)
    // the last 5 dates' candles (18 Nov's are cut), each with its time in seconds
    expect(p.candles).toHaveLength(4 * 75 + 15)
    expect(p.candles[0]?.time).toBe(istSec('2026-11-19', '09:15'))
    expect(p.candles.every((c) => c.time === c.timestamp)).toBe(true)
    expect(p.oi_chain).toHaveLength(41)
    expect(p.oi_chain.every((row) => row.ce_oi > 0 && row.pe_oi > 0)).toBe(true)
    const loaded = p.oi_change_loaded ?? 0
    expect(loaded).toBeGreaterThan(10)
    expect(loaded).toBeLessThan(82)
    expect(p.oi_change_requested).toBe(82)
    expect(p.message).toBe(oiPartialNote(loaded, 82))
    // the change shows for the loaded legs only
    expect(changes(p)).toEqual({ shown: loaded, zero: 82 - loaded })

    // the rest load on, into the cache
    await jest.advanceTimersByTimeAsync(60_000)
    expect(daily(h.sent)).toHaveLength(82)
    expect(h.progressed.at(-1)).toEqual({ label: 'Previous-day OI', done: 82, total: 82 })

    // Refresh: the chain and the FUT's candles; the FUT list is still fresh, every leg cached
    const before = h.sent.length
    const { value: again } = await settle(page.post(PROFILE, BODY))
    expect(h.sent.slice(before).map((b) => [b.id, b.symbol ?? b.strike_count])).toEqual([
      ['optionchain', 20],
      ['history', 'NIFTY29DEC26FUT'],
    ])
    const full = profileOf(again)
    expect(full.message).toBeUndefined()
    expect(full.oi_change_loaded).toBeUndefined()
    expect(full.oi_change_requested).toBeUndefined()
    expect(changes(full)).toEqual({ shown: 82, zero: 0 })
  })

  test('closing the tool aborts the background reads; reopening reads only the legs not cached (RF 3)', async () => {
    const h = setup()
    const first = h.open()
    const { value: r } = await settle(first.post(PROFILE, BODY))
    const loaded = profileOf(r).oi_change_loaded ?? 0
    expect(loaded).toBeGreaterThan(0)
    const progressBefore = h.progressed.length

    first.close()
    await jest.advanceTimersByTimeAsync(60_000)
    const readFirst = symbolsOf(daily(h.sent))
    // the cleared progress line is left alone
    expect(h.progressed).toHaveLength(progressBefore)
    // what was out is dropped and not cached, and nothing more goes
    const cached: string[] = []
    for (const s of readFirst) {
      if ((await h.prevOi.get('NFO', s, '2026-11-24')) !== null) cached.push(s)
    }
    expect(cached.length).toBeGreaterThanOrEqual(loaded)
    expect(readFirst.length - cached.length).toBeGreaterThanOrEqual(1)
    expect(readFirst.length - cached.length).toBeLessThanOrEqual(3)

    // the tool opened again on the same storage (a new cache over it) reads the rest only
    const before = daily(h.sent).length
    const reopened = setup({ storage: h.storage })
    const { value: again } = await settle(reopened.open().post(PROFILE, BODY))
    await jest.advanceTimersByTimeAsync(60_000)
    const readAgain = symbolsOf(daily(reopened.sent))
    expect(daily(h.sent)).toHaveLength(before)
    expect(readAgain).toHaveLength(82 - cached.length)
    expect(readAgain.filter((s) => cached.includes(s))).toEqual([])
    expect(profileOf(again).oi_change_loaded ?? 82).toBeGreaterThanOrEqual(cached.length)
  })

  test('a pushed screen pauses the daily reads; on return they resume and no leg is read twice', async () => {
    const h = setup()
    const page = h.open()
    const reply = page.post(PROFILE, BODY)
    // the daily reads are under way
    await jest.advanceTimersByTimeAsync(4_000)
    const atHide = daily(h.sent).length
    expect(atHide).toBeGreaterThan(0)
    h.hide()
    // what was out comes back; nothing new starts, for longer than the background's budget
    await jest.advanceTimersByTimeAsync(OI_BACKGROUND_MS + 20_000)
    expect(daily(h.sent)).toHaveLength(atHide)
    // the page got its early answer meanwhile
    const p = profileOf(await reply)
    expect(p.oi_change_loaded).toBe(atHide)

    h.show()
    await jest.advanceTimersByTimeAsync(60_000)
    const read = symbolsOf(daily(h.sent))
    expect(read).toHaveLength(82)
    expect(new Set(read).size).toBe(82)
    expect(h.progressed.at(-1)).toEqual({ label: 'Previous-day OI', done: 82, total: 82 })
  })

  test('another expiry while the first still reads: the progress line follows it, and the first goes on into the cache', async () => {
    const NEXT = '08DEC26'
    const h = setup({
      answer: (id, body) => {
        const r = serve(id, body)
        if (id !== 'optionchain' || body.expiry_date !== NEXT) return r
        // 08 Dec: OI only within 500 of the money, 21 strikes, 42 legs
        const chain = r as { chain: { strike: number; ce: Body; pe: Body }[] }
        for (const row of chain.chain) {
          if (Math.abs(row.strike - SPOT) > 500) {
            row.ce.oi = 0
            row.pe.oi = 0
          }
        }
        return chain
      },
    })
    const page = h.open()
    await settle(page.post(PROFILE, BODY))
    const switched = h.progressed.length
    await settle(page.post(PROFILE, { ...BODY, expiry_date: NEXT }))
    await jest.advanceTimersByTimeAsync(120_000)
    // from the second load's first report on, the line is its own
    const next = h.progressed.findIndex((p, i) => i >= switched && p.total === 42)
    expect(next).toBeGreaterThan(-1)
    expect(h.progressed.slice(next).every((p) => p.total === 42)).toBe(true)
    expect(h.progressed.at(-1)).toEqual({ label: 'Previous-day OI', done: 42, total: 42 })
    const read = symbolsOf(daily(h.sent))
    expect(read.filter((s) => s.startsWith('NIFTY01DEC26'))).toHaveLength(82)
    expect(read.filter((s) => s.startsWith(`NIFTY${NEXT}`))).toHaveLength(42)
    expect(await h.prevOi.get('NFO', 'NIFTY01DEC2625000PE', '2026-11-24')).toBe(PREV_OI)
  })

  test('the same legs again while the first load reads them: no leg is read twice', async () => {
    const h = setup()
    const page = h.open()
    await settle(page.post(PROFILE, BODY))
    // the page asks again (another interval) while the first load's reads go on
    const { value: r } = await settle(page.post(PROFILE, { ...BODY, interval: '15m' }))
    await jest.advanceTimersByTimeAsync(60_000)
    const read = symbolsOf(daily(h.sent))
    expect(read).toHaveLength(82)
    expect(new Set(read).size).toBe(82)
    expect(profileOf(r).oi_change_requested).toBe(82)
    expect(h.progressed.at(-1)).toEqual({ label: 'Previous-day OI', done: 82, total: 82 })
  })

  test('a failed daily read shows a change equal to the OI, as the server does', async () => {
    const FAILED = 'NIFTY01DEC2624000CE'
    const ONE_ROW = 'NIFTY01DEC2624000PE'
    const h = setup({
      answer: (id, body) => {
        if (id === 'history' && body.symbol === FAILED) {
          return new ApiError({
            kind: 'Validation',
            status: 400,
            endpoint: 'history',
            serverMessage: 'No data',
          })
        }
        // a contract listed yesterday: one daily candle, no previous day
        if (id === 'history' && body.symbol === ONE_ROW) return ok(dailyRows().slice(-1))
        return serve(id, body)
      },
    })
    const page = h.open()
    await settle(page.post(PROFILE, BODY))
    await jest.advanceTimersByTimeAsync(60_000)
    const { value: again } = await settle(page.post(PROFILE, BODY))
    const p = profileOf(again)
    const atm = p.oi_chain.find((row) => row.strike === 24_000)
    expect(atm?.ce_oi_change).toBe(atm?.ce_oi)
    expect(atm?.pe_oi_change).toBe(atm?.pe_oi)
    // both count as loaded, and neither is cached: a Refresh reads them again
    expect(p.message).toBeUndefined()
    expect(changes(p).shown).toBe(80)
    expect(symbolsOf(daily(h.sent)).filter((s) => s === FAILED || s === ONE_ROW)).toEqual([
      FAILED,
      ONE_ROW,
      FAILED,
      ONE_ROW,
    ])
  })

  test('a 429 is not loaded: the change leaves the leg out, the note says so, and Refresh reads it again', async () => {
    const BUSY = 'NIFTY01DEC2623000CE'
    let refusals = 2
    const h = setup({
      answer: (id, body) => {
        if (id === 'history' && body.symbol === BUSY && refusals-- > 0) {
          return new ApiError({ kind: 'RateLimited', status: 429, endpoint: 'history' })
        }
        return serve(id, body)
      },
    })
    const page = h.open()
    await settle(page.post(PROFILE, BODY))
    await jest.advanceTimersByTimeAsync(60_000)
    // every other leg is in; the refused one is not cached
    expect(daily(h.sent)).toHaveLength(82)
    expect(h.progressed.at(-1)).toEqual({ label: 'Previous-day OI', done: 81, total: 82 })
    expect(await h.prevOi.get('NFO', BUSY, '2026-11-24')).toBeNull()

    // Refresh reads it, and only it: refused again, the note says 81 of 82
    const refresh = async () => {
      const before = daily(h.sent).length
      const { value } = await settle(page.post(PROFILE, BODY))
      expect(symbolsOf(daily(h.sent).slice(before))).toEqual([BUSY])
      return profileOf(value)
    }
    const refused = await refresh()
    expect([refused.message, refused.oi_change_loaded]).toEqual([oiPartialNote(81, 82), 81])
    expect(refused.oi_chain[0]?.ce_oi_change).toBe(0)
    expect(changes(refused).shown).toBe(81)
    // the next one gets it: the change is whole
    const whole = await refresh()
    expect(whole.message).toBeUndefined()
    expect(changes(whole)).toEqual({ shown: 82, zero: 0 })
  })

  test('the route checks its body as the web route does', async () => {
    const h = setup()
    const page = h.open()
    const cases: [JSONValue, number, string][] = [
      [{ ...BODY, interval: '1h' }, 400, 'Invalid interval. Allowed: 15m, 1m, 5m'],
      [{ ...BODY, expiry_date: '' }, 400, 'underlying, exchange, and expiry_date are required'],
      [{ ...BODY, days: 'five' }, 500, 'An error occurred processing your request'],
      [{ ...BODY, interval: 5 }, 500, 'An error occurred processing your request'],
    ]
    for (const [body, status, message] of cases) {
      const r = await page.post(PROFILE, body)
      expect([r.status, r.body]).toEqual([status, { status: 'error', message }])
    }
    expect(h.sent).toEqual([])
    // ' 15m ' is trimmed; days past 30 read 30
    const { value: r } = await settle(page.post(PROFILE, { ...BODY, interval: ' 15m ', days: 99 }))
    expect(r.status).toBe(200)
    expect(h.sent[2]).toMatchObject({ interval: '15m', start_date: '2026-08-25' })
  })
})

describe('Option Greeks', () => {
  const BODY = { ...QUERY, interval: '1m', days: 1 }

  /** 1m candles of the option and the reference at the same times, with their closes. */
  const minutes = (times: readonly number[], close: (sec: number) => number) =>
    times.map((t) => ({ timestamp: t, open: 1, high: 1, low: 1, close: close(t), volume: 10 }))

  function ivServer(o: {
    times: readonly number[]
    ref?: (sec: number) => number
    ce?: (sec: number) => number
    pe?: (sec: number) => number
    chain?: Parameters<typeof chainReply>[0]
    refSymbol?: string
  }): Answer {
    return (id, body) => {
      if (id === 'optionchain') {
        return chainReply({
          expiry: String(body.expiry_date),
          spot: SPOT,
          each: Number(body.strike_count),
          serverTs: Math.floor(Date.now() / 1000),
          ...o.chain,
        })
      }
      if (id === 'intervals') return ok({ minutes: ['1m', '5m'] })
      if (id === 'expiry') return ok(['18-DEC-26', '19-JAN-27'])
      if (id === 'history') {
        const s = String(body.symbol)
        if (s.endsWith('CE')) return ok(minutes(o.times, o.ce ?? (() => 150)))
        if (s.endsWith('PE')) return ok(minutes(o.times, o.pe ?? (() => 150)))
        return ok(minutes(o.times, o.ref ?? (() => SPOT)))
      }
      throw new Error(`no reply for ${id}`)
    }
  }

  type Point = {
    time: number
    iv: number | null
    delta: number | null
    gamma: number | null
    theta: number | null
    vega: number | null
    option_price: number
    underlying_price: number
  }
  type Chart = {
    status: string
    data: {
      underlying: string
      underlying_ltp: number
      atm_strike: number
      ce_symbol: string
      pe_symbol: string
      interval: string
      series: { symbol: string; option_type: string; strike: number; iv_data: Point[] }[]
    }
  }
  const chartOf = (r: DomReply) => r.body as unknown as Chart

  /** The point the service makes of one candle at t years (iv_chart_service.py:436-454). */
  function expected(flag: 'c' | 'p', price: number, F: number, t: number): Omit<Point, 'time'> {
    const sigma = rawIvAny(price, F, SPOT, 0, t, flag)
    const g = sigma === null ? null : rawGreeks(flag, F, SPOT, t, 0, sigma)
    return {
      iv: sigma === null ? null : pyRound(sigma * 100, 2),
      delta: g ? pyRound(g.delta, 4) : null,
      gamma: g ? pyRound(g.gamma, 6) : null,
      theta: g ? pyRound(g.theta, 4) : null,
      vega: g ? pyRound(g.vega, 4) : null,
      option_price: price,
      underlying_price: F,
    }
  }

  test('ivChart: three history reads; t is 1e-4 at the floor and the leg is null after the cut-off', async () => {
    // expiry day, Tue 01 Dec: 14:00 is 90 minutes out, 15:00 and 15:29 under the hour floor,
    // 15:30 the cut-off itself and 15:31 past it
    const day = '2026-12-01'
    const times = ['14:00', '15:00', '15:29', '15:30', '15:31'].map((t) => istSec(day, t))
    jest.setSystemTime(istSec(day, '16:00') * 1000)
    const h = setup({ answer: ivServer({ times }) })
    const { value: r } = await settle(h.open().post(IV, BODY))
    expect(r.status).toBe(200)

    const history = h.sent.filter((b) => b.id === 'history')
    expect(history).toEqual(
      [
        ['NIFTY', 'NSE_INDEX'],
        ['NIFTY01DEC2624000CE', 'NFO'],
        ['NIFTY01DEC2624000PE', 'NFO'],
      ].map(([symbol, exchange]) => ({
        id: 'history',
        symbol,
        exchange,
        interval: '1m',
        start_date: '2026-11-26',
        end_date: '2026-12-01',
      })),
    )
    expect(h.sent.find((b) => b.id === 'optionchain')).toEqual({
      id: 'optionchain',
      ...QUERY,
      strike_count: 1,
    })

    const c = chartOf(r)
    expect(c.data).toMatchObject({
      underlying: 'NIFTY',
      underlying_ltp: SPOT,
      atm_strike: SPOT,
      ce_symbol: 'NIFTY01DEC2624000CE',
      pe_symbol: 'NIFTY01DEC2624000PE',
      interval: '1m',
    })
    const [ce, pe] = c.data.series
    expect([ce?.symbol, ce?.option_type, ce?.strike]).toEqual(['NIFTY01DEC2624000CE', 'CE', SPOT])
    expect(pe?.option_type).toBe('PE')
    const cutoff = istSec(day, '15:30')
    const yearsAt = (sec: number) => Math.max((cutoff - sec) / 86_400 / 365, 0.0001)
    expect(ce?.iv_data).toEqual([
      { time: times[0], ...expected('c', 150, SPOT, yearsAt(times[0] as number)) },
      { time: times[1], ...expected('c', 150, SPOT, 0.0001) },
      { time: times[2], ...expected('c', 150, SPOT, 0.0001) },
      ...[times[3], times[4]].map((time) => ({
        time,
        iv: null,
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
        option_price: 150,
        underlying_price: SPOT,
      })),
    ])
    expect(ce?.iv_data[0]?.iv).not.toBe(ce?.iv_data[1]?.iv)
  })

  test('ivChart: overpriced → iv 500.0, Greeks at σ 4.999999999999996; at intrinsic → iv 0.0, Greeks at 1e-6; below → null', async () => {
    // Tue 01 Dec, 10:00 to 10:02: the call overpriced, then at its intrinsic value, then below
    const day = '2026-12-01'
    const times = ['10:00', '10:01', '10:02'].map((t) => istSec(day, t))
    jest.setSystemTime(istSec(day, '10:30') * 1000)
    const ref = new Map([
      [times[0], SPOT],
      [times[1], SPOT + 500],
      [times[2], SPOT + 500],
    ])
    const ce = new Map([
      [times[0], 23_000],
      [times[1], 500],
      [times[2], 450],
    ])
    const h = setup({
      answer: ivServer({
        times,
        ref: (t) => ref.get(t) ?? 0,
        ce: (t) => ce.get(t) ?? 0,
        pe: () => 0,
      }),
    })
    const { value: r } = await settle(h.open().post(IV, BODY))
    const [call, put] = chartOf(r).data.series
    const t = (sec: number) => (istSec(day, '15:30') - sec) / 86_400 / 365
    const [over, intrinsic, below] = call?.iv_data ?? []
    expect(over?.iv).toBe(500)
    expect(over).toEqual({ time: times[0], ...expected('c', 23_000, SPOT, t(times[0] as number)) })
    expect(over?.delta).toBe(
      pyRound(
        rawGreeks('c', SPOT, SPOT, t(times[0] as number), 0, 4.999999999999996)?.delta ?? 0,
        4,
      ),
    )
    expect(intrinsic?.iv).toBe(0)
    expect(intrinsic).toEqual({
      time: times[1],
      ...expected('c', 500, SPOT + 500, t(times[1] as number)),
    })
    expect(intrinsic?.delta).toBe(
      pyRound(rawGreeks('c', SPOT + 500, SPOT, t(times[1] as number), 0, 1e-6)?.delta ?? 0, 4),
    )
    expect(below).toMatchObject({ iv: null, delta: null, gamma: null, theta: null, vega: null })
    // a close of 0 is never priced
    expect(put?.iv_data.every((p) => p.iv === null && p.delta === null)).toBe(true)
  })

  test('2.0.0.0: ivChart reads NSE_INDEX:NIFTY, and for CRUDEOIL its near FUT (RF 4)', async () => {
    const times = [istSec('2026-11-25', '10:00')]
    const nifty = setup({ answer: ivServer({ times, chain: { old: true } }) })
    const r = await settle(nifty.open().post(IV, BODY))
    expect(r.value.status).toBe(200)
    expect(nifty.sent.filter((b) => b.id === 'history')[0]).toMatchObject({
      symbol: 'NIFTY',
      exchange: 'NSE_INDEX',
    })

    const crude = setup({
      answer: ivServer({
        times,
        chain: { old: true, underlying: 'CRUDEOIL', spot: 6_000, step: 50 },
      }),
    })
    const c = await settle(
      crude.open().post(IV, {
        underlying: 'CRUDEOIL',
        exchange: 'MCX',
        expiry_date: '16DEC26',
        interval: '1m',
      }),
    )
    expect(c.value.status).toBe(200)
    expect(crude.sent.filter((b) => b.id === 'expiry')).toEqual([
      { id: 'expiry', symbol: 'CRUDEOIL', exchange: 'MCX', instrumenttype: 'futures' },
    ])
    expect(crude.sent.filter((b) => b.id === 'history').map((b) => [b.symbol, b.exchange])).toEqual(
      [
        ['CRUDEOIL18DEC26FUT', 'MCX'],
        ['CRUDEOIL16DEC266000CE', 'MCX'],
        ['CRUDEOIL16DEC266000PE', 'MCX'],
      ],
    )
  })

  test('ivChart errors: the reference read failed → 400; no reference candles → 404; no option candles → 404', async () => {
    const times = [istSec('2026-11-25', '10:00')]
    const base = ivServer({ times })
    const failing = (fail: (b: Body) => unknown) =>
      setup({
        answer: (id, body) => (id === 'history' ? (fail(body) ?? base(id, body)) : base(id, body)),
      })
    const busy = new ApiError({
      kind: 'Validation',
      status: 400,
      endpoint: 'history',
      serverMessage: 'Invalid symbol',
    })

    const noRef = await settle(
      failing((b) => (b.symbol === 'NIFTY' ? busy : undefined))
        .open()
        .post(IV, BODY),
    )
    expect([noRef.value.status, noRef.value.body]).toEqual([
      400,
      { status: 'error', message: 'Failed to fetch underlying history: Invalid symbol' },
    ])
    const empty = await settle(
      failing((b) => (b.symbol === 'NIFTY' ? ok([]) : undefined))
        .open()
        .post(IV, BODY),
    )
    expect([empty.value.status, empty.value.body]).toEqual([
      404,
      { status: 'error', message: 'No underlying history data available for today' },
    ])
    // one leg's read failing leaves the other; both leave no series
    const oneLeg = await settle(
      failing((b) => (String(b.symbol).endsWith('PE') ? busy : undefined))
        .open()
        .post(IV, BODY),
    )
    expect(chartOf(oneLeg.value).data.series.map((s) => s.option_type)).toEqual(['CE'])
    const noLegs = await settle(
      failing((b) => (b.symbol === 'NIFTY' ? undefined : ok([])))
        .open()
        .post(IV, BODY),
    )
    expect([noLegs.value.status, noLegs.value.body]).toEqual([
      404,
      { status: 'error', message: 'No option history data available for today' },
    ])
    // an interval the broker does not offer, and days past 30
    const h = setup({ answer: base })
    const bad = await settle(h.open().post(IV, { ...BODY, interval: '2m' }))
    expect([bad.value.status, bad.value.body]).toEqual([
      400,
      { status: 'error', message: 'Invalid interval. Allowed: 1m, 5m' },
    ])
    expect(h.sent.map((b) => b.id)).toEqual(['intervals'])
    await settle(h.open().post(IV, { ...BODY, days: 45 }))
    expect(h.sent.find((b) => b.id === 'history')).toMatchObject({ start_date: '2026-08-25' })
  })
})

test("the interval routes: OI Profile's 1m, 5m and 15m, Option Greeks' intraday ones", async () => {
  const calls: string[] = []
  const deps = testRouteDeps({
    api: {
      call: async (id, _body, schema) => {
        calls.push(id)
        return schema.parse(
          ok({ seconds: ['5s'], minutes: ['1m', '3m', '5m', '15m'], days: ['D'] }),
        )
      },
    },
  })
  const routes = createDeviceRoutes(deps)
  const get = (path: string) => {
    const route = routes.find((r) => r.method === 'GET' && r.path === path)
    if (!route) throw new Error(`no route ${path}`)
    return route.handle(
      { v: 1, kind: 'request', rid: 1, method: 'GET', path },
      new AbortController().signal,
    )
  }
  expect((await get('/oiprofile/api/intervals')).body).toEqual(
    ok({ intervals: ['1m', '5m', '15m'] }),
  )
  expect((await get('/ivchart/api/intervals')).body).toEqual(
    ok({ seconds: ['5s'], minutes: ['1m', '3m', '5m', '15m'], hours: [] }),
  )
  // each through RouteDeps.intervals, the screen's one query in the app
  expect(calls).toEqual(['intervals', 'intervals'])
})
