// The golden cases (design 9.2): each recorded input in test/golden/inputs with what the server's
// own Python made of it in test/golden/expected (scripts/golden/harness.py), and a fake Api that
// answers from the recording: by request key (scripts/lib/golden-keys.mjs) for plan E's routes,
// and for plan F's chains and history by the superset rule the harness serves the Python by.
// Tests only.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { type Api, type KeyedApi, stableJson } from '~/core/http/api'
import { createServerClock } from '~/core/http/serverClock'
import { istDate } from '~/core/realtime/marketHours'
import type { RouteDeps, ToolProgress } from '~/dom/routes/deps'
import type { MasterRow } from '~/market/master/db'
import type { LegGreeks } from '~/market/options/black76'
import { createOptionsData } from '~/market/options/data'
import { optionsExchangeOf } from '~/market/options/expiry'
import { testRouteDeps } from './routeDeps'

const GOLDEN = join(__dirname, '..', 'golden')

/** A recorded case: `responses` maps a request key to the reply body the server sent. */
export type GoldenInput = {
  case: string
  /** 'synthetic': built from the mock NIFTY recording by scripts/golden/synthetic.mjs. */
  source: 'mock' | 'real' | 'synthetic'
  /** The server's clock for the whole case: chain 25's `server_ts` (preflight conflict 4). */
  serverNowMs: number
  underlying: string
  exchange: string
  /** DDMMMYY. */
  expiry: string
  fut: string | null
  /** Plan F's master (record-fixtures): what the server's database answers its services. */
  master?: GoldenMaster
  responses: Record<string, unknown>
}

/** golden-record-f.mjs masterOf, in the CSVs' order. */
export type GoldenMaster = {
  /** The CE strikes of the case's options exchange per DDMMMYY expiry, ascending and distinct. */
  strikes: Record<string, number[]>
  /** The unexpired FUT rows of NFO, MCX and the case's exchange. */
  futures: MasterRow[]
  /** The first row of the options exchange starting with the underlying and with a lot. */
  lotRows: MasterRow[]
}

/** calculate_greeks' reply: a success carries the IV and the Greeks, an error a message. */
export type GreeksBody = {
  status: 'success' | 'error'
  message?: string
  implied_volatility?: number
  greeks?: { delta: number; gamma: number; theta: number; vega: number; rho: number }
}

/** One priced leg of chain 25, priced by calculate_greeks at F = the chain's underlying_ltp. */
export type GoldenLeg = {
  symbol: string
  exchange: string
  spot: number
  price: number
  status: number
  body: GreeksBody
}

export type GoldenRoute =
  | 'get_oi_data'
  | 'calculate_max_pain'
  | 'get_iv_smile_data'
  | 'get_gex_data'
  | 'calculate_gamma_density'

/** Plan F's services in harness.py run_f; the Strike Profile at no range is `_all`. */
export type GoldenRouteF =
  | 'get_strike_profile'
  | 'get_strike_profile_all'
  | 'get_vol_surface_data'
  | 'get_iv_chart_data'
  | 'get_oi_profile_data'
  | 'get_straddle_chart_data'
  | 'get_custom_straddle_simulation'
  | 'get_strategy_chart_data'
  | 'get_multi_strike_oi_data'
  | 'get_arbitrage_universe'

export type GoldenExpected = {
  case: string
  source: 'mock' | 'real' | 'synthetic'
  serverNowMs: number
  underlying: string
  exchange: string
  expiry: string
  /** `args` is the page's request body, which the phone's route is called with. */
  routesF?: Record<GoldenRouteF, { args: Record<string, unknown>; status: number; body: unknown }>
  routes: Record<GoldenRoute, { status: number; body: unknown }>
  legs: GoldenLeg[]
  /** calculate_chain_greeks on chain 25, as /optionchain with_greeks runs it. */
  withGreeks: {
    forward: number
    years: number
    days: number
    rows: { strike: number; ce: LegGreeks | null; pe: LegGreeks | null }[]
  }
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

/** Every recorded input with its expected file, by file name ('mock-nifty', 'real-sensex'). */
export function goldenCases(): { id: string; input: GoldenInput; expected: GoldenExpected }[] {
  return readdirSync(join(GOLDEN, 'inputs'))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      id: file.slice(0, -'.json'.length),
      input: readJson<GoldenInput>(join(GOLDEN, 'inputs', file)),
      // A missing expected file throws: npm run gen-golden writes one per input.
      expected: readJson<GoldenExpected>(join(GOLDEN, 'expected', file)),
    }))
}

/** calculate_greeks' Greeks as spotGreeks returns them: null for any error reply. */
export function greeksOf(leg: Pick<GoldenLeg, 'status' | 'body'>): LegGreeks | null {
  const { status, body } = leg
  if (status !== 200 || body.status !== 'success' || !body.greeks) return null
  const { delta, gamma, theta, vega } = body.greeks
  return { iv: body.implied_volatility ?? Number.NaN, delta, gamma, theta, vega }
}

