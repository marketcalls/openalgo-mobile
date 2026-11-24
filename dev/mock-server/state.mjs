import { PROFILES } from './profiles.mjs'

export const DEFAULT_PROFILE = '2.0.3.5'
export const DEFAULT_API_KEY = 'ab'.repeat(32)
export const BROKER = 'zerodha'
export const USER_ID = 'mock'

const initial = (profile) => ({
  profile,
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
})

const oneOf = (values) => (v) => values.includes(v) || `must be one of ${JSON.stringify(values)}`
const isBool = (v) => typeof v === 'boolean' || 'must be a boolean'
const STORED = {
  profile: oneOf(Object.keys(PROFILES)),
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
  failNext: (v) =>
    v === null ||
    (typeof v?.path === 'string' && Number.isInteger(v.status)) ||
    'must be null or {path, status, body?, contentType?}',
}
// One-shot actions: the feed carries them out, and they are not stored.
const ACTIONS = {
  // 1006 drops the connection; ws refuses to send 1004-1006 or anything outside these ranges.
  closeSockets: (v) =>
    (Number.isInteger(v) &&
      ((v >= 1000 && v <= 1014 && v !== 1004 && v !== 1005) || (v >= 3000 && v <= 4999))) ||
    'must be a close code that can be sent, or 1006',
  emitOrderUpdate: (v) =>
    v === true || (typeof v === 'object' && v !== null) || 'must be an object',
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

const emptyStats = () => ({ requests: {}, wsConnections: 0, wsAuthAttempts: 0 })

export function createState({ profile = DEFAULT_PROFILE } = {}) {
  if (!PROFILES[profile]) throw new ControlError(`unknown profile ${profile}`)
  let current = initial(profile)
  let stats = emptyStats()
  const listeners = new Set()

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
    /** The pending failNext for this path, cleared as it is taken. */
    takeFailure(pathname) {
      const f = current.failNext
      if (!f || pathKey(f.path) !== pathKey(pathname)) return null
      current = { ...current, failNext: null }
      return f
    },
    reset() {
      current = initial(profile)
      stats = emptyStats()
    },
  }
}
