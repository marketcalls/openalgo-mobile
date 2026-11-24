import type { DepthLevels, Mode } from './protocol'
import { createSubscriptionManager, type SubAck, type SubRequest } from './subscriptions'

const req = (symbol: string, mode: Mode, depth?: DepthLevels): SubRequest => ({
  exchange: 'NSE',
  symbol,
  mode,
  ...(depth !== undefined ? { depth } : {}),
})

const sub = (symbols: string[], mode: Mode, depth?: DepthLevels) => ({
  action: 'subscribe',
  symbols: symbols.map((symbol) => ({ symbol, exchange: 'NSE' })),
  mode,
  ...(mode === 3 ? { depth } : {}),
})

const unsub = (symbols: string[], mode: Mode) => ({
  action: 'unsubscribe',
  symbols: symbols.map((symbol) => ({ symbol, exchange: 'NSE', mode })),
  mode,
})

const ack = (...entries: [symbol: string, ok: boolean, depth?: number][]): SubAck => ({
  t: 'sub_ack',
  entries: entries.map(([symbol, ok, depth]) => ({
    symbol,
    exchange: 'NSE',
    ok,
    ...(depth !== undefined ? { depth } : {}),
  })),
})

const flush = () => jest.advanceTimersByTime(100)

/** A manager whose socket has authenticated (`resendAll` is what the client calls on auth_ok). */
const setup = (opts: { budget?: number } = {}) => {
  const sent: unknown[] = []
  const onDowngrade = jest.fn()
  const m = createSubscriptionManager({
    send: (frame) => sent.push(JSON.parse(frame)),
    onDowngrade,
    ...opts,
  })
  m.resendAll()
  return { m, sent, onDowngrade }
}

