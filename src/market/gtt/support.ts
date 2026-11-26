// Whether GTT can be offered (design 17.3). The endpoints come with a version, but support also
// differs by broker and by mode (Review Focus 2): a broker without GTT answers 501 in LIVE, and
// before 2.0.1.9 the sandbox answers 501 in ANALYZE even for Zerodha. So what the GTT replies
// showed is kept per broker and mode (`Capabilities.features`), and an unknown answer is
// settled by one read of the GTT book.
import { type Capabilities, hasEndpoint } from '~/core/capabilities/gates'
import { atLeast } from '~/core/config/version'
import { isQuoteOnly } from '../instruments/exchanges'
import type { GttMode } from './api'

/** The first version with each part of GTT (G1). */
export const GTT_GATES = { endpoints: '2.0.0.8', sandbox: '2.0.1.9', status: '2.0.2.4' } as const

/** Where the support for one broker in one mode is kept in `Capabilities.features`. */
export const gttFeatureKey = (broker: string, mode: GttMode) => `gtt:${broker}:${mode}`

export type GttSupport = {
  state: 'yes' | 'no' | 'unknown'
  reason: string
  /** The server version that would add it. */
  needs?: string
  /** True when one read of the GTT book would settle the answer. */
  detect: boolean
}

const MODE_LABEL: Record<GttMode, string> = { live: 'LIVE', analyze: 'ANALYZE' }

const yes = (reason: string): GttSupport => ({ state: 'yes', reason, detect: false })
const unknown = (reason: string, detect: boolean): GttSupport => ({
  state: 'unknown',
  reason,
  detect,
})
const no = (reason: string, needs?: string): GttSupport =>
  needs === undefined
    ? { state: 'no', reason, detect: false }
    : { state: 'no', reason, needs, detect: false }

/**
 * GTT support for the server's broker in the badge's mode, taking the first rule that applies:
 * no caps; an index; the endpoints missing; the broker or the mode not known; what a GTT reply
 * showed for that broker and mode; otherwise unknown, to be detected. A missing endpoint needs
 * 2.0.0.8 unless the server is known to be at least that, as the feature gates do. An unknown
 * endpoint compares no version: GTT landed while the server still called itself 2.0.0.7.
 */
export function gttSupport(
  c: Capabilities | null,
  o: { mode: GttMode | 'unknown'; broker: string | null; exchange?: string },
): GttSupport {
  if (!c) return unknown('The server has not been probed yet', false)
  if (o.exchange !== undefined && isQuoteOnly(o.exchange)) return no('Indices have no GTT')
  if (hasEndpoint(c, 'gttorderbook') === false) {
    return atLeast(c.version, GTT_GATES.endpoints)
      ? no('This server does not list the GTT endpoints')
      : no(`GTT needs OpenAlgo ${GTT_GATES.endpoints}`, GTT_GATES.endpoints)
  }
  if (!o.broker) return unknown('The broker is not known yet', false)
  if (o.mode === 'unknown') return unknown('The LIVE/ANALYZE mode is not known yet', false)

  const where = `${o.broker} in ${MODE_LABEL[o.mode]}`
  const seen = c.features[gttFeatureKey(o.broker, o.mode)]
  if (seen === false) {
    return o.mode === 'analyze' && !atLeast(c.version, GTT_GATES.sandbox)
      ? no(`GTT in the analyzer needs OpenAlgo ${GTT_GATES.sandbox}`, GTT_GATES.sandbox)
      : no('This broker has no GTT on this server')
  }
  if (seen === true) return yes(`The server serves GTT for ${where}`)
  return unknown(`Not checked yet for ${where}`, true)
}
