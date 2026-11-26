// What the app knows about its link to the server (design 7.4): broker, key and broker session,
// ban, feed and transport. It never holds the key. Only `semiAutoSeen` is persisted.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { persistStorage } from '~/core/config/bindings'
import type { BanForm } from '~/core/http/errors'
import { ApiError, isRecord } from '~/core/http/errors'
import type { FeedState } from '~/core/realtime/types'

export type BrokerSession = 'active' | 'logged_out' | 'unknown'

export type ConnectionState = {
  broker: string | null
  brokerSession: BrokerSession
  keyState: 'unknown' | 'ok' | 'invalid'
  banned: BanForm | null
  feed: FeedState
  transport: 'https' | 'http'
  analyzer: 'live' | 'analyze' | 'unknown'
  /** The server has shown Semi-Auto mode at least once (persisted). */
  semiAutoSeen: boolean
}

type ConnectionStore = ConnectionState & {
  set: (patch: Partial<ConnectionState>) => void
  /** Back to the defaults, `semiAutoSeen` included: a different server or key. */
  reset: () => void
}

export const CONNECTION_DEFAULTS: ConnectionState = {
  broker: null,
  brokerSession: 'unknown',
  keyState: 'unknown',
  banned: null,
  feed: 'idle',
  transport: 'https',
  analyzer: 'unknown',
  semiAutoSeen: false,
}

/** The transport a REST origin uses, from its scheme. */
export function transportOf(restOrigin: string): 'https' | 'http' {
  return restOrigin.trim().toLowerCase().startsWith('http://') ? 'http' : 'https'
}

export const useConnection = create<ConnectionStore>()(
  persist(
    (set) => ({
      ...CONNECTION_DEFAULTS,
      set: (patch) => set(patch),
      reset: () => set(CONNECTION_DEFAULTS),
    }),
    {
      name: 'oa.connection.v1',
      storage: persistStorage,
      partialize: ({ semiAutoSeen }) => ({ semiAutoSeen }),
      merge: (persisted, current) => ({
        ...current,
        semiAutoSeen:
          isRecord(persisted) && typeof persisted.semiAutoSeen === 'boolean'
            ? persisted.semiAutoSeen
            : false,
      }),
    },
  ),
)

export type ConnectionHandle = Pick<typeof useConnection, 'getState'>

function showsSemiAuto(json: unknown): boolean {
  if (!isRecord(json)) return false
  if (json.mode === 'semi_auto') return true
  if (isRecord(json.data) && json.data.mode === 'semi_auto') return true
  return (
    json.status === 'error' &&
    typeof json.message === 'string' &&
    json.message.includes('Semi-Auto')
  )
}

/** Notes Semi-Auto mode when a response body shows it (`mode: 'semi_auto'`, or a refusal text). */
export function markSemiAuto(json: unknown, conn: ConnectionHandle = useConnection): void {
  const s = conn.getState()
  if (!s.semiAutoSeen && showsSemiAuto(json)) s.set({ semiAutoSeen: true })
}

/** Notes Semi-Auto mode when `e` is a SemiAutoBlocked error. */
export function markSemiAutoError(e: unknown, conn: ConnectionHandle = useConnection): void {
  const s = conn.getState()
  if (!s.semiAutoSeen && e instanceof ApiError && e.kind === 'SemiAutoBlocked') {
    s.set({ semiAutoSeen: true })
  }
}
