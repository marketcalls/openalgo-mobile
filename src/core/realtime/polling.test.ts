import { createPollingEngine, POLL_RATES, type PollConsumer } from './polling'
import { createTickStore } from './tickStore'

// A manual clock: timers fire in order as time advances, and `now` follows it.
// 2025-01-06 is a Monday; 04:00 UTC is 09:30 IST, inside the NSE session.
const OPEN = Date.UTC(2025, 0, 6, 4, 0, 0)
const CLOSED = Date.UTC(2025, 0, 6, 14, 0, 0) // 19:30 IST

const setup = (
  o: {
    start?: number
    live?: (ex: string, sym: string) => boolean
    network?: 'home' | 'tunnel'
    depth?: unknown
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
    network: () => net.v,
    now: () => t,
    setTimer,
    isAnyMarketOpen: (n) => n === OPEN || (n > OPEN && n < OPEN + 3_600_000),
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
