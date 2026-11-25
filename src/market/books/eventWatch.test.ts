import { createEventWatch } from './eventWatch'
import { bookPollMs, streamLive } from './policy'

const T0 = Date.UTC(2026, 10, 24, 4, 0) // 09:30 IST, a Tuesday

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  jest.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

const watch = (timeoutMs?: number) =>
  createEventWatch({ now: () => Date.now(), setTimer: fakeTimer, timeoutMs })

/** setTimeout behind the SetTimer shape, so jest's fake clock drives it. */
const fakeTimer = (fn: () => void, ms: number) => {
  const h = setTimeout(fn, ms)
  return () => clearTimeout(h)
}

/** Zerodha with the stream live and an order working, as the Orders tab would ask. */
const workingRate = (demoted: boolean) =>
  bookPollMs({
    streamLive: streamLive('live', true),
    broker: 'zerodha',
    analyzer: 'live',
    anyWorking: true,
    marketOpen: true,
    demoted,
  })

describe('createEventWatch (RF 3)', () => {
  test('zerodha, stream live: expect("A1") and no event for 10 s → demoted; a working book polls at 5000', () => {
    const w = watch()
    expect(workingRate(w.demoted())).toBe(30_000)
    w.expect('A1')
    jest.advanceTimersByTime(9_999)
    expect(w.demoted()).toBe(false)
    jest.advanceTimersByTime(1)
    expect(w.demoted()).toBe(true)
    expect(workingRate(w.demoted())).toBe(5000)
  })

  test('an event at 3 s → not demoted', () => {
    const w = watch()
    w.expect('A1')
    jest.advanceTimersByTime(3000)
    w.seen('A1')
    jest.advanceTimersByTime(60_000)
    expect(w.demoted()).toBe(false)
    expect(workingRate(w.demoted())).toBe(30_000)
  })

  test('an event for another order does not meet the expectation', () => {
    const w = watch()
    w.expect('A1')
    jest.advanceTimersByTime(3000)
    w.seen('B2')
    jest.advanceTimersByTime(7000)
    expect(w.demoted()).toBe(true)
  })

  test('ruling 12: seen("A1") then expect("A1") is met at once (the event beat the reply)', () => {
    const w = watch()
    w.seen('A1')
    jest.advanceTimersByTime(500)
    w.expect('A1')
    jest.advanceTimersByTime(60_000)
    expect(w.demoted()).toBe(false)
  })

  test('a seen id is kept for 60 s, not longer', () => {
    const w = watch()
    w.seen('A1')
    jest.advanceTimersByTime(60_001)
    w.expect('A1')
    jest.advanceTimersByTime(10_000)
    expect(w.demoted()).toBe(true)
  })

  test('demotion lasts for the session: later events do not lift it; reset does', () => {
    const w = watch()
    w.expect('A1')
    jest.advanceTimersByTime(10_000)
    w.seen('A1')
    w.seen('A2')
    expect(w.demoted()).toBe(true)
    w.reset()
    expect(w.demoted()).toBe(false)
  })

  test('reset drops pending expectations and seen ids', () => {
    const w = watch()
    w.seen('A1')
    w.expect('B2')
    w.reset()
    jest.advanceTimersByTime(10_000)
    expect(w.demoted()).toBe(false) // B2's wait was cancelled
    w.expect('A1')
    jest.advanceTimersByTime(10_000)
    expect(w.demoted()).toBe(true) // A1 was forgotten
  })

  test('expecting the same id again keeps the first wait; the timeout is configurable', () => {
    const w = watch(1000)
    w.expect('A1')
    jest.advanceTimersByTime(600)
    w.expect('A1')
    jest.advanceTimersByTime(400)
    expect(w.demoted()).toBe(true)
  })

  test('two orders: one that gets its event and one that does not still demotes', () => {
    const w = watch()
    w.expect('A1')
    w.expect('A2')
    jest.advanceTimersByTime(2000)
    w.seen('A1')
    jest.advanceTimersByTime(8000)
    expect(w.demoted()).toBe(true)
  })
})
