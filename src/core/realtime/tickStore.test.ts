import { createTickStore } from './tickStore'

const manual = () => {
  let pending: (() => void) | null = null
  return {
    schedule: (fn: () => void) => {
      pending = fn
    },
    flush: () => {
      const f = pending
      pending = null
      f?.()
    },
  }
}

describe('tick store', () => {
  test('put merges fields but replaces depth whole; dropDepth removes only depth', () => {
    const s = createTickStore(manual().schedule)
    s.put(
      'NSE:A',
      { ltp: 10, close: 8, depth: { buy: [{ price: 1, quantity: 1 }], sell: [], levels: 1 } },
      'ws',
    )
    s.put(
      'NSE:A',
      { volume: 5, depth: { buy: [{ price: 2, quantity: 2 }], sell: [], levels: 1 } },
      'ws',
    )
    const q = s.get('NSE:A')
    expect(q).toMatchObject({ ltp: 10, close: 8, volume: 5, source: 'ws' })
    expect(q?.depth?.buy).toEqual([{ price: 2, quantity: 2 }])
    s.dropDepth('NSE:A')
    expect(s.get('NSE:A')?.depth).toBeUndefined()
    expect(s.get('NSE:A')?.ltp).toBe(10)
  })

  test('change and direction', () => {
    const s = createTickStore(manual().schedule)
    s.put('k', { ltp: 10 }, 'ws')
    expect(s.get('k')?.change).toBeUndefined()
    expect(s.get('k')?.dir).toBe(0)
    s.put('k', { close: 8 }, 'ws')
    expect(s.get('k')).toMatchObject({ change: 2, changePct: 25 })
    s.put('k', { ltp: 9 }, 'ws')
    expect(s.get('k')?.dir).toBe(-1)
    s.put('k', { ltp: 11 }, 'ws')
    expect(s.get('k')?.dir).toBe(1)
    s.put('k', { volume: 1 }, 'ws')
    expect(s.get('k')?.dir).toBe(1)
    s.put('z', { ltp: 5, close: 0 }, 'ws')
    expect(s.get('z')?.change).toBeUndefined()
  })

  test('100 puts on 3 keys give one call per key per flush', () => {
    const m = manual()
    const s = createTickStore(m.schedule)
    const fns = ['a', 'b', 'c'].map(() => jest.fn())
    const keys = ['a', 'b', 'c']
    for (const [i, k] of keys.entries()) s.subscribe(k, fns[i] as () => void)
    for (let i = 0; i < 100; i++) s.put(keys[i % 3] as string, { ltp: i + 1 }, 'ws')
    for (const f of fns) expect(f).not.toHaveBeenCalled()
    m.flush()
    for (const f of fns) expect(f).toHaveBeenCalledTimes(1)
    expect(s.stats()).toMatchObject({ ticksIn: 100, flushes: 1, keysPublished: 3 })
    m.flush()
    for (const f of fns) expect(f).toHaveBeenCalledTimes(1)
  })

  test('a seed never overwrites newer data, a put always overwrites a seed', () => {
    const s = createTickStore(manual().schedule)
    s.seed('k', { ltp: 1 }, 1000)
    expect(s.get('k')).toMatchObject({ ltp: 1, ts: 1000, source: 'seed' })
    s.seed('k', { ltp: 2 }, 900)
    expect(s.get('k')?.ltp).toBe(1)
    s.seed('k', { ltp: 3 }, 2000)
    expect(s.get('k')?.ltp).toBe(3)
    s.put('k', { ltp: 4 }, 'poll')
    expect(s.get('k')).toMatchObject({ ltp: 4, source: 'poll' })
    s.seed('k', { ltp: 5 }, 1)
    expect(s.get('k')?.ltp).toBe(4)
    const far = Date.now() + 10_000
    s.seed('k', { ltp: 6 }, far - 20_000)
    expect(s.get('k')?.ltp).toBe(4)
  })

  describe('eviction', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    test('evicted 60 s after the last unsubscribe', () => {
      const s = createTickStore(manual().schedule)
      s.put('k', { ltp: 1 }, 'ws')
      const off = s.subscribe('k', () => {})
      const off2 = s.subscribe('k', () => {})
      off()
      jest.advanceTimersByTime(61_000)
      expect(s.get('k')).toBeDefined() // one subscriber left
      off2()
      jest.advanceTimersByTime(59_999)
      expect(s.get('k')).toBeDefined()
      jest.advanceTimersByTime(1)
      expect(s.get('k')).toBeUndefined()
    })

    test('not evicted when resubscribed in time', () => {
      const s = createTickStore(manual().schedule)
      s.put('k', { ltp: 1 }, 'ws')
      s.subscribe('k', () => {})()
      jest.advanceTimersByTime(30_000)
      s.subscribe('k', () => {})
      jest.advanceTimersByTime(120_000)
      expect(s.get('k')?.ltp).toBe(1)
    })

    test('evictAfterMs is configurable', () => {
      const s = createTickStore(manual().schedule, { evictAfterMs: 1000 })
      s.put('k', { ltp: 1 }, 'ws')
      s.subscribe('k', () => {})()
      jest.advanceTimersByTime(1000)
      expect(s.get('k')).toBeUndefined()
    })
  })

  test('stale flag notifies only on change', () => {
    const s = createTickStore(manual().schedule)
    const fn = jest.fn()
    const off = s.subscribeStale(fn)
    expect(s.isStale()).toBe(false)
    s.setStale(true)
    s.setStale(true)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(s.isStale()).toBe(true)
    off()
    s.setStale(false)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('lastWsTickAt moves on ws puts only; reset clears', () => {
    const s = createTickStore(manual().schedule)
    expect(s.lastWsTickAt()).toBe(0)
    s.put('k', { ltp: 1 }, 'poll')
    expect(s.lastWsTickAt()).toBe(0)
    s.put('k', { ltp: 1 }, 'ws')
    expect(s.lastWsTickAt()).toBeGreaterThan(0)
    s.reset()
    expect(s.get('k')).toBeUndefined()
    expect(s.lastWsTickAt()).toBe(0)
  })
})
