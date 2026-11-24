import { act, render } from '@testing-library/react-native'
import { Text } from 'react-native'
import { createPollingEngine } from './polling'
import { createSubscriptionManager } from './subscriptions'
import { createTickStore } from './tickStore'
import { LiveContext, type LiveServices, useLiveDepth, useLiveQuote } from './useLive'
import { useScreenActive } from './useScreenActive'

jest.mock('./useScreenActive', () => ({ useScreenActive: jest.fn() }))
const screenActive = useScreenActive as jest.Mock

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

const setup = () => {
  let pending: (() => void) | null = null
  const store = createTickStore((fn) => {
    pending = fn
  })
  const flush = () =>
    act(() => {
      const f = pending
      pending = null
      f?.()
    })
  const manager = createSubscriptionManager({ send: () => {}, setTimer: () => () => {} })
  const acquire = jest.fn(manager.acquire)
  const release = jest.fn()
  const realtime = {
    acquire: (r: Parameters<typeof manager.acquire>[0]) => {
      const rel = acquire(r)
      return () => {
        release()
        rel()
      }
    },
    confirmedDepth: manager.confirmedDepth,
  }
  const polling = createPollingEngine({
    api: { call: jest.fn(async () => []) } as never,
    store,
    isLive: () => false,
    network: () => 'home',
    now: Date.now,
    isAnyMarketOpen: () => true,
  })
  const register = jest.spyOn(polling, 'register')
  const live = { realtime, polling, store } as unknown as LiveServices
  return { polling, flush, store, manager, acquire, release, register, live }
}

const Q = () => {
  const q = useLiveQuote('NSE', 'A')
  return <Text testID="v">{q?.ltp ?? 'none'}</Text>
}
const D = () => {
  const d = useLiveDepth('NSE', 'A', 20)
  return (
    <Text testID="v">
      {d ? `${d.buy.length}/${d.levels}/${d.confirmedDepth}/${d.source}` : 'none'}
    </Text>
  )
}

describe('live hooks', () => {
  test('B7 useLiveQuote acquires mode 2 and registers while active, releases on blur', async () => {
    const h = setup()
    screenActive.mockReturnValue(true)
    const ui = () => (
      <LiveContext.Provider value={h.live}>
        <Q />
      </LiveContext.Provider>
    )
    const r = await render(ui())
    expect(h.acquire).toHaveBeenCalledWith({ exchange: 'NSE', symbol: 'A', mode: 2 })
    expect(h.register).toHaveBeenCalledTimes(1)
    await act(() => h.store.put('NSE:A', { ltp: 5 }, 'ws'))
    await h.flush()
    expect(r.getByTestId('v').props.children).toBe(5)
    screenActive.mockReturnValue(false)
    await r.rerender(ui())
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.polling.stats().consumers).toBe(0)
  })

  test('B7 useLiveDepth(…, 20) acquires mode 3 depth 20 and reports confirmedDepth 5', async () => {
    const h = setup()
    screenActive.mockReturnValue(true)
    const r = await render(
      <LiveContext.Provider value={h.live}>
        <D />
      </LiveContext.Provider>,
    )
    expect(h.acquire).toHaveBeenCalledWith({ exchange: 'NSE', symbol: 'A', mode: 3, depth: 20 })
    expect(r.getByTestId('v').props.children).toBe('none')
    h.manager.resendAll()
    h.manager.onAck({
      t: 'sub_ack',
      entries: [{ exchange: 'NSE', symbol: 'A', ok: true, depth: 20 }],
    } as never)
    h.manager.noteDepthLevels('NSE', 'A', 5)
    const lv = Array.from({ length: 5 }, (_, i) => ({ price: 10 - i, quantity: 1 }))
    await act(() => h.store.put('NSE:A', { depth: { buy: lv, sell: lv, levels: 5 } }, 'ws'))
    await h.flush()
    expect(r.getByTestId('v').props.children).toBe('5/5/5/ws')
  })
})
