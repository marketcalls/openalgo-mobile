import { act, render } from '@testing-library/react-native'
import { Text } from 'react-native'
import { createTickStore } from './tickStore'
import { TickStoreContext, useDepth, useFeedStale, useQuote } from './useQuote'

// Unmounting starts the store's eviction timer; fake timers keep it from holding jest open.
beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

let renders = 0

const Row = ({ active }: { active: boolean }) => {
  const q = useQuote('NSE:A', active)
  renders++
  return <Text testID="v">{q?.ltp ?? 'none'}</Text>
}

const DepthView = () => {
  const d = useDepth('k', true)
  const stale = useFeedStale()
  return (
    <Text testID="v">{`${d ? `${d.buy.length}/${d.sell.length}/${d.levels}` : 'none'} ${stale}`}</Text>
  )
}

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
  return { store, flush }
}

describe('hooks', () => {
  test('an inactive useQuote does not re-render, and catches up when active', async () => {
    const { store, flush } = setup()
    renders = 0
    const ui = (active: boolean) => (
      <TickStoreContext.Provider value={store}>
        <Row active={active} />
      </TickStoreContext.Provider>
    )
    const r = await render(ui(false))
    const base = renders
    await act(() => store.put('NSE:A', { ltp: 1 }, 'ws'))
    await flush()
    await act(() => store.put('NSE:A', { ltp: 2 }, 'ws'))
    await flush()
    expect(renders).toBe(base)
    await r.rerender(ui(true))
    expect(r.getByTestId('v').props.children).toBe(2)
    await act(() => store.put('NSE:A', { ltp: 3 }, 'ws'))
    await flush()
    expect(r.getByTestId('v').props.children).toBe(3)
  })

  test('useDepth and useFeedStale', async () => {
    const { store, flush } = setup()
    const r = await render(
      <TickStoreContext.Provider value={store}>
        <DepthView />
      </TickStoreContext.Provider>,
    )
    expect(r.getByTestId('v').props.children).toBe('none false')
    await act(() =>
      store.put('k', { depth: { buy: [{ price: 1, quantity: 1 }], sell: [], levels: 1 } }, 'ws'),
    )
    await flush()
    await act(() => store.setStale(true))
    expect(r.getByTestId('v').props.children).toBe('1/0/1 true')
  })
})
