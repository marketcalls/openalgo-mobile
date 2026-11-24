// Is the key good, and is the broker logged in? The two look the same on the wire: a 403
// "Invalid openalgo apikey" (S3). `search` checks only the key, so it splits them.
import type { Api } from '~/core/http/api'
import type { HttpClient } from '~/core/http/client'
import { ApiError } from '~/core/http/errors'
import { FundsSchema, PingSchema, SearchSchema } from '~/core/http/schemas'
import { log } from '~/core/log/logger'
import type { BrokerSession, ConnectionHandle } from '~/core/services/connection'

const TAG = 'status'
const CACHE_MS = 30_000

/** Asks `search` (key only) whether the key is accepted. Any error but KeyInvalid is thrown. */
export async function checkKey(http: Pick<HttpClient, 'request'>): Promise<'ok' | 'invalid'> {
  try {
    await http.request('search', { query: 'NIFTY', exchange: 'NSE_INDEX' }, SearchSchema)
    return 'ok'
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'KeyInvalid') return 'invalid'
    throw e
  }
}

export type BrokerStatusDeps = {
  api: Pick<Api, 'call'>
  http: Pick<HttpClient, 'request'>
  conn: ConnectionHandle
  now: () => number
}

export function createBrokerStatus({ api, http, conn, now }: BrokerStatusDeps) {
  let inFlight: Promise<'key_invalid' | 'broker_logged_out'> | null = null
  let cached: { at: number; result: 'key_invalid' | 'broker_logged_out' } | null = null

  function record(result: 'key_invalid' | 'broker_logged_out') {
    conn
      .getState()
      .set(
        result === 'key_invalid'
          ? { keyState: 'invalid' }
          : { keyState: 'ok', brokerSession: 'logged_out' },
      )
  }

  return {
    /** Funds checks the broker session as well as the key, so its answer sets both states. */
    async check(): Promise<BrokerSession> {
      const set = conn.getState().set
      try {
        await api.call('funds', {}, FundsSchema)
        set({ keyState: 'ok', brokerSession: 'active' })
        return 'active'
      } catch (e) {
        if (e instanceof ApiError && e.kind === 'KeyInvalid') {
          set({ keyState: 'invalid' })
          return 'unknown'
        }
        if (e instanceof ApiError && e.kind === 'BrokerLoggedOut') {
          set({ keyState: 'ok', brokerSession: 'logged_out' })
          return 'logged_out'
        }
        log.warn(TAG, 'broker check inconclusive')
        set({ brokerSession: 'unknown' })
        return 'unknown'
      }
    },

    /**
     * Splits a 403 "Invalid openalgo apikey" into a bad key or a logged-out broker. One call at
     * a time shares a single `search`, and the answer holds for 30 s.
     */
    resolveAuth403(): Promise<'key_invalid' | 'broker_logged_out'> {
      if (cached && now() - cached.at < CACHE_MS) return Promise.resolve(cached.result)
      if (inFlight) return inFlight
      const run = (async () => {
        const result = (await checkKey(http)) === 'invalid' ? 'key_invalid' : 'broker_logged_out'
        record(result)
        cached = { at: now(), result }
        return result
      })()
      const mine = run.finally(() => {
        if (inFlight === mine) inFlight = null
      })
      inFlight = mine
      return mine
    },

    /** Forgets the cached split (after the key is replaced). */
    reset(): void {
      cached = null
      inFlight = null
    },

    /** The broker's name from `ping`, kept in the connection state; null when unavailable. */
    async fetchBrokerName(): Promise<string | null> {
      try {
        const { broker } = await api.call('ping', {}, PingSchema)
        conn.getState().set({ broker })
        return broker
      } catch {
        return null
      }
    },
  }
}

export type BrokerStatus = ReturnType<typeof createBrokerStatus>