/**
 * An Api answering from the recording by request key (`${id} ${stableJson(body)}`, the body
 * holding no key). Every optionchain reply carries `server_ts` = serverNowMs/1000, so a case
 * prices at one instant on both sides (preflight conflict 4). An unrecorded request throws: the
 * caller sent a body the server never got.
 */
export function fakeApi(input: GoldenInput): Pick<KeyedApi, 'call' | 'get'> {
  const answer = <T>(id: string, body: Record<string, unknown>, schema: z.ZodType<T>): T => {
    const reply = recorded(input, id, body)
    if (id === 'optionchain' && isObject(reply) && 'server_ts' in reply) {
      reply.server_ts = input.serverNowMs / 1000
    }
    return schema.parse(reply)
  }
  return {
    call: async (id, body, schema) => answer(id, body, schema),
    get: async (id, query, schema) => answer(id, query, schema),
  }
}

/** The reply recorded for exactly this request, a copy; an unrecorded one throws. */
function recorded(input: GoldenInput, id: string, body: Record<string, unknown>): unknown {
  const key = `${id} ${stableJson(body)}`
  if (!Object.hasOwn(input.responses, key)) {
    throw new Error(`golden ${input.case}: no recorded reply for ${key}`)
  }
  return structuredClone(input.responses[key])
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** What option_chain_service._attach_chain_greeks adds to a leg. */
const GREEK_FIELDS = ['implied_volatility', 'delta', 'gamma', 'theta', 'vega'] as const
const CHAIN_PREFIX = 'optionchain '

/** A chain read without its strike_count and with_greeks: the expiry it is of. */
const chainBase = ({ strike_count: _n, with_greeks: _g, ...rest }: Record<string, unknown>) =>
  stableJson(rest)

/**
 * The chain reply for `ask` by the superset rule (preflight F 5a with T2's fix round; the twin of
 * golden-record-f.mjs servedChain and harness.py Recording.chain, which golden.test.mjs holds to
 * each other): from the recorded chains of the same expiry at a strike_count ≥ the asked,
 * - a plain ask takes the narrowest of either kind, the plain one on a tie, its Greeks taken out;
 * - a with_greeks ask the narrowest with-Greeks one, else the narrowest plain one, which stays
 *   without Greeks (the phone prices them, as the harness attaches the server's own).
 * Its rows are cut to strike_count each side of its own atm_strike by index, and `server_ts` is
 * the case instant, floored to the second. The first recorded wins a full tie.
 */
function servedChain(input: GoldenInput, ask: Record<string, unknown>): Record<string, unknown> {
  const n = ask.strike_count
  const greeks = ask.with_greeks === true
  const want = chainBase(ask)
  let source: { rank: [number, number]; reply: unknown; other: 0 | 1 } | null = null
  if (isNumber(n)) {
    for (const [key, reply] of Object.entries(input.responses)) {
      if (!key.startsWith(CHAIN_PREFIX)) continue
      const body = JSON.parse(key.slice(CHAIN_PREFIX.length)) as Record<string, unknown>
      const count = body.strike_count
      if (chainBase(body) !== want || !isNumber(count) || count < n) continue
      const other = (body.with_greeks === true) === greeks ? 0 : 1
      const rank: [number, number] = greeks ? [other, count] : [count, other]
      const before =
        source !== null &&
        (rank[0] < source.rank[0] || (rank[0] === source.rank[0] && rank[1] < source.rank[1]))
      if (source === null || before) source = { rank, reply, other }
    }
  }
  if (source === null || !isObject(source.reply)) {
    throw new Error(`golden ${input.case}: no recorded reply for optionchain ${stableJson(ask)}`)
  }
  const reply = structuredClone(source.reply)
  const rows = Array.isArray(reply.chain) ? (reply.chain as Record<string, unknown>[]) : []
  const at = rows.findIndex((row) => row.strike === reply.atm_strike)
  if (at >= 0 && isNumber(n)) {
    reply.chain = rows.slice(Math.max(0, at - n), Math.min(rows.length, at + n + 1))
  }
  if (!greeks && source.other === 1) {
    for (const row of reply.chain as Record<string, unknown>[]) {
      for (const leg of [row.ce, row.pe]) {
        if (isObject(leg)) for (const k of GREEK_FIELDS) delete leg[k]
      }
    }
    reply.forward_price = null
    reply.greeks_included = false
  }
  reply.server_ts = Math.floor(input.serverNowMs / 1000)
  return reply
}

const HISTORY_PREFIX = 'history '

/** A candle's IST date: its timestamp in seconds, or in ms when over 1e12. */
const rowDate = (row: unknown): string | null => {
  const t = isObject(row) ? row.timestamp : undefined
  return isNumber(t) ? istDate(t > 1e12 ? t : t * 1000) : null
}

/**
 * The history reply for `ask` (the twin of golden-record-f.mjs servedHistory): the recorded read
 * of the same symbol, exchange and interval (case-folded), the widest if several (the earliest
 * start, then the latest end), cut to the rows whose IST date lies within the asked start_date
 * and end_date, in recorded order.
 */
function servedHistory(input: GoldenInput, ask: Record<string, unknown>): Record<string, unknown> {
  const fold = (v: unknown) => String(v ?? '').toLowerCase()
  const triple = (b: Record<string, unknown>) =>
    [b.symbol, b.exchange, b.interval].map(fold).join('\u0000')
  const want = triple(ask)
  let source: { start: string; end: string; reply: unknown } | null = null
  for (const [key, reply] of Object.entries(input.responses)) {
    if (!key.startsWith(HISTORY_PREFIX)) continue
    const body = JSON.parse(key.slice(HISTORY_PREFIX.length)) as Record<string, unknown>
    if (triple(body) !== want) continue
    const start = String(body.start_date)
    const end = String(body.end_date)
    const wider =
      source === null || start < source.start || (start === source.start && end > source.end)
    if (wider) source = { start, end, reply }
  }
  const { start_date: start, end_date: end } = ask
  if (source === null || typeof start !== 'string' || typeof end !== 'string') {
    throw new Error(`golden ${input.case}: no recorded reply for history ${stableJson(ask)}`)
  }
  const rows = isObject(source.reply) && Array.isArray(source.reply.data) ? source.reply.data : []
  const data = rows.filter((row: unknown) => {
    const d = rowDate(row)
    return d !== null && d >= start && d <= end
  })
  return { status: 'success', data: structuredClone(data) }
}

/**
 * Plan F's fake Api: an optionchain or history read by the superset rule (servedChain,
 * servedHistory), any other read by its request key. An unrecorded read throws.
 */
export function fakeApiF(input: GoldenInput): Pick<KeyedApi, 'call' | 'get'> {
  const served = (id: string, body: Record<string, unknown>): unknown => {
    if (id === 'optionchain') return servedChain(input, body)
    if (id === 'history') return servedHistory(input, body)
    return recorded(input, id, body)
  }
  const answer = <T>(id: string, body: Record<string, unknown>, schema: z.ZodType<T>): T =>
    schema.parse(served(id, body))
  return {
    call: async (id, body, schema) => answer(id, body, schema),
    get: async (id, query, schema) => answer(id, query, schema),
  }
}

/**
 * The master's answers for a plan F route, from the input's: the case's strikes and lot rows
 * (harness.py install_f's patches answer no other), the recorded futures of an exchange.
 */
function goldenMaster(input: GoldenInput): Partial<RouteDeps['master']> {
  const m = input.master
  if (!m) return {}
  const own = optionsExchangeOf(input.exchange)
  const notRecorded = (what: string) => new Error(`golden ${input.case}: no master ${what}`)
  return {
    async strikes(exchange, underlying, ddmmmyy, type) {
      const asked = [underlying.toUpperCase(), type, exchange.toUpperCase()]
      if (asked.join(' ') !== [input.underlying.toUpperCase(), 'CE', own].join(' ')) {
        throw notRecorded(`strikes for ${asked.join(' ')}`)
      }
      return [...(m.strikes[ddmmmyy.toUpperCase()] ?? [])]
    },
    futures: async (exchange) => m.futures.filter((r) => r.exchange === exchange),
    async lotSizeLike(exchange, prefix) {
      if (exchange !== own) throw notRecorded(`lot sizes on ${exchange}`)
      const row = m.lotRows.find(
        (r) => r.symbol.toUpperCase().startsWith(prefix.toUpperCase()) && r.lotsize > 0,
      )
      return row ? row.lotsize : null
    },
  }
}

export type GoldenDeps = RouteDeps & {
  /** Every read the recording had no reply for, noted also where a route swallows the error. */
  misses: string[]
  /** What the route reported to the tool screen's progress line, in order. */
  progressed: ToolProgress[]
}

/**
 * Plan F's routes over the recording: fakeApiF, the input's master, the server's clock at
 * serverNowMs (every chain's server_ts is that instant, preflight F conflict 8), the Greeks priced
 * on the server, the screen shown, its progress recorded and an empty in-memory previous-day OI
 * cache (testRouteDeps').
 */
export function goldenDeps(input: GoldenInput): GoldenDeps {
  const fake = fakeApiF(input)
  const misses: string[] = []
  const api: Pick<Api, 'call'> = {
    call: (id, body, schema, o) =>
      fake.call(id, body, schema, o).catch((e: unknown) => {
        misses.push(e instanceof Error ? e.message : String(e))
        throw e
      }),
  }
  const now = () => input.serverNowMs
  const progressed: ToolProgress[] = []
  // retry false: a failed read is the route's to answer; expiry reads cache for good (gcTime
  // Infinity), so the client holds no timer
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const deps = testRouteDeps({
    options: createOptionsData({ api, queryClient, pid: 'golden', clock: createServerClock(now) }),
    master: goldenMaster(input),
    api,
    now,
    greeksOnServer: () => true,
    active: () => true,
    progress: (p) => progressed.push(p),
  })
  return { ...deps, misses, progressed }
}
