import { QueryClient } from '@tanstack/react-query'
import { createBookInvalidator } from './invalidate'
import { qk } from './keys'

const P = 'prof-a'

describe('createBookInvalidator', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const setup = () => {
    const qc = new QueryClient()
    const spy = jest.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    return { qc, spy }
  }

  it('turns five pokes within 300 ms into one invalidation at 500 ms', () => {
    const { qc, spy } = setup()
    const inv = createBookInvalidator(qc, P)
    for (let i = 0; i < 5; i++) {
      inv.poke()
      if (i < 4) jest.advanceTimersByTime(60)
    }
    // last poke at t=240; the debounce fires 500 ms after it
    jest.advanceTimersByTime(499)
    expect(spy).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey)
    expect(keys).toEqual([
      qk.orderbook(P),
      qk.tradebook(P),
      qk.positionbook(P),
      qk.holdings(P),
      qk.funds(P),
    ])
    jest.advanceTimersByTime(5000)
    expect(spy).toHaveBeenCalledTimes(5)
  })

  it('honours a custom debounce', () => {
    const { qc, spy } = setup()
    createBookInvalidator(qc, P, { debounceMs: 100 }).poke()
    jest.advanceTimersByTime(100)
    expect(spy).toHaveBeenCalled()
  })

  it('dispose cancels a pending invalidation', () => {
    const { qc, spy } = setup()
    const inv = createBookInvalidator(qc, P)
    inv.poke()
    inv.dispose()
    jest.advanceTimersByTime(2000)
    expect(spy).not.toHaveBeenCalled()
  })
})
