// Which depth levels a broker's feed sends (C8, design 7.5): a bundled map decides whether the
// depth screen offers 20 or 30 levels, and what the feed then delivers confirms it, or falls back
// to 5 (ruling 10). Pure: the screen passes the feed's facts in.
import type { DepthLevels } from '~/core/realtime/protocol'

/** Broker → exchange → the levels its feed accepts beyond the default 5. */
export type DepthMap = Record<string, Partial<Record<string, readonly DepthLevels[]>>>

// broker/<b>/streaming/<b>_mapping.py `depth_support` at openalgo c8b2896: the XTS brokers share it.
const XTS: Partial<Record<string, readonly DepthLevels[]>> = { NSE: [5, 20], NFO: [5, 20] }

/**
 * Every broker and exchange left out serves 5 (or fewer). Angel is 5 only
 * (angel_mapping.py:43-50); fyers' 50 levels need a symbol suffix (fyers_websocket_adapter.py:343)
 * and upstox's 30 are Plus-only (upstox_adapter.py:189-193), so neither is offered. No broker
 * offers 30 today; the type keeps it for later ref bumps.
 */
export const BROKER_DEPTH: DepthMap = {
  compositedge: XTS, // broker/compositedge/streaming/compositedge_mapping.py:131-138
  dhan: { NSE: [5, 20], NFO: [5, 20] }, // broker/dhan/streaming/dhan_mapping.py:86-96
  fivepaisaxts: XTS, // broker/fivepaisaxts/streaming/fivepaisaxts_mapping.py:131-138
  ibulls: XTS, // broker/ibulls/streaming/ibulls_mapping.py:131-138
  iifl: XTS, // broker/iifl/streaming/iifl_mapping.py:131-138
  jainamxts: XTS, // broker/jainamxts/streaming/jainamxts_mapping.py:131-138
  rmoney: XTS, // broker/rmoney/streaming/rmoney_mapping.py:131-138
  wisdom: XTS, // broker/wisdom/streaming/wisdom_mapping.py:131-138
}

/** The levels a broker's feed accepts on an exchange, ascending; always 5, and 5 alone by default. */
export function supportedDepth(
  broker: string | null,
  exchange: string,
  map: DepthMap = BROKER_DEPTH,
): DepthLevels[] {
  const listed = broker === null ? undefined : map[broker]?.[exchange]
  const deeper = new Set((listed ?? []).filter((n) => n > 5))
  return [5, ...[...deeper].sort((a, b) => a - b)]
}

/** The session's downgrades are kept per broker and exchange. */
export const downgradeKey = (broker: string, exchange: string): string => `${broker}:${exchange}`

/**
 * The levels the screen may offer: 5 alone unless the feed is live, the map offers more, and the
 * broker and exchange have not been downgraded this session.
 */
export function depthChoices(o: {
  map?: DepthMap
  broker: string | null
  exchange: string
  live: boolean
  downgraded: ReadonlySet<string>
}): DepthLevels[] {
  if (!o.live || o.broker === null || o.downgraded.has(downgradeKey(o.broker, o.exchange))) {
    return [5]
  }
  return supportedDepth(o.broker, o.exchange, o.map)
}

/** What the feed shows of a deeper subscription, once it has gone out (ruling 10). */
export type LevelFacts = {
  requested: DepthLevels
  /** The feed is live. */
  feedLive: boolean
  /** `realtime.isLive(ex, sym)`: on the wire, and not refused by the subscribe ack. */
  wired: boolean
  /**
   * `realtime.confirmedDepth(ex, sym)`: min(ack depth, levels seen); 0 is no levels yet. The
   * screen passes it only once a tick since the subscribe has carried more than 5 levels, so the
   * levels part cannot be the old 5-level subscription's ticks and 5 or fewer is the ack's.
   */
  confirmedDepth?: number
  /** The level counts of the socket's depth ticks since the subscribe, zero-level ticks left out. */
  wsLevels: readonly number[]
}

/**
 * Whether a request above 5 levels should fall back to 5: the server refused the subscribe (an
 * error ack leaves the key unwired while the feed is live, C8), the feed confirms 5 levels or
 * fewer, or the first two ticks carry 5 levels or fewer. A confirmed depth above 5 proves deeper
 * levels, even when a thin book prices fewer than asked. A 5-level request never downgrades.
 */
export function confirmLevels(f: LevelFacts): { downgraded: boolean } {
  if (f.requested <= 5) return { downgraded: false }
  const refused = f.feedLive && !f.wired
  const short = f.confirmedDepth !== undefined && f.confirmedDepth > 0 && f.confirmedDepth <= 5
  const [first, second] = f.wsLevels
  const shallow = first !== undefined && second !== undefined && first <= 5 && second <= 5
  return { downgraded: refused || short || shallow }
}
