// The golden cases (design 9.2): each recorded input in test/golden/inputs with what the server's
// own Python made of it in test/golden/expected (scripts/golden/harness.py), and a fake Api that
// answers from the recording by request key (scripts/lib/golden-keys.mjs). Tests only.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'
import { type KeyedApi, stableJson } from '~/core/http/api'
import type { LegGreeks } from '~/market/options/black76'

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
  responses: Record<string, unknown>
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

export type GoldenExpected = {
  case: string
  source: 'mock' | 'real' | 'synthetic'
  serverNowMs: number
  underlying: string
  exchange: string
  expiry: string
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
    const key = `${id} ${stableJson(body)}`
    if (!Object.hasOwn(input.responses, key)) {
      throw new Error(`golden ${input.case}: no recorded reply for ${key}`)
    }
    const reply = structuredClone(input.responses[key])
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

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
