import {
  bookPollMs,
  booksMarketOpen,
  hasOrderEvents,
  isEvented,
  NO_ORDER_EVENT_BROKERS,
  ORDER_EVENT_BROKERS,
  streamLive,
} from './policy'

// Contract C7 (services/order_update_service.py), written out here so a change to the lists
// is a change to this test.
const PUSHED = [
  'aliceblue',
  'angel',
  'arrow',
  'definedge',
  'dhan',
  'flattrade',
  'fyers',
  'groww',
  'iiflcapital',
  'indmoney',
  'kotak',
  'motilal',
  'nubra',
  'nuvama',
  'pocketful',
  'sahi',
  'shoonya',
  'tradejini',
  'tradesmart',
  'upstox',
  'zebu',
  'zerodha',
]
const SERVER_POLLED = ['fivepaisa', 'samco']
const NONE = [
  'compositedge',
  'deltaexchange',
  'dhan_sandbox',
  'firstock',
  'fivepaisaxts',
  'hdfcsecurities',
  'hdfcsky',
  'ibulls',
  'iifl',
  'jainamxts',
  'mstock',
  'paytm',
  'rmoney',
  'rupeezy',
  'wisdom',
]

// A Tuesday. 04:00 UTC is 09:30 IST (NSE open); 11:00 UTC is 16:30 IST (NSE shut, MCX open).
const NSE_OPEN = Date.UTC(2026, 10, 24, 4, 0)
const EVENING = Date.UTC(2026, 10, 24, 11, 0)

describe('the C7 broker lists', () => {
  test('22 push and 2 server-polled brokers have events, 15 have none: 39 names, no overlap', () => {
    expect(PUSHED).toHaveLength(22)
    expect(SERVER_POLLED).toHaveLength(2)
    expect(NONE).toHaveLength(15)
    expect([...ORDER_EVENT_BROKERS].sort()).toEqual([...PUSHED, ...SERVER_POLLED].sort())
    expect([...NO_ORDER_EVENT_BROKERS].sort()).toEqual([...NONE].sort())
    const all = new Set([...ORDER_EVENT_BROKERS, ...NO_ORDER_EVENT_BROKERS])
    expect(all.size).toBe(39)
  })

  test('hasOrderEvents: the listed brokers have them; the rest, unknown ones and null do not', () => {
    for (const b of [...PUSHED, ...SERVER_POLLED]) expect(hasOrderEvents(b)).toBe(true)
    for (const b of NONE) expect(hasOrderEvents(b)).toBe(false)
    expect(hasOrderEvents('newbroker')).toBe(false)
    expect(hasOrderEvents(null)).toBe(false)
  })
})

describe('streamLive', () => {
  test('only a live feed that acknowledged subscribe_orders carries order events', () => {
    expect(streamLive('live', true)).toBe(true)
    expect(streamLive('live', false)).toBe(false)
    expect(streamLive('live', null)).toBe(false)
    expect(streamLive('polling', true)).toBe(false)
    expect(streamLive('reconnecting', true)).toBe(false)
  })
})

describe('isEvented', () => {
  const base = { streamLive: true, broker: 'zerodha', analyzer: 'live', demoted: false } as const
  test('a live stream from a broker with events, or in analyzer mode, until demoted', () => {
    expect(isEvented(base)).toBe(true)
    expect(isEvented({ ...base, demoted: true })).toBe(false)
    expect(isEvented({ ...base, streamLive: false })).toBe(false)
    expect(isEvented({ ...base, broker: 'ibulls' })).toBe(false)
    expect(isEvented({ ...base, broker: 'ibulls', analyzer: 'analyze' })).toBe(true)
    expect(isEvented({ ...base, broker: null, analyzer: 'unknown' })).toBe(false)
  })
})

describe('bookPollMs', () => {
  const open = { analyzer: 'live', marketOpen: true, demoted: false } as const
  const live = streamLive('live', true)

  test('zerodha with the stream live, idle → 30000', () => {
    expect(bookPollMs({ ...open, streamLive: live, broker: 'zerodha', anyWorking: false })).toBe(
      30_000,
    )
  })

  test('zerodha with the stream live polls at 30000 even with orders working', () => {
    expect(bookPollMs({ ...open, streamLive: live, broker: 'zerodha', anyWorking: true })).toBe(
      30_000,
    )
  })

  test('ibulls (no events): working → 5000, idle → 30000', () => {
    expect(bookPollMs({ ...open, streamLive: live, broker: 'ibulls', anyWorking: true })).toBe(5000)
    expect(bookPollMs({ ...open, streamLive: live, broker: 'ibulls', anyWorking: false })).toBe(
      30_000,
    )
  })

  test('zerodha with orderStream false (a server before 2.0.1.6), working → 5000', () => {
    const s = streamLive('live', false)
    expect(bookPollMs({ ...open, streamLive: s, broker: 'zerodha', anyWorking: true })).toBe(5000)
  })

  test('ibulls in analyzer mode with the stream live → 30000 (the sandbox emits events)', () => {
    expect(
      bookPollMs({
        ...open,
        analyzer: 'analyze',
        streamLive: live,
        broker: 'ibulls',
        anyWorking: true,
      }),
    ).toBe(30_000)
  })

  test('polling mode, working → 5000', () => {
    const s = streamLive('polling', true)
    expect(bookPollMs({ ...open, streamLive: s, broker: 'zerodha', anyWorking: true })).toBe(5000)
  })

  test('an unknown broker counts as having no events: newbroker, working → 5000', () => {
    expect(bookPollMs({ ...open, streamLive: live, broker: 'newbroker', anyWorking: true })).toBe(
      5000,
    )
  })

  test('demoted, a working book polls at 5000 (RF 3)', () => {
    expect(
      bookPollMs({ ...open, streamLive: live, broker: 'zerodha', anyWorking: true, demoted: true }),
    ).toBe(5000)
  })

  test('market closed → ×5', () => {
    const closed = { ...open, marketOpen: false }
    expect(bookPollMs({ ...closed, streamLive: live, broker: 'zerodha', anyWorking: false })).toBe(
      150_000,
    )
    expect(bookPollMs({ ...closed, streamLive: live, broker: 'ibulls', anyWorking: true })).toBe(
      25_000,
    )
  })
})

describe('booksMarketOpen', () => {
  const row = (exchange: string, status: string) => ({ exchange, status })

  test("a working order's market decides: an NSE order waiting at 16:30 IST is off-hours", () => {
    const orders = [row('NSE', 'open'), row('MCX', 'complete')]
    expect(booksMarketOpen(orders, NSE_OPEN)).toBe(true)
    expect(booksMarketOpen(orders, EVENING)).toBe(false)
  })

  test('with nothing working, any market of the day’s orders', () => {
    const orders = [row('NSE', 'complete'), row('MCX', 'cancelled')]
    expect(booksMarketOpen(orders, EVENING)).toBe(true)
    expect(booksMarketOpen([row('NSE', 'complete')], EVENING)).toBe(false)
  })

  test('with no orders, any market at all', () => {
    expect(booksMarketOpen([], NSE_OPEN)).toBe(true)
  })
})
