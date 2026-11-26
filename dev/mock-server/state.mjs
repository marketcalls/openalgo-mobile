import { PROFILES } from './profiles.mjs'

export const DEFAULT_PROFILE = '2.0.3.5'
export const DEFAULT_API_KEY = 'ab'.repeat(32)
export const DEFAULT_BROKER = 'zerodha'
export const USER_ID = 'mock'

const initial = (profile, broker) => ({
  profile,
  broker,
  brokerLoggedOut: false,
  semiAuto: false,
  analyzer: false,
  appInfo: true,
  swagger: true,
  banned: false,
  rateLimited: false,
  wsBrokerError: false,
  wsPingUnsupported: false,
  maxDepth: 5,
  ackEchoesDepth: false,
  silenceFeed: false,
  absentFields: [],
  failNext: null,
  delayNext: null,
  orderEvents: true,
  flatCloseError: false,
  splitFailFrom: null,
  marginUnsupported: false,
})

const oneOf = (values) => (v) => values.includes(v) || `must be one of ${JSON.stringify(values)}`
const isBool = (v) => typeof v === 'boolean' || 'must be a boolean'
const optionalBool = (v) => v === undefined || typeof v === 'boolean'
const STORED = {
  profile: oneOf(Object.keys(PROFILES)),
  broker: (v) =>
    (typeof v === 'string' && /^[a-z][a-z0-9_]*$/.test(v)) || 'must be a broker id such as zerodha',
  brokerLoggedOut: isBool,
  semiAuto: isBool,
  analyzer: isBool,
  appInfo: isBool,
  swagger: isBool,
  banned: oneOf([false, 'text', 'json']),
  rateLimited: oneOf([false, 'restx', 'busy', 'nginx']),
  wsBrokerError: isBool,
  wsPingUnsupported: isBool,
  maxDepth: oneOf([5, 20, 30]),
  ackEchoesDepth: isBool,
  silenceFeed: isBool,
  absentFields: (v) =>
    (Array.isArray(v) && v.every((f) => typeof f === 'string')) || 'must be an array of names',
  // afterApply: the write is carried out, then answered with the failure.
  failNext: (v) =>
    v === null ||
    (typeof v?.path === 'string' && Number.isInteger(v.status) && optionalBool(v.afterApply)) ||
    'must be null or {path, status, body?, contentType?, afterApply?}',
  // The next request to `path` is answered `ms` late: before it is carried out, or after
  // with afterApply.
  delayNext: (v) =>
    v === null ||
    (typeof v?.path === 'string' &&
      Number.isInteger(v.ms) &&
      v.ms >= 0 &&
      optionalBool(v.afterApply)) ||
    'must be null or {path, ms, afterApply?}',
  orderEvents: isBool,
  flatCloseError: isBool,
  splitFailFrom: (v) =>
    v === null || (Number.isInteger(v) && v >= 1) || 'must be null or a child number from 1',
  marginUnsupported: isBool,
}
// One-shot actions: the feed or the order engine carries them out, and they are not stored.
const ACTIONS = {
  // 1006 drops the connection; ws refuses to send 1004-1006 or anything outside these ranges.
  closeSockets: (v) =>
    (Number.isInteger(v) &&
      ((v >= 1000 && v <= 1014 && v !== 1004 && v !== 1005) || (v >= 3000 && v <= 4999))) ||
    'must be a close code that can be sent, or 1006',
  emitOrderUpdate: (v) =>
    v === true || (typeof v === 'object' && v !== null) || 'must be an object',
  // The order engine fills every working order at its own price.
  fillWorking: (v) => v === true || 'must be true',
}

export class ControlError extends Error {}

function check(patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new ControlError('the patch must be a JSON object')
  }
  for (const [k, v] of Object.entries(patch)) {
    const rule = STORED[k] ?? ACTIONS[k]
    if (!rule) throw new ControlError(`unknown control ${k}`)
    const ok = rule(v)
    if (ok !== true) throw new ControlError(`${k} ${ok}`)
  }
}

/** The key that stats and failNext use for a path: the endpoint id under /api/v1. */
export function pathKey(pathname) {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return p.startsWith('/api/v1/') ? p.slice('/api/v1/'.length) : p
}

const emptyStats = () => ({ requests: {}, wsConnections: 0, wsAuthAttempts: 0, lastBody: {} })

export function createState({ profile = DEFAULT_PROFILE, broker = DEFAULT_BROKER } = {}) {
  if (!PROFILES[profile]) throw new ControlError(`unknown profile ${profile}`)
  const ok = STORED.broker(broker)
  if (ok !== true) throw new ControlError(`broker ${ok}`)
  let current = initial(profile, broker)
  let stats = emptyStats()
  const listeners = new Set()
  const take = (control, pathname) => {
    const c = current[control]
    if (!c || pathKey(c.path) !== pathKey(pathname)) return null
    current = { ...current, [control]: null }
    return c
  }

  return {
    get current() {
      return current
    },
    /** The behaviour flags of the active profile. */
    get version() {
      return PROFILES[current.profile]
    },
    get stats() {
      return stats
    },
    snapshot() {
      return { ...structuredClone(current), stats: structuredClone(stats) }
    },
    /** Validates and merges a control patch, then tells the listeners. Throws ControlError. */
    patch(p) {
      check(p)
      const prev = current
      const next = { ...current }
      for (const k of Object.keys(p)) if (k in STORED) next[k] = p[k]
      current = next
      for (const fn of listeners) fn(p, prev)
    },
    onPatch(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    countRequest(pathname) {
      const key = pathKey(pathname)
      stats.requests[key] = (stats.requests[key] ?? 0) + 1
    },
    /** Keeps the request body that reached `pathname`, without the key, for the stats. */
    noteBody(pathname, body) {
      const { apikey: _, ...rest } = body
      stats.lastBody[pathKey(pathname)] = rest
    },
    /** The pending failNext for this path, cleared as it is taken. */
    takeFailure(pathname) {
      return take('failNext', pathname)
    },
    /** The pending delayNext for this path, cleared as it is taken. */
    takeDelay(pathname) {
      return take('delayNext', pathname)
    },
    reset() {
      current = initial(profile, broker)
      stats = emptyStats()
    },
  }
}