describe('createSubscriptionManager', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('B1 refcount: two acquires send one subscribe; the second release unsubscribes with a numeric mode', () => {
    const { m, sent } = setup()
    const first = m.acquire(req('RELIANCE', 2))
    const second = m.acquire(req('RELIANCE', 2))
    flush()
    expect(sent).toEqual([sub(['RELIANCE'], 2)])

    sent.length = 0
    first()
    flush()
    expect(sent).toEqual([])
    first() // a release runs once, however often it is called
    flush()
    expect(sent).toEqual([])

    second()
    flush()
    expect(sent).toEqual([unsub(['RELIANCE'], 2)])
    expect(m.effective()).toEqual([])
  })

  test('B1 the effective subscription is the highest mode, and for mode 3 the highest depth', () => {
    const { m, sent } = setup()
    m.acquire(req('RELIANCE', 1))
    m.acquire(req('RELIANCE', 2))
    m.acquire(req('TCS', 3, 20))
    m.acquire(req('TCS', 3)) // depth defaults to 5
    m.acquire(req('TCS', 2))
    m.acquire(req('INFY', 1, 20)) // depth means nothing below mode 3
    flush()
    expect(m.effective()).toEqual([
      { exchange: 'NSE', symbol: 'RELIANCE', mode: 2 },
      { exchange: 'NSE', symbol: 'TCS', mode: 3, depth: 20 },
      { exchange: 'NSE', symbol: 'INFY', mode: 1 },
    ])
    expect(sent).toEqual([sub(['RELIANCE'], 2), sub(['TCS'], 3, 20), sub(['INFY'], 1)])
  })

  test('B2 the flush is debounced by 100 ms after the last change', () => {
    const { m, sent } = setup()
    m.acquire(req('RELIANCE', 1))
    jest.advanceTimersByTime(60)
    m.acquire(req('TCS', 1))
    jest.advanceTimersByTime(99)
    expect(sent).toEqual([])
    jest.advanceTimersByTime(1)
    expect(sent).toEqual([sub(['RELIANCE', 'TCS'], 1)])
  })

  test('B2 a changed symbol gets the old unsubscribe, then the new subscribe: LTP then Depth', () => {
    const { m, sent } = setup()
    m.acquire(req('RELIANCE', 1))
    flush()
    sent.length = 0
    m.acquire(req('RELIANCE', 3))
    flush()
    expect(sent).toEqual([unsub(['RELIANCE'], 1), sub(['RELIANCE'], 3, 5)])
  })

  test('B2 all unsubscribes go before any subscribe, one message per (mode, depth)', () => {
    const { m, sent } = setup()
    const held = [
      m.acquire(req('A', 1)),
      m.acquire(req('B', 2)),
      m.acquire(req('C', 3)),
      m.acquire(req('D', 3, 20)),
      m.acquire(req('E', 1)),
    ]
    m.acquire(req('K', 1))
    flush()
    sent.length = 0

    for (const release of held) release()
    m.acquire(req('K', 2)) // K moves from LTP to Quote
    m.acquire(req('F', 1))
    m.acquire(req('G', 2))
    m.acquire(req('H', 3))
    m.acquire(req('I', 3, 20))
    m.acquire(req('J', 2))
    flush()
    expect(sent).toEqual([
      // an unsubscribe carries no depth, so C (5) and D (20) share one
      unsub(['A', 'E', 'K'], 1),
      unsub(['B'], 2),
      unsub(['C', 'D'], 3),
      sub(['K', 'G', 'J'], 2),
      sub(['F'], 1),
      sub(['H'], 3, 5),
      sub(['I'], 3, 20),
    ])
  })

  test('B2 an acquire and release in the same window send nothing', () => {
    const { m, sent } = setup()
    m.acquire(req('RELIANCE', 1))()
    flush()
    expect(sent).toEqual([])

    const quote = m.acquire(req('TCS', 2))
    flush()
    sent.length = 0
    quote()
    m.acquire(req('TCS', 2))
    flush()
    expect(sent).toEqual([])
  })

  test('B2 honours debounceMs and an injected setTimer', () => {
    const sent: string[] = []
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = []
    const m = createSubscriptionManager({
      send: (f) => sent.push(f),
      debounceMs: 250,
      setTimer: (fn, ms) => {
        const t = { fn, ms, cancelled: false }
        timers.push(t)
        return () => {
          t.cancelled = true
        }
      },
    })
    m.resendAll()
    m.acquire(req('RELIANCE', 1))
    m.acquire(req('TCS', 1))
    expect(timers.map((t) => [t.ms, t.cancelled])).toEqual([
      [250, true],
      [250, false],
    ])
    timers[1]?.fn()
    expect(sent).toHaveLength(1)
  })

  test('B3 depth change: holding 5 and 20 subscribes at 20; releasing the 20 resubscribes at 5', () => {
    const { m, sent, onDowngrade } = setup()
    m.acquire(req('RELIANCE', 3, 5))
    const deep = m.acquire(req('RELIANCE', 3, 20))
    flush()
    expect(sent).toEqual([sub(['RELIANCE'], 3, 20)])

    sent.length = 0
    deep()
    flush()
    expect(sent).toEqual([unsub(['RELIANCE'], 3), sub(['RELIANCE'], 3, 5)])
    expect(onDowngrade).not.toHaveBeenCalled()
  })

  test('B4 leaving mode 3 calls onDowngrade(key)', () => {
    const { m, onDowngrade } = setup()
    const quote = m.acquire(req('RELIANCE', 2))
    const depth = m.acquire(req('RELIANCE', 3))
    const depthAgain = m.acquire(req('RELIANCE', 3))
    quote() // still Depth
    depth() // still Depth
    expect(onDowngrade).not.toHaveBeenCalled()

    m.acquire(req('RELIANCE', 1))
    depthAgain() // Depth to LTP
    expect(onDowngrade).toHaveBeenCalledTimes(1)
    expect(onDowngrade).toHaveBeenCalledWith('NSE:RELIANCE')

    m.acquire(req('TCS', 3, 20))() // a full release leaves mode 3 too
    expect(onDowngrade).toHaveBeenLastCalledWith('NSE:TCS')
    expect(onDowngrade).toHaveBeenCalledTimes(2)
  })

  test('B5 budget: the 501st symbol waits in FIFO order, and a release promotes it', () => {
    const { m, sent } = setup()
    const names = Array.from({ length: 500 }, (_, i) => `S${i}`)
    const held = names.map((s) => m.acquire(req(s, 1)))
    m.acquire(req('S500', 1))
    const last = m.acquire(req('S501', 1))
    flush()
    expect(sent).toEqual([sub(names, 1)])
    expect(m.effective()).toHaveLength(500)
    expect(m.waiting()).toEqual(['NSE:S500', 'NSE:S501'])
    expect(m.isWired('NSE', 'S500')).toBe(false)

    sent.length = 0
    m.acquire(req('S0', 2)) // a symbol already in the budget takes no new slot
    expect(m.waiting()).toEqual(['NSE:S500', 'NSE:S501'])
    held[1]?.()
    expect(m.waiting()).toEqual(['NSE:S501'])
    flush()
    expect(sent).toEqual([unsub(['S0', 'S1'], 1), sub(['S0'], 2), sub(['S500'], 1)])
    expect(m.isWired('NSE', 'S500')).toBe(true)

    sent.length = 0
    last() // a waiting symbol leaves the queue and is never sent
    expect(m.waiting()).toEqual([])
    held[2]?.()
    flush()
    expect(sent).toEqual([unsub(['S2'], 1)])
    expect(m.effective()).toHaveLength(499)
  })

  test('B6 confirmedDepth is the smaller of the ack depth and the most priced levels in one tick', () => {
    const { m } = setup()
    m.acquire(req('RELIANCE', 3, 20))
    m.acquire(req('INFY', 3, 20))
    m.acquire(req('TCS', 3, 20))
    flush()
    m.onAck(ack(['RELIANCE', true, 20], ['INFY', true, 20]))
    expect(m.confirmedDepth('NSE', 'RELIANCE')).toBeUndefined() // until the first depth tick

    m.noteDepthLevels('NSE', 'RELIANCE', 20)
    for (const n of [3, 5, 4]) m.noteDepthLevels('NSE', 'INFY', n)
    m.noteDepthLevels('NSE', 'TCS', 30) // no ack yet: the requested depth stands in
    expect(m.confirmedDepth('NSE', 'RELIANCE')).toBe(20)
    expect(m.confirmedDepth('NSE', 'INFY')).toBe(5)
    expect(m.confirmedDepth('NSE', 'TCS')).toBe(20)
  })

  test('B6 both reset when the depth changes or the connection drops', () => {
    const { m } = setup()
    m.acquire(req('RELIANCE', 3, 5))
    const deep = m.acquire(req('RELIANCE', 3, 20))
    flush()
    m.onAck(ack(['RELIANCE', true, 20]))
    m.noteDepthLevels('NSE', 'RELIANCE', 20)
    expect(m.confirmedDepth('NSE', 'RELIANCE')).toBe(20)

    deep()
    flush()
    expect(m.confirmedDepth('NSE', 'RELIANCE')).toBeUndefined()
    m.onAck(ack(['RELIANCE', true, 5]))
    m.noteDepthLevels('NSE', 'RELIANCE', 5)
    expect(m.confirmedDepth('NSE', 'RELIANCE')).toBe(5)

    m.connectionLost()
    m.resendAll()
    expect(m.confirmedDepth('NSE', 'RELIANCE')).toBeUndefined()
    m.noteDepthLevels('NSE', 'RELIANCE', 2)
    expect(m.confirmedDepth('NSE', 'RELIANCE')).toBe(2)
  })

  test('B6 levels and acks count only for a symbol on the wire at mode 3', () => {
    const { m } = setup()
    m.acquire(req('RELIANCE', 2))
    flush()
    m.onAck(ack(['RELIANCE', true, 5], ['UNKNOWN', true, 20]))
    m.noteDepthLevels('NSE', 'RELIANCE', 5)
    m.noteDepthLevels('NSE', 'UNKNOWN', 5)
    expect(m.confirmedDepth('NSE', 'RELIANCE')).toBeUndefined()
    expect(m.confirmedDepth('NSE', 'UNKNOWN')).toBeUndefined()
    expect(m.isWired('NSE', 'UNKNOWN')).toBe(false)
  })

  test('B6 a failed entry is marked not wired', () => {
    const { m, sent } = setup()
    m.acquire(req('RELIANCE', 2))
    m.acquire(req('BAD', 2))
    expect(m.isWired('NSE', 'RELIANCE')).toBe(false) // not sent yet
    flush()
    expect(m.isWired('NSE', 'RELIANCE')).toBe(true)
    expect(m.isWired('NSE', 'BAD')).toBe(true)

    m.onAck(ack(['RELIANCE', true], ['BAD', false]))
    expect(m.isWired('NSE', 'RELIANCE')).toBe(true)
    expect(m.isWired('NSE', 'BAD')).toBe(false)

    sent.length = 0
    m.acquire(req('TCS', 2))
    flush()
    expect(sent).toEqual([sub(['TCS'], 2)]) // the failed entry is not retried on every flush
  })

  test('B7 reconnect: connectionLost clears the wire state; resendAll resubscribes everything', () => {
    const sent: unknown[] = []
    const m = createSubscriptionManager({ send: (f) => sent.push(JSON.parse(f)) })
    const ltp = m.acquire(req('RELIANCE', 1))
    m.acquire(req('TCS', 3, 20))
    flush()
    expect(sent).toEqual([]) // the socket has not authenticated yet

    m.resendAll()
    expect(sent).toEqual([sub(['RELIANCE'], 1), sub(['TCS'], 3, 20)]) // at once
    m.onAck(ack(['RELIANCE', false], ['TCS', true, 20]))
    m.noteDepthLevels('NSE', 'TCS', 20)
    expect(m.isWired('NSE', 'TCS')).toBe(true)

    sent.length = 0
    m.acquire(req('WIPRO', 1)) // pending when the socket drops: never sent on the dead socket
    m.connectionLost()
    flush()
    expect(sent).toEqual([])
    expect(m.isWired('NSE', 'TCS')).toBe(false)
    expect(m.confirmedDepth('NSE', 'TCS')).toBeUndefined()
    ltp()
    m.acquire(req('INFY', 2))
    flush()
    expect(sent).toEqual([]) // the wire is down: nothing to unsubscribe, nothing sent

    m.resendAll()
    expect(sent).toEqual([sub(['TCS'], 3, 20), sub(['WIPRO'], 1), sub(['INFY'], 2)])
    expect(m.isWired('NSE', 'INFY')).toBe(true)

    sent.length = 0
    m.acquire(req('SBIN', 1))
    m.resendAll() // a pending flush is folded into the resend
    flush()
    expect(sent).toEqual([sub(['TCS'], 3, 20), sub(['WIPRO', 'SBIN'], 1), sub(['INFY'], 2)])
  })
})
