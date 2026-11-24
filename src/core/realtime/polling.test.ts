import { isExchangeOpen } from './marketHours'
import { createPollingEngine, POLL_RATES, type PollConsumer } from './polling'
import { createTickStore } from './tickStore'

// A manual clock: timers fire in order as time advances, and `now` follows it.
// 2025-01-06 is a Monday; 04:00 UTC is 09:30 IST, inside the NSE session.
const OPEN = Date.UTC(2025, 0, 6, 4, 0, 0)
const CLOSED = Date.UTC(2025, 0, 6, 14, 0, 0) // 19:30 IST
const SATURDAY_10_IST = Date.UTC(2025, 0, 11, 4, 30, 0)

const setup = (
  o: {
    start?: number
    live?: (ex: string, sym: string) => boolean
    depthLive?: (ex: string, sym: string) => boolean
    network?: 'home' | 'tunnel'
    depth?: unknown
    /** Uses the app's real market hours instead of "NSE is open for the first hour". */
    realHours?: boolean
  } = {},
) => {
  let t = o.start ?? OPEN
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const setTimer = (fn: () => void, ms: number) => {
    const id = seq++
    timers.set(id, { at: t + ms, fn })
    return () => {
      timers.delete(id)
    }
  }
  const advance = async (ms: number) => {
    const end = t + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e
      if (!next) break
      timers.delete(next[0])
      t = Math.max(t, next[1].at)
      next[1].fn()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
    t = end
  }
  const calls: { id: string; body: Record<string, unknown> }[] = []
  const api = {
    call: jest.fn(async (id: string, body: Record<string, unknown>) => {
      calls.push({ id, body })
      if (id === 'depth') return o.depth
      const symbols = body.symbols as { symbol: string; exchange: string }[]
      return symbols.map((s) => ({ ...s, data: { ltp: 100 } }))
    }),
  }
  const store = createTickStore(() => {})
  const net = { v: o.network ?? 'home' }
  const engine = createPollingEngine({
    api: api as never,
    store,
    isLive: o.live ?? (() => false),
    ...(o.depthLive ? { isDepthLive: o.depthLive } : {}),
    network: () => net.v,
    now: () => t,
    setTimer,
    isExchangeOpen: o.realHours ? isExchangeOpen : (_ex, n) => n >= OPEN && n < OPEN + 3_600_000,
  })
  return { engine, store, api, calls, advance, net, timers }
}

const quotes = (...keys: string[]): PollConsumer => ({ kind: 'quotes', keys: () => keys })
const symbolsOf = (c: { body: Record<string, unknown> }) =>
  (c.body.symbols as { symbol: string; exchange: string }[]).map((s) => `${s.exchange}:${s.symbol}`)

