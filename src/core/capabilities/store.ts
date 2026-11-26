// The profile's capabilities (design 7.1), kept under `caps` and re-probed when a day old,
// on a host or version change, or when forced (after a 1012 close). It is also the
// FieldGate: the request fields the server refused are left out of later bodies.
import { z } from 'zod'
import type { ProfileStorage } from '~/core/config/storage'
import { normalizeVersion } from '~/core/config/version'
import type { FieldGate } from '~/core/http/api'
import { log } from '~/core/log/logger'
import type { Capabilities, WsCaps } from './gates'

export type CapabilityStore = {
  get(): Capabilities | null
  /** Reads the stored caps; null when none are stored or they no longer parse. */
  load(): Promise<Capabilities | null>
  /** Replaces the caps (a new probe) and stores them; rejects if storing fails. */
  save(c: Capabilities): Promise<void>
  /** Records a request field, keyed `<endpoint>.<field>` ('history.source'). */
  setField(key: string, v: boolean): void
  /** Records what the server was seen to serve, keyed by the feature ('gtt:zerodha:live'). */
  setFeature(key: string, v: boolean): void
  /** Records what the live feed showed. */
  setWs(p: Partial<WsCaps>): void
  /** The live-feed caps; before a probe, nothing is known (ruling 14). */
  ws(): WsCaps
  needsReprobe(o: { now: number; host: string; version: string | null; force?: boolean }): boolean
  /** Calls `fn` after every change; returns the unsubscribe. */
  subscribe(fn: (c: Capabilities | null) => void): () => void
}

const NAME = 'caps'
const TAG = 'caps'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const UNKNOWN_WS: WsCaps = Object.freeze({
  orderStream: null,
  ping: null,
  close1012: false,
  authDeadline: false,
})

const CapabilitiesSchema = z.object({
  host: z.string(),
  version: z.string().nullable(),
  versionSource: z.enum(['app-info', 'marker']),
  endpoints: z.array(z.string()).nullable(),
  probed: z.record(z.string(), z.boolean()),
  fields: z.record(z.string(), z.boolean()),
  // caps stored before features existed still load
  features: z.record(z.string(), z.boolean()).default({}),
  ws: z.object({
    orderStream: z.boolean().nullable(),
    ping: z.boolean().nullable(),
    close1012: z.boolean(),
    authDeadline: z.boolean(),
  }),
  probedAt: z.number(),
}) satisfies z.ZodType<Capabilities>

export function createCapabilityStore(s: ProfileStorage): CapabilityStore & FieldGate {
  let current: Capabilities | null = null
  const listeners = new Set<(c: Capabilities | null) => void>()
  // Writes land in the order they were made.
  let writes: Promise<void> = Promise.resolve()

  function set(next: Capabilities | null) {
    current = next
    for (const fn of listeners) fn(next)
  }

  function persist(c: Capabilities): Promise<void> {
    const done = writes.then(() => s.setJSON(NAME, c))
    writes = done.catch(() => log.warn(TAG, 'could not store the capabilities'))
    return done
  }

  /** Applies a change to the current caps and stores it in the background. */
  function patch(change: Partial<Capabilities>) {
    if (!current) return
    const next = { ...current, ...change }
    set(next)
    persist(next).catch(() => {})
  }

  function setField(key: string, v: boolean) {
    if (current && current.fields[key] !== v) patch({ fields: { ...current.fields, [key]: v } })
  }

  return {
    get: () => current,

    async load() {
      set(await s.getJSON(NAME, CapabilitiesSchema))
      return current
    },

    async save(c) {
      set(c)
      await persist(c)
    },

    setField,

    setFeature(key, v) {
      if (current && current.features[key] !== v) {
        patch({ features: { ...current.features, [key]: v } })
      }
    },

    setWs(p) {
      if (!current) return
      const ws = { ...current.ws, ...p }
      const prev = current.ws
      const same = (Object.keys(ws) as (keyof WsCaps)[]).every((k) => ws[k] === prev[k])
      if (!same) patch({ ws })
    },

    ws: () => current?.ws ?? UNKNOWN_WS,

    needsReprobe({ now, host, version, force = false }) {
      const c = current
      if (force || !c || c.host !== host) return true
      if ((version === null ? null : normalizeVersion(version)) !== c.version) return true
      return now - c.probedAt > MAX_AGE_MS
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },

    adapt(id, body) {
      const fields = current?.fields
      if (!fields) return body
      return Object.fromEntries(
        Object.entries(body).filter(([k]) => fields[`${id}.${k}`] !== false),
      )
    },

    markUnsupported(id, field) {
      setField(`${id}.${field}`, false)
    },
  }
}
