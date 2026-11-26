// What a server supports (design 7.1) and the feature gates read from it. Version numbers
// trail main-branch builds (design 5.8), so what the server was seen to do beats its version.
import { atLeast } from '~/core/config/version'
import type { EndpointId } from '~/core/http/endpoints'

/** The first version with each feature (contract S10). */
export const VERSION_GATES = {
  authDeadline: '2.0.0.5',
  orderStream: '2.0.1.6',
  portfolioTools: '2.0.1.8',
  optionchainGreeks: '2.0.2.0',
  json404: '2.0.2.1',
  sectorRotation: '2.0.3.0',
  omitsAbsentTickFields: '2.0.3.3',
  close1012: '2.0.3.5',
} as const

/** What the live feed does. `orderStream` and `ping` stay null until the feed answers. */
export type WsCaps = {
  orderStream: boolean | null
  ping: boolean | null
  close1012: boolean
  authDeadline: boolean
}

export type Capabilities = {
  /** The server the probe ran against (its REST origin). */
  host: string
  /** From app-info, normalized; null when only the 2.0.0.0 marker was seen. */
  version: string | null
  versionSource: 'app-info' | 'marker'
  /** Endpoint ids from swagger.json, or null when it was not served. */
  endpoints: string[] | null
  /** `POST {}` probe results by endpoint id; an inconclusive probe is left out. */
  probed: Record<string, boolean>
  /** Request fields the server accepts or refuses, keyed `<endpoint>.<field>`. */
  fields: Record<string, boolean>
  /**
   * What the server was seen to serve that its version and endpoints cannot tell, such as GTT
   * for one broker in one mode (`gtt:<broker>:<mode>`). A new probe starts it empty.
   */
  features: Record<string, boolean>
  ws: WsCaps
  probedAt: number
}

export type FeatureId = keyof typeof VERSION_GATES | 'historySource'

export type Gate = { on: boolean; reason: string; needs?: string }

/** The request field behind a feature. */
const FIELDS: Partial<Record<FeatureId, string>> = {
  optionchainGreeks: 'optionchain.with_greeks',
  historySource: 'history.source',
}

/** The endpoints a tool needs, all of them. */
const TOOL_ENDPOINTS: Partial<Record<FeatureId, readonly EndpointId[]>> = {
  portfolioTools: ['portfolio/backtest', 'sip/backtest'],
  sectorRotation: ['sectorrotation'],
}

/** Whether the server has `id`: swagger when it was served, else the probes; null if unknown. */
export function hasEndpoint(c: Capabilities, id: EndpointId): boolean | null {
  if (c.endpoints) return c.endpoints.includes(id)
  return c.probed[id] ?? null
}

/** What the server was seen to do about `f`, or null when nothing shows it. */
function observed(c: Capabilities, f: FeatureId): { on: boolean; reason: string } | null {
  if (f === 'orderStream' && c.ws.orderStream !== null) {
    return c.ws.orderStream
      ? { on: true, reason: 'the live feed acknowledged subscribe_orders' }
      : { on: false, reason: 'the live feed refused subscribe_orders' }
  }
  const ids = TOOL_ENDPOINTS[f]
  if (!ids) return null
  const has = ids.map((id) => hasEndpoint(c, id))
  const missing = ids.find((_id, i) => has[i] === false)
  if (missing) {
    const reason = c.endpoints
      ? `swagger.json does not list ${missing}`
      : `probes did not find ${missing}`
    return { on: false, reason }
  }
  if (!has.every((h) => h === true)) return null
  const list = ids.join(' and ')
  return { on: true, reason: c.endpoints ? `swagger.json lists ${list}` : `probes found ${list}` }
}

/**
 * Whether `f` is on, taking the first rule that applies: a field the server refused;
 * what the server was seen to do; the version gate (historySource has none, so it is on);
 * otherwise off, as the version is unknown. An off gate `needs` the version that adds the
 * feature unless the server is already known to be at least that version.
 */
export function gate(c: Capabilities, f: FeatureId): Gate {
  const min = f === 'historySource' ? undefined : VERSION_GATES[f]
  const off = (reason: string): Gate =>
    min !== undefined && !atLeast(c.version, min)
      ? { on: false, reason, needs: min }
      : { on: false, reason }

  const field = FIELDS[f]
  if (field !== undefined && c.fields[field] === false) {
    return off(`the server refused ${field}`)
  }
  const seen = observed(c, f)
  if (seen) return seen.on ? seen : off(seen.reason)
  if (min === undefined) return { on: true, reason: 'sent until the server refuses it' }
  if (c.version === null) return off('server version unknown')
  return atLeast(c.version, min)
    ? { on: true, reason: `the server is ${c.version}` }
    : off(`needs ${min}; the server is ${c.version}`)
}