describe('polling engine', () => {
  test('B1 merge: overlapping consumers make one deduplicated call per tick, stored as poll', async () => {
    const h = setup()
    h.engine.register(quotes('NSE:A', 'NSE:B'), true)
    h.engine.register(quotes('NSE:B', 'NSE:C'), true)
    await h.advance(2000)
    expect(h.calls).toHaveLength(1)
    expect(symbolsOf(h.calls[0] as never).sort()).toEqual(['NSE:A', 'NSE:B', 'NSE:C'])
    expect(h.store.get('NSE:B')?.ltp).toBe(100)
    expect(h.store.get('NSE:B')?.source).toBe('poll')
    await h.advance(2000)
    expect(h.calls).toHaveLength(2)
  })

  test('B1 batches of 100', async () => {
    const h = setup()
    h.engine.register(quotes(...Array.from({ length: 250 }, (_, i) => `NSE:S${i}`)), true)
    await h.advance(2000)
    expect(h.calls.map((c) => symbolsOf(c).length)).toEqual([100, 100, 50])
  })

  test('B2 live keys are skipped; all live means zero calls in 10 s', async () => {
    const h = setup({ live: (_e, s) => s !== 'B' })
    h.engine.register(quotes('NSE:A', 'NSE:B'), true)
    await h.advance(2000)
    expect(symbolsOf(h.calls[0] as never)).toEqual(['NSE:B'])
    const all = setup({ live: () => true })
    all.engine.register(quotes('NSE:A', 'NSE:B'), true)
    await all.advance(10_000)
    expect(all.calls).toHaveLength(0)
  })

  test('B3 rate: 2 s at home, 5 s on a tunnel, times 5 while every market is closed', async () => {
    expect(POLL_RATES.quotes).toEqual({ home: 2000, tunnel: 5000 })
    const home = setup()
    home.engine.register(quotes('NSE:A'), true)
    await home.advance(2000)
    expect(home.calls).toHaveLength(1)
    const tun = setup({ network: 'tunnel' })
    tun.engine.register(quotes('NSE:A'), true)
    await tun.advance(4999)
    expect(tun.calls).toHaveLength(0)
    await tun.advance(1)
    expect(tun.calls).toHaveLength(1)
    const off = setup({ start: CLOSED })
    off.engine.register(quotes('NSE:A'), true)
    await off.advance(9999)
    expect(off.calls).toHaveLength(0)
    await off.advance(1)
    expect(off.calls).toHaveLength(1)
  })

  test('B3 off hours with the real market hours: CRYPTO does not keep NSE polling fast', async () => {
    const nse = setup({ start: SATURDAY_10_IST, realHours: true })
    nse.engine.register(quotes('NSE:A', 'NSE:B'), true)
    await nse.advance(9999)
    expect(nse.calls).toHaveLength(0)
    await nse.advance(1)
    expect(nse.calls).toHaveLength(1)
    await nse.advance(60_000)
    expect(nse.calls).toHaveLength(7) // every 10 s, not every 2 s

    const depth = setup({ start: SATURDAY_10_IST, realHours: true, depth: { bids: [], asks: [] } })
    depth.engine.register({ kind: 'depth', key: () => 'NFO:X' }, true)
    await depth.advance(10_000)
    expect(depth.calls).toHaveLength(1)

    // with every key on the socket, the rate follows them all, so a drop is covered soon
    const live = { v: true }
    const open = setup({ live: () => live.v })
    open.engine.register(quotes('NSE:A'), true)
    await open.advance(2000)
    live.v = false
    await open.advance(2000)
    expect(open.calls).toHaveLength(1)

    // a polled CRYPTO key is open around the clock, so its call keeps the home rate
    const crypto = setup({ start: SATURDAY_10_IST, realHours: true })
    crypto.engine.register(quotes('NSE:A', 'CRYPTO:BTCUSDT'), true)
    await crypto.advance(2000)
    expect(crypto.calls).toHaveLength(1)
  })

  test('B4 inactive consumer or inactive app makes zero calls', async () => {
    const h = setup()
    h.engine.register(quotes('NSE:A'), false)
    await h.advance(20_000)
    expect(h.calls).toHaveLength(0)
    const a = setup()
    a.engine.register(quotes('NSE:A'), true)
    a.engine.setAppActive(false)
    await a.advance(20_000)
    expect(a.calls).toHaveLength(0)
    a.engine.setAppActive(true)
    await a.advance(2000)
    expect(a.calls).toHaveLength(1)
  })

  test('B4 an unregistered consumer stops', async () => {
    const h = setup()
    const off = h.engine.register(quotes('NSE:A'), true)
    await h.advance(2000)
    off()
    await h.advance(20_000)
    expect(h.calls).toHaveLength(1)
    expect(h.timers.size).toBe(0)
  })

  test('B5 depth: one call per consumer per tick, zero-price rows dropped', async () => {
    const levels = (n: number) =>
      Array.from({ length: 5 }, (_, i) => ({ price: i < n ? 100 - i : 0, quantity: 1 }))
    const h = setup({ depth: { ltp: 100, bids: levels(3), asks: levels(5) } })
    h.engine.register({ kind: 'depth', key: () => 'NSE:A' }, true)
    h.engine.register({ kind: 'depth', key: () => 'NSE:B' }, true)
    await h.advance(2000)
    expect(h.calls.map((c) => c.id)).toEqual(['depth', 'depth'])
    expect(h.calls.map((c) => c.body)).toEqual([
      { symbol: 'A', exchange: 'NSE' },
      { symbol: 'B', exchange: 'NSE' },
    ])
    const d = h.store.get('NSE:A')?.depth
    expect(d?.buy).toHaveLength(3)
    expect(d?.sell).toHaveLength(5)
    expect(h.store.get('NSE:A')?.source).toBe('poll')
  })

  test('depth asks isDepthLive: a live quote-only symbol still polls its depth', async () => {
    const book = {
      ltp: 100,
      bids: [{ price: 99, quantity: 1 }],
      asks: [{ price: 101, quantity: 1 }],
    }
    const depthLive = { v: false }
    const h = setup({ depth: book, live: () => true, depthLive: () => depthLive.v })
    h.engine.register(quotes('NSE:A'), true)
    h.engine.register({ kind: 'depth', key: () => 'NSE:A' }, true)
    await h.advance(2000)
    expect(h.calls.map((c) => c.id)).toEqual(['depth'])
    depthLive.v = true
    await h.advance(4000)
    expect(h.calls.map((c) => c.id)).toEqual(['depth'])
  })

  test('without isDepthLive, depth follows isLive', async () => {
    const h = setup({ depth: { ltp: 100, bids: [], asks: [] }, live: () => true })
    h.engine.register({ kind: 'depth', key: () => 'NSE:A' }, true)
    await h.advance(4000)
    expect(h.calls).toHaveLength(0)
  })

  test('B6 custom runs on its own interval', async () => {
    const h = setup()
    const run = jest.fn(async () => {})
    h.engine.register({ kind: 'custom', intervalMs: () => 7000, run }, true)
    await h.advance(6999)
    expect(run).not.toHaveBeenCalled()
    await h.advance(1)
    expect(run).toHaveBeenCalledTimes(1)
    await h.advance(14_000)
    expect(run).toHaveBeenCalledTimes(3)
    expect(h.calls).toHaveLength(0)
  })

  test('a failing call does not stop the loop', async () => {
    const h = setup()
    h.api.call.mockRejectedValueOnce(new Error('network'))
    h.engine.register(quotes('NSE:A'), true)
    await h.advance(4000)
    expect(h.api.call).toHaveBeenCalledTimes(2)
    expect(h.engine.stats().errors).toBe(1)
  })

  test('health: none before a call, ok after one, failing after a failed one, none once stopped', async () => {
    const h = setup()
    const heard: string[] = []
    h.engine.onHealth(() => heard.push(h.engine.health()))
    expect(h.engine.health()).toBe('none')
    const off = h.engine.register(quotes('NSE:A'), true)
    await h.advance(2000)
    expect(h.engine.health()).toBe('ok')
    h.api.call.mockRejectedValueOnce(new Error('network'))
    await h.advance(2000)
    expect(h.engine.health()).toBe('failing')
    await h.advance(2000)
    expect(h.engine.health()).toBe('ok')
    off()
    expect(h.engine.health()).toBe('none')
    expect(heard).toEqual(['ok', 'failing', 'ok', 'none'])
  })

  test('health: one failing price loop is enough; custom consumers do not count', async () => {
    const h = setup({ depth: { ltp: 1, bids: [], asks: [] } })
    h.engine.register(quotes('NSE:A'), true)
    h.engine.register({ kind: 'depth', key: () => 'NSE:B' }, true)
    h.engine.register(
      { kind: 'custom', intervalMs: () => 1000, run: () => Promise.reject(new Error('x')) },
      true,
    )
    h.api.call.mockImplementation(async (id: string) => {
      if (id === 'depth') throw new Error('network')
      return [{ symbol: 'A', exchange: 'NSE', data: { ltp: 1 } }]
    })
    await h.advance(2000)
    expect(h.engine.health()).toBe('failing')
  })

  test('health: a call still out after 3 intervals counts as failing', async () => {
    const h = setup()
    h.api.call.mockImplementationOnce(() => new Promise(() => {}))
    h.engine.register(quotes('NSE:A'), true)
    await h.advance(2000) // the call goes out and never comes back
    await h.advance(5999)
    expect(h.engine.health()).toBe('none')
    await h.advance(1)
    expect(h.engine.health()).toBe('failing')
  })

  test('health: nothing to poll (every key live) is no claim either way', async () => {
    const live = { v: false }
    const h = setup({ live: () => live.v })
    h.engine.register(quotes('NSE:A'), true)
    await h.advance(2000)
    expect(h.engine.health()).toBe('ok')
    live.v = true
    await h.advance(2000)
    expect(h.engine.health()).toBe('none')
  })

  test('stop then restart while a step is in flight leaves exactly one loop', async () => {
    const h = setup()
    let release: () => void = () => {}
    h.api.call.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = () => res([{ symbol: 'A', exchange: 'NSE', data: { ltp: 1 } }] as never)
        }),
    )
    h.engine.register(quotes('NSE:A'), true)
    await h.advance(2000) // step now awaiting
    h.engine.setAppActive(false)
    h.engine.setAppActive(true) // new loop for 'quotes'
    release()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(h.engine.stats().loops).toBe(1)
    expect(h.timers.size).toBe(1)
    const before = h.calls.length
    await h.advance(2000)
    expect(h.calls.length - before).toBe(1)
  })

  test('function-form active: inactive consumers stop polling and active ones start', async () => {
    const h = setup()
    const flag = { on: true }
    const run = jest.fn(async () => {})
    h.engine.register({ kind: 'custom', intervalMs: () => 1000, run }, () => flag.on)
    h.engine.register({ kind: 'depth', key: () => 'NSE:A' }, () => flag.on)
    await h.advance(2000)
    expect(run).toHaveBeenCalledTimes(2)
    const depthCalls = h.calls.filter((c) => c.id === 'depth').length
    expect(depthCalls).toBeGreaterThan(0)
    flag.on = false
    await h.advance(3000)
    expect(run.mock.calls.length).toBeLessThanOrEqual(3)
    const settled = run.mock.calls.length
    const depthSettled = h.calls.filter((c) => c.id === 'depth').length
    await h.advance(5000)
    expect(run).toHaveBeenCalledTimes(settled)
    expect(h.calls.filter((c) => c.id === 'depth').length).toBe(depthSettled)
    expect(h.engine.stats().loops).toBe(0)
    flag.on = true
    await h.advance(3000)
    expect(run.mock.calls.length).toBeGreaterThan(settled)
  })
})
