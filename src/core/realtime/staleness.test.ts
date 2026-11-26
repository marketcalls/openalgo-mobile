import type { BrokerSession } from '~/core/services/connection'
import type { PollHealth } from './polling'
import { pricesStale } from './staleness'
import type { FeedState } from './types'

describe('pricesStale', () => {
  test.each<[FeedState, PollHealth, boolean]>([
    // B11: a live feed is fresh, whatever polling does for the few symbols it carries
    ['live', 'none', false],
    ['live', 'failing', false],
    // ruling 8: polling prices are fresh while the polls work, and stale once they fail
    ['polling', 'none', false],
    ['polling', 'ok', false],
    ['polling', 'failing', true],
    // the socket is down or coming back: fresh only while polling delivers
    ['connecting', 'none', true],
    ['reconnecting', 'none', true],
    ['reconnecting', 'ok', false],
    ['reconnecting', 'failing', true],
    ['idle', 'none', true],
    ['stopped', 'failing', true],
    ['broker_logged_out', 'ok', false],
  ])('feed %s, polls %s: stale %s', (feed, poll, stale) => {
    expect(pricesStale(feed, 'active', poll)).toBe(stale)
  })

  test.each<FeedState>(['live', 'polling', 'reconnecting'])(
    'a logged-out broker is stale even with the feed %s (design 7.1)',
    (feed) => {
      expect(pricesStale(feed, 'logged_out' as BrokerSession, 'ok')).toBe(true)
    },
  )
})
