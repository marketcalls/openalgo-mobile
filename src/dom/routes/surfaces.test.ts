// The Strike Profile and Vol Surface routes on the phone: what they read, in what order, and
// what they answer (the golden test holds their figures to the server's Python).
import { QueryClient } from '@tanstack/react-query'
import type { Api } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import { createServerClock } from '~/core/http/serverClock'
import type { DomReply, DomRequest, JSONValue } from '~/dom/bridge/protocol'
import { rawGamma, spotGreeks } from '~/market/options/black76'
import { createOptionsData } from '~/market/options/data'
import { ensureChainGreeks } from '~/market/options/greeksChain'
import { pyRound } from '~/market/options/pyRound'
import { OptionChainSchema } from '~/market/options/schemas'
import { chainReply, cutoffSec } from '../../../test/helpers/chains'
import { keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { testRouteDeps } from '../../../test/helpers/routeDeps'
import { createDeviceRoutes, type FlipLeg, findGammaFlip } from './index'

// Mon 30 Nov 2026, 10:30 IST
const NOW = Date.UTC(2026, 10, 30, 5, 0)
const SPOT = 24000
const EXPIRIES = ['01DEC26', '08DEC26', '15DEC26', '22DEC26', '29DEC26', '05JAN27'] as const
const PROFILE = '/strikeprofile/api/profile-data'
const SURFACE = '/volsurface/api/surface-data'
const BUSY = 'The server is busy. Wait a few seconds and try again.'

type Body = Record<string, unknown>
type Reply = (id: string, body: Body) => unknown

/** A chain reply for the body asked: `strike_count` strikes either side of 24000. */
const chainFor = (b: Body, o: Parameters<typeof chainReply>[0] = {}) =>
  chainReply({
    expiry: String(b.expiry_date),
    spot: SPOT,
    each: Number(b.strike_count),
    serverTs: NOW / 1000,
    ...o,
  })

let lastRid = 0
const request = (path: string, body: JSONValue): DomRequest => ({
  v: 1,
  kind: 'request',
  rid: ++lastRid,
  method: 'POST',
  path,
  body,
})

function setup(reply: Reply = (_id, b) => chainFor(b), o: { greeksOnServer?: boolean } = {}) {
  const calls: Body[] = []
  let inFlight = 0
  let mostInFlight = 0
  const api: Pick<Api, 'call'> = {
    async call(id, body, schema) {
      calls.push({ id, ...(body as Body) })
      inFlight += 1
      mostInFlight = Math.max(mostInFlight, inFlight)
      // a read in flight lets every other caller run: a second read would overlap this one
      await new Promise((r) => setImmediate(r))
      inFlight -= 1
      const r = reply(id, body as Body)
      if (r instanceof Error) throw r
      return schema.parse(r)
    },
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const clock = createServerClock(() => NOW)
  const deps = testRouteDeps({
    options: createOptionsData({ api, queryClient, pid: 'p1', clock }),
    api,
    now: clock.now,
    greeksOnServer: () => o.greeksOnServer ?? true,
  })
  const routes = createDeviceRoutes(deps)
  const post = (
    path: string,
    body: JSONValue,
    signal = new AbortController().signal,
  ): Promise<DomReply> => {
    const route = routes.find((r) => r.method === 'POST' && r.path === path)
    if (!route) throw new Error(`no route ${path}`)
    return route.handle(request(path, body), signal)
  }
  return { calls, post, mostInFlight: () => mostInFlight, deps }
}

/** What each optionchain read asked: expiry, strike count and whether with_greeks was sent. */
const asked = (calls: Body[]) =>
  calls
    .filter((c) => c.id === 'optionchain')
    .map((c) => [c.expiry_date, c.strike_count, 'with_greeks' in c ? c.with_greeks : '-'])

type Profile = {
  status: string
  as_of: number
  range_pct: number | null
  strikes: number[]
  flip: number | null
  call_wall: number | null
  put_wall: number | null
  expiries: {
    expiry: string
    available: boolean
    message?: string
    expiry_ts: number | null
    dte: number | null
    years?: number
    cells: ({ unpriced: boolean; ce_gex: number; pe_gex: number; ce_dex: number } | null)[]
  }[]
}
const profileOf = (r: DomReply) => r.body as unknown as Profile

type Surface = {
  status: string
  data: {
    underlying: string
    underlying_ltp: number
    atm_strike: number
    strikes: number[]
    expiries: { date: string; dte: number }[]
    surface: (number | null)[][]
  }
}
const surfaceOf = (r: DomReply) => r.body as unknown as Surface

beforeEach(() => keepExpectedLogs())
afterEach(() => jest.restoreAllMocks())

describe('Strike Profile', () => {
  const QUERY = { underlying: 'NIFTY', exchange: 'NFO', expiry_dates: [...EXPIRIES] }

  test('six chains one at a time; NIFTY at 5% refetches the first at 25 strikes', async () => {
    const h = setup()
    const r = await h.post(PROFILE, { ...QUERY, range_pct: 5 })
    expect(r.status).toBe(200)
    // 24,000 × 5% over a 50-point step is 24 strikes, and 1 more: 25 a side
    expect(asked(h.calls)).toEqual([
      ['01DEC26', 20, true],
      ['01DEC26', 25, true],
      ...EXPIRIES.slice(1).map((e) => [e, 25, true]),
    ])
    expect(h.mostInFlight()).toBe(1)
    const p = profileOf(r)
    expect(p.range_pct).toBe(5)
    expect(p.as_of).toBe(NOW / 1000)
    // 24000 ± 25 strikes of 50
    expect(p.strikes).toHaveLength(51)
    expect(p.strikes[0]).toBe(22750)
    expect(p.expiries.map((e) => [e.expiry, e.available, e.cells.length])).toEqual(
      EXPIRIES.map((e) => [e, true, 51]),
    )
    // the server's chains carried no Greeks, so the phone priced every leg
    const atm = p.expiries[0]?.cells[p.strikes.indexOf(24000)]
    expect(atm?.ce_gex).toBeGreaterThan(0)
    expect(atm?.pe_gex).toBeLessThan(0)
    expect(p.expiries.every((e) => e.cells.every((c) => c !== null && !c.unpriced))).toBe(true)
    // every strike's put holds 5,000 more OI at the call's gamma: GEX is short everywhere
    expect(p.flip).toBeNull()
    expect([p.call_wall, p.put_wall]).toEqual([24000, 24000])
  })

  test('a page that aborts after the last chain read gets no flip search: the route rejects', async () => {
    const page = new AbortController()
    const h = setup((_id, b) => {
      // the tool closes as the last chain comes in; the fake read answers it anyway
      if (b.expiry_date === EXPIRIES[EXPIRIES.length - 1]) page.abort()
      return chainFor(b)
    })
    await expect(h.post(PROFILE, { ...QUERY, range_pct: 5 }, page.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(asked(h.calls)).toHaveLength(7)
  })

  test('range null asks 40 strikes a side', async () => {
    const h = setup()
    const r = await h.post(PROFILE, {
      ...QUERY,
      expiry_dates: EXPIRIES.slice(0, 2),
      range_pct: null,
    })
    expect(asked(h.calls)).toEqual([
      ['01DEC26', 20, true],
      ['01DEC26', 40, true],
      ['08DEC26', 40, true],
    ])
    expect(profileOf(r).range_pct).toBeNull()
    expect(profileOf(r).strikes).toHaveLength(81)

    // 2% needs ⌈24,000 × 2% / 50⌉ + 1 = 11 a side: the probe is kept, and the next read is at 11
    const narrow = setup()
    await narrow.post(PROFILE, { ...QUERY, expiry_dates: EXPIRIES.slice(0, 2), range_pct: 2 })
    expect(asked(narrow.calls)).toEqual([
      ['01DEC26', 20, true],
      ['08DEC26', 11, true],
    ])
  })

  test('2.0.0.0: no with_greeks is sent; Greeks are computed; unpriced only where OI has no LTP (RF 4)', async () => {
    const UNQUOTED = 24100
    const NO_OI = 23900
    const h = setup(
      (_id, b) => {
        const c = chainFor(b, { old: true }) as { chain: { strike: number; ce: Body; pe: Body }[] }
        for (const row of c.chain) {
          // an OI the broker sent with no LTP
          if (row.strike === UNQUOTED) row.ce = { ...row.ce, ltp: 0 }
          // no LTP and no OI: nothing is unknown
          if (row.strike === NO_OI) row.pe = { ...row.pe, ltp: 0, oi: 0 }
        }
        return c
      },
      { greeksOnServer: false },
    )
    const r = await h.post(PROFILE, { ...QUERY, expiry_dates: ['01DEC26'], range_pct: 5 })
    expect(r.status).toBe(200)
    expect(asked(h.calls)).toEqual([
      ['01DEC26', 20, '-'],
      ['01DEC26', 25, '-'],
    ])
    const p = profileOf(r)
    const e = p.expiries[0]
    if (!e) throw new Error('one expiry')
    const unpriced = p.strikes.filter((_, i) => e.cells[i]?.unpriced)
    expect(unpriced).toEqual([UNQUOTED])

    // a 2.0.0.0 chain has no server clock and no expiry instant: both are the phone's
    expect(p.as_of).toBe(Math.floor(NOW / 1000))
    expect(e.expiry_ts).toBe(cutoffSec('01DEC26'))
    expect(e.years).toBe(pyRound((cutoffSec('01DEC26') - NOW / 1000) / (365 * 86400), 6))
    expect(e.dte).toBe(1)

    // a cell is the server's exposure on the leg's own Greeks: γ·OI·S²·0.01/1e7 and Δ·OI·S/1e7
    const raw = OptionChainSchema.parse(
      chainFor({ expiry_date: '01DEC26', strike_count: 25 }, { old: true }),
    )
    const priced = ensureChainGreeks(raw, { optionsExchange: 'NFO', nowMs: NOW })
    const atm = priced.chain.find((row) => row.strike === 24000)
    const ce = atm?.ce
    if (!ce?.gamma || ce.delta === undefined) throw new Error('the ATM call is priced')
    const cell = e.cells[p.strikes.indexOf(24000)]
    expect(cell?.ce_gex).toBe(pyRound((ce.gamma * ce.oi * SPOT * SPOT * 0.01) / 1e7, 4))
    expect(cell?.ce_dex).toBe(pyRound((ce.delta * ce.oi * SPOT) / 1e7, 4))
  })

  test('a later expiry failing is unavailable; a 429 on the third ends the load with its reply', async () => {
    const failing =
      (expiry: string, error: () => Error): Reply =>
      (_id, b) =>
        b.expiry_date === expiry ? error() : chainFor(b)
    const server = () => new ApiError({ kind: 'Server', status: 500, endpoint: 'optionchain' })

    const h = setup(failing('08DEC26', server))
    const r = await h.post(PROFILE, { ...QUERY, range_pct: 5 })
    expect(r.status).toBe(200)
    const p = profileOf(r)
    expect(p.expiries[1]).toEqual({
      expiry: '08DEC26',
      expiry_ts: null,
      dte: null,
      available: false,
      message: 'No option data for this expiry.',
      cells: p.strikes.map(() => null),
    })
    expect(p.expiries.filter((e) => e.available)).toHaveLength(5)
    expect(asked(h.calls)).toHaveLength(7)

    const busy = setup(
      failing(
        '15DEC26',
        () => new ApiError({ kind: 'RateLimited', status: 429, endpoint: 'optionchain' }),
      ),
    )
    expect(await busy.post(PROFILE, { ...QUERY, range_pct: 5 })).toEqual({
      status: 429,
      body: { status: 'error', message: BUSY },
    })
    // nothing is read after the 429
    expect(asked(busy.calls).map(([e]) => e)).toEqual(['01DEC26', '01DEC26', '08DEC26', '15DEC26'])

    // the first expiry failing ends the load with its reply too
    const refused = setup(
      failing(
        '01DEC26',
        () =>
          new ApiError({
            kind: 'Validation',
            status: 400,
            endpoint: 'optionchain',
            serverMessage: 'No strikes found for expiry 01DEC26',
          }),
      ),
    )
    expect(await refused.post(PROFILE, { ...QUERY, range_pct: 5 })).toEqual({
      status: 400,
      body: { status: 'error', message: 'No strikes found for expiry 01DEC26' },
    })
    expect(asked(refused.calls)).toHaveLength(1)

    // no underlying price: the service's 404
    const unpriced = setup((_id, b) => ({ ...chainFor(b), underlying_ltp: 0 }))
    expect(await unpriced.post(PROFILE, { ...QUERY, range_pct: 5 })).toEqual({
      status: 404,
      body: { status: 'error', message: 'The underlying price is not available.' },
    })
  })

  test("strike profile input: ' NIFTY ' is trimmed, '28nov24' accepted; an empty exchange gets the 'required' message", async () => {
    const h = setup()
    await h.post(PROFILE, {
      underlying: ' NIFTY ',
      exchange: ' NFO ',
      expiry_dates: [' 28nov24 '],
      range_pct: 10,
      apikey: 'dropped',
    })
    expect(h.calls[0]).toEqual({
      id: 'optionchain',
      underlying: 'NIFTY',
      exchange: 'NFO',
      expiry_date: '28NOV24',
      strike_count: 20,
      with_greeks: true,
    })

    const refusals: [JSONValue, string][] = [
      [{ ...QUERY, exchange: '' }, 'underlying and exchange are required'],
      [{ ...QUERY, underlying: '   ' }, 'underlying and exchange are required'],
      [{}, 'underlying and exchange are required'],
      [{ ...QUERY, underlying: 'nifty' }, 'Invalid input format'],
      [{ ...QUERY, exchange: 'NSE-INDEX' }, 'Invalid input format'],
      // str(): a number is its digits, anything else never matches
      [{ ...QUERY, underlying: null }, 'Invalid input format'],
      [{ ...QUERY, underlying: ['NIFTY'] }, 'Invalid input format'],
      [{ ...QUERY, expiry_dates: [] }, 'Select at least one expiry.'],
      [{ ...QUERY, expiry_dates: '01DEC26' }, 'Select at least one expiry.'],
      [{ underlying: 'NIFTY', exchange: 'NFO' }, 'Select at least one expiry.'],
      [
        { ...QUERY, expiry_dates: ['01DEC26', '01-DEC-26'] },
        'Invalid expiry format. Expected DDMMMYY',
      ],
      [{ ...QUERY, range_pct: 3 }, 'Invalid strike range'],
      [{ ...QUERY, range_pct: 'five' }, 'Invalid strike range'],
      [{ ...QUERY, range_pct: true }, 'Invalid strike range'],
    ]
    const refusing = setup()
    for (const [body, message] of refusals) {
      expect([body, await refusing.post(PROFILE, body)]).toEqual([
        body,
        { status: 400, body: { status: 'error', message } },
      ])
    }
    expect(refusing.calls).toEqual([])

    // float(): a number in a string is a range; none is 5%; over 20 expiries, the first 20 are read
    // (two strikes a side, whatever is asked: twenty expiries at 40 would price 3,240 legs)
    const many = setup((_id, b) => chainFor({ ...b, strike_count: 2 }))
    const r = await many.post(PROFILE, {
      underlying: 'NIFTY',
      exchange: 'NFO',
      expiry_dates: Array.from({ length: 22 }, (_, i) => `${String(i + 1).padStart(2, '0')}DEC26`),
      range_pct: ' 10 ',
    })
    expect(profileOf(r).range_pct).toBe(10)
    expect(profileOf(r).expiries).toHaveLength(20)
    const unset = setup()
    const five = await unset.post(PROFILE, { ...QUERY, expiry_dates: ['01DEC26'] })
    expect(profileOf(five).range_pct).toBe(5)
    // a body that is not an object is the route's own 500
    expect((await unset.post(PROFILE, ['NIFTY'])).status).toBe(500)
  })
})

describe('findGammaFlip', () => {
  const T = 0.1
  const SIGMA = 0.2
  /** A leg whose forward is the spot, so that each grid price p prices it at F = p. */
  const leg = (strike: number, sign: 1 | -1, oi = 1000, forward = 110): FlipLeg => ({
    strike,
    forward,
    years: T,
    sigma: SIGMA,
    oi,
    sign,
  })
  /** The total the flip searches, as the server sums it: Σ γ·OI·sign, times p². */
  const total = (legs: FlipLeg[], spot: number, p: number) =>
    legs.reduce(
      (s, l) =>
        s + rawGamma('c', l.forward * (p / spot), l.strike, l.years, 0, l.sigma) * l.oi * l.sign,
      0,
    ) *
    p *
    p

  test('findGammaFlip interpolates the crossing nearest spot; no sign change → null', async () => {
    // a call wall at 100 and a put wall at 120 cross where both legs' d1 meet:
    // p² = 100·120·e^(−σ²t), with every forward at the spot
    const two = [leg(100, 1), leg(120, -1)]
    const exact = Math.sqrt(12_000) * Math.exp((-SIGMA * SIGMA * T) / 2)
    expect(await findGammaFlip(two, 110, 90, 130)).toBeCloseTo(exact, 2)

    // two points are the two ends, and the crossing is the straight line between them
    const a = total(two, 110, 100)
    const b = total(two, 110, 120)
    expect(await findGammaFlip(two, 110, 100, 120, 2)).toBe(100 + ((120 - 100) * -a) / (b - a))

    // put, call, put: GEX crosses below and above 110, and the crossing nearer the spot wins
    const three = (spot: number) => [
      leg(100, -1, 1000, spot),
      leg(110, 1, 2000, spot),
      leg(120, -1, 1000, spot),
    ]
    const low = await findGammaFlip(three(100), 100, 90, 130)
    const high = await findGammaFlip(three(120), 120, 90, 130)
    if (low === null || high === null) throw new Error('two crossings')
    expect(low).toBeLessThan(110)
    expect(high).toBeGreaterThan(110)
    for (const flip of [low, high]) {
      expect(Math.abs(total(three(110), 110, flip))).toBeLessThan(
        Math.abs(total(three(110), 110, 110)) / 1000,
      )
    }

    // only calls: GEX never changes sign
    expect(await findGammaFlip([leg(100, 1), leg(120, 1)], 110, 90, 130)).toBeNull()
    expect(await findGammaFlip([], 110, 90, 130)).toBeNull()
    expect(await findGammaFlip(two, 110, 130, 90)).toBeNull()
    expect(await findGammaFlip(two, 0, 90, 130)).toBeNull()
  })

  /** n legs over strikes 95 to 125: calls within 5 of the spot, puts outside, OI and IV varied. */
  const many = (n: number): FlipLeg[] =>
    Array.from({ length: n }, (_, i) => {
      const strike = 95 + (i % 61) * 0.5
      const sign = Math.abs(strike - 110) <= 5 ? 1 : -1
      return { ...leg(strike, sign, 500 + ((i * 37) % 1000)), sigma: 0.15 + (i % 7) * 0.01 }
    })
  /** `legs`, counting the grid rows priced: each row reads the first leg's forward once. */
  const counted = (legs: FlipLeg[]) => {
    const seen = { rows: 0 }
    const first = legs[0] as FlipLeg
    const watched = Object.defineProperty({ ...first }, 'forward', {
      get: () => {
        seen.rows += 1
        return first.forward
      },
    })
    return { legs: [watched, ...legs.slice(1)], seen }
  }
  /** find_gamma_flip in one pass, as the server runs it: every row's total, then the crossing
   *  nearest the spot. */
  const onePass = (legs: FlipLeg[], spot: number, low: number, high: number, points = 241) => {
    const step = (high - low) / (points - 1)
    const grid = Array.from({ length: points }, (_, i) =>
      i === points - 1 ? high : low + i * step,
    )
    const totals = grid.map((p) => total(legs, spot, p))
    let best: number | null = null
    for (let i = 0; i < points - 1; i++) {
      const a = totals[i] as number
      const b = totals[i + 1] as number
      const g0 = grid[i] as number
      const g1 = grid[i + 1] as number
      const crossing =
        a === 0 ? g0 : a < 0 !== b < 0 && b !== 0 ? g0 + ((g1 - g0) * -a) / (b - a) : null
      if (crossing === null) continue
      if (best === null || Math.abs(crossing - spot) < Math.abs(best - spot)) best = crossing
    }
    return best
  }

  test('the search hands the JS thread back every few rows, and finds the one-pass flip exactly', async () => {
    const { legs, seen } = counted(many(1000))
    // the rows priced at each turn of the event loop while the search runs
    const marks: number[] = []
    let searching = true
    const turn = () => {
      if (!searching) return
      marks.push(seen.rows)
      setTimeout(turn, 0)
    }
    setTimeout(turn, 0)
    const flip = await findGammaFlip(legs, 110, 90, 130)
    searching = false
    marks.push(seen.rows)

    expect(seen.rows).toBe(241)
    expect(flip).not.toBeNull()
    expect(flip).toBe(onePass(legs, 110, 90, 130))
    // never more than 3 rows (3,000 gammas) between two turns: taps and ticks wait a few ms
    const runs = marks.map((m, i) => m - (marks[i - 1] ?? 0))
    expect(marks.length).toBeGreaterThan(60)
    expect(Math.max(...runs)).toBeLessThanOrEqual(3)
  })

  test('a page that aborts stops the search: before its first row, or at the next yield', async () => {
    const before = counted(many(1000))
    const gone = new AbortController()
    gone.abort()
    await expect(
      findGammaFlip(before.legs, 110, 90, 130, 241, { signal: gone.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(before.seen.rows).toBe(0)

    const during = counted(many(1000))
    const closing = new AbortController()
    setTimeout(() => closing.abort(), 0)
    await expect(
      findGammaFlip(during.legs, 110, 90, 130, 241, { signal: closing.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(during.seen.rows).toBeGreaterThan(0)
    expect(during.seen.rows).toBeLessThanOrEqual(3)
  })
})

describe('Vol Surface', () => {
  const QUERY = { underlying: 'NIFTY', exchange: 'NFO', expiry_dates: ['01DEC26', '08DEC26'] }
  const ivOf = (symbol: string, price: number) => {
    const g = spotGreeks({ symbol, exchange: 'NFO', spot: SPOT, price, nowMs: NOW })
    return g && g.iv > 0 ? pyRound(g.iv, 2) : null
  }
  const dteOf = (expiry: string) =>
    pyRound(Math.max(0, (cutoffSec(expiry) * 1000 - NOW) / 1000 / 86400), 1)

  test('vol surface: OTM legs, the first-expiry fallback under 3 strikes, null IV for a zero LTP; 9 expiries → 8 chains', async () => {
    const ZERO = 24200
    const h = setup((_id, b) => {
      const c = chainFor(b) as { chain: { strike: number; ce: Body; pe: Body }[] }
      if (b.expiry_date === '01DEC26') {
        for (const row of c.chain) if (row.strike === ZERO) row.ce = { ...row.ce, ltp: 0 }
      }
      return c
    })
    const r = await h.post(SURFACE, { ...QUERY, strike_count: 5 })
    expect(r.status).toBe(200)
    expect(asked(h.calls)).toEqual([
      ['01DEC26', 5, '-'],
      ['08DEC26', 5, '-'],
    ])
    const s = surfaceOf(r)
    expect(s.data.underlying).toBe('NIFTY')
    expect(s.data.underlying_ltp).toBe(SPOT)
    expect(s.data.atm_strike).toBe(24000)
    expect(s.data.strikes).toEqual([
      23750, 23800, 23850, 23900, 23950, 24000, 24050, 24100, 24150, 24200, 24250,
    ])
    expect(s.data.expiries).toEqual([
      { date: '01DEC26', dte: dteOf('01DEC26') },
      { date: '08DEC26', dte: dteOf('08DEC26') },
    ])
    // the out-of-the-money leg of each strike: the put below the ATM strike, the call from it up
    const chain = OptionChainSchema.parse(chainFor({ expiry_date: '08DEC26', strike_count: 5 }))
    expect(s.data.surface[1]).toEqual(
      s.data.strikes.map((k) => {
        const row = chain.chain.find((x) => x.strike === k)
        const leg = k >= 24000 ? row?.ce : row?.pe
        return leg ? ivOf(leg.symbol, leg.ltp) : null
      }),
    )
    expect(s.data.surface[1]?.every((iv) => iv !== null && iv > 0)).toBe(true)
    expect(s.data.surface[0]?.[s.data.strikes.indexOf(ZERO)]).toBeNull()
    expect(s.data.surface[0]?.filter((iv) => iv === null)).toHaveLength(1)

    // the second expiry lists 24,200 to 24,700: two strikes in common, so the first's are used
    const apart = setup((_id, b) => chainFor(b, b.expiry_date === '08DEC26' ? { spot: 24450 } : {}))
    const gaps = surfaceOf(await apart.post(SURFACE, { ...QUERY, strike_count: 5 }))
    expect(gaps.data.strikes).toEqual(s.data.strikes)
    // and it has a cell only where it lists the strike
    expect(gaps.data.surface[1]?.map((iv) => iv !== null)).toEqual(
      s.data.strikes.map((k) => k >= 24200),
    )

    const nine = setup()
    const expiries = Array.from({ length: 9 }, (_, i) => `${String(i + 1).padStart(2, '0')}DEC26`)
    await nine.post(SURFACE, { ...QUERY, expiry_dates: expiries })
    // strike_count defaults to 15
    expect(asked(nine.calls)).toEqual(expiries.slice(0, 8).map((e) => [e, 15, '-']))
    expect(nine.mostInFlight()).toBe(1)
  })

  test('vol surface errors: both 400 messages; first chain failed → its reply; a later one skipped; none left → 404', async () => {
    const h = setup()
    const refusals: [JSONValue, string][] = [
      [{}, 'underlying and exchange are required'],
      [{ ...QUERY, underlying: '  ' }, 'underlying and exchange are required'],
      [{ underlying: 'NIFTY', exchange: 'NFO' }, 'expiry_dates must be a non-empty list'],
      [{ ...QUERY, expiry_dates: [] }, 'expiry_dates must be a non-empty list'],
      [{ ...QUERY, expiry_dates: '01DEC26' }, 'expiry_dates must be a non-empty list'],
    ]
    for (const [body, message] of refusals) {
      expect([body, await h.post(SURFACE, body)]).toEqual([
        body,
        { status: 400, body: { status: 'error', message } },
      ])
    }
    // .strip() and int() raise on these: the route's 500
    for (const body of [
      { ...QUERY, underlying: 7 },
      { ...QUERY, exchange: null },
      { ...QUERY, strike_count: 'ten' },
      { ...QUERY, strike_count: null },
    ]) {
      expect((await h.post(SURFACE, body)).status).toBe(500)
    }
    expect(h.calls).toEqual([])

    // int() and the clamp: a float is cut, a string of digits is read, 5..40
    for (const [given, sent] of [
      [2, 5],
      [99, 40],
      [12.9, 12],
      [' 20 ', 20],
    ] as const) {
      const c = setup()
      await c.post(SURFACE, { ...QUERY, expiry_dates: ['01DEC26'], strike_count: given })
      expect([given, asked(c.calls)]).toEqual([given, [['01DEC26', sent, '-']]])
    }

    const refused = setup((_id, b) =>
      b.expiry_date === '01DEC26'
        ? new ApiError({
            kind: 'Validation',
            status: 400,
            endpoint: 'optionchain',
            serverMessage: 'No strikes found for expiry 01DEC26',
          })
        : chainFor(b),
    )
    expect(await refused.post(SURFACE, QUERY)).toEqual({
      status: 400,
      body: { status: 'error', message: 'No strikes found for expiry 01DEC26' },
    })
    expect(asked(refused.calls)).toHaveLength(1)

    const skipped = setup((_id, b) =>
      b.expiry_date === '08DEC26'
        ? new ApiError({ kind: 'Server', status: 500, endpoint: 'optionchain' })
        : chainFor(b),
    )
    const r = surfaceOf(
      await skipped.post(SURFACE, { ...QUERY, expiry_dates: ['01DEC26', '08DEC26', '15DEC26'] }),
    )
    expect(r.data.expiries.map((e) => e.date)).toEqual(['01DEC26', '15DEC26'])
    expect(r.data.surface).toHaveLength(2)

    // the first chain lists no calls and the second fails: no expiry is left
    const none = setup((_id, b) => {
      if (b.expiry_date === '08DEC26') {
        return new ApiError({ kind: 'Server', status: 500, endpoint: 'optionchain' })
      }
      const c = chainFor(b) as { chain: { ce: unknown }[] }
      for (const row of c.chain) row.ce = null
      return c
    })
    expect(await none.post(SURFACE, QUERY)).toEqual({
      status: 404,
      body: { status: 'error', message: 'No valid expiry data found' },
    })

    // no underlying price on the first chain: the service's 500
    const unpriced = setup((_id, b) => ({ ...chainFor(b), underlying_ltp: 0 }))
    expect(await unpriced.post(SURFACE, QUERY)).toEqual({
      status: 500,
      body: { status: 'error', message: 'No LTP for NIFTY' },
    })
  })
})
