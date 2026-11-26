import type { BrokerSession } from '~/core/services/connection'
import type { PollHealth } from './polling'
import type { FeedState } from './types'

/**
 * Whether market screens show stale-data styling (design 7.1, B11). A logged-out broker makes
 * every price stale. A live feed is fresh. Polling is fresh while its calls get replies (ruling
 * 8) and stale once they fail. While the socket is down or coming back, prices are fresh only
 * when polling is delivering them.
 */
export function pricesStale(feed: FeedState, broker: BrokerSession, poll: PollHealth): boolean {
  if (broker === 'logged_out') return true
  if (feed === 'live') return false
  if (feed === 'polling') return poll === 'failing'
  return poll !== 'ok'
}
