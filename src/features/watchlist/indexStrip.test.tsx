import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import type { z } from 'zod'
import { profileStorage } from '~/core/config/storage'
import { createTickStore } from '~/core/realtime/tickStore'
import { LiveContext, type LiveServices } from '~/core/realtime/useLive'
import { TickStoreContext } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import { TradingProvider } from '~/market/trading'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { IndexStrip } from './components/IndexStrip'
import { loadIndexStrip, normalizeStrip, toggleIndex } from './indexStrip'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: jest.fn() }))

beforeEach(() => {
  ;(useScreenActive as jest.Mock).mockReturnValue(true)
  useConnection.getState().reset()
})

const NIFTY = 'NSE_INDEX:NIFTY'
const SENSEX = 'BSE_INDEX:SENSEX'
const VIX = 'NSE_INDEX:INDIAVIX'

const setup = async (seed?: unknown) => {
  const store = createTickStore((fn) => fn(), { evictAfterMs: 0 })
  const kv = memoryKV(seed ? { 'oa.p1.indexStrip': JSON.stringify(seed) } : {})
  const call = jest.fn(async (id: string, _body: unknown, schema: z.ZodType) => {
    if (id === 'funds') return schema.parse(funds)
    throw new Error(`unexpected ${id}`)
  })
  const live = {
    realtime: { acquire: () => () => {}, confirmedDepth: () => undefined },
    polling: { register: () => () => {} },
    store,
  } as unknown as LiveServices
  const services = {
    api: { call },
    store,
    storage: profileStorage(kv, 'p1'),
    profile: { get: () => ({ id: 'p1' }) },
  } as unknown as Services
  // no gc timer: it would hold the test process open
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  })
  await render(
    <ServicesProvider value={services}>
      <TradingProvider now={Date.now}>
        <QueryClientProvider client={client}>
          <TickStoreContext.Provider value={store}>
            <LiveContext.Provider value={live}>
              <IndexStrip />
            </LiveContext.Provider>
          </TickStoreContext.Provider>
        </QueryClientProvider>
      </TradingProvider>
    </ServicesProvider>,
  )
  const funded = () => call.mock.calls.filter((c) => c[0] === 'funds').length
  const saved = () => JSON.parse(kv.data.get('oa.p1.indexStrip') ?? 'null')
  return { store, kv, funded, saved }
}

const settle = () =>
  act(async () => {
    // react-query tells its observers from a 0 ms timer
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })

describe('strip choices', () => {
  test('toggling keeps the choices order and never empties the strip', () => {
    expect(toggleIndex([NIFTY, SENSEX], VIX)).toEqual([NIFTY, SENSEX, VIX])
    expect(toggleIndex([NIFTY, SENSEX], NIFTY)).toEqual([SENSEX])
    expect(toggleIndex([NIFTY], NIFTY)).toEqual([NIFTY])
    expect(toggleIndex([NIFTY], 'NSE:RELIANCE')).toEqual([NIFTY])
  })

  test('a saved value is cleaned, and a bad one gives the default', async () => {
    expect(normalizeStrip([VIX, 'junk', NIFTY, NIFTY])).toEqual([NIFTY, VIX])
    expect(normalizeStrip([])).toEqual([NIFTY, SENSEX])
    const s = profileStorage(memoryKV({ 'oa.p1.indexStrip': '{"a":1}' }), 'p1')
    expect(await loadIndexStrip(s)).toEqual([NIFTY, SENSEX])
  })
})

describe('IndexStrip', () => {
  test('shows NIFTY and SENSEX chips with their price and change by default', async () => {
    const h = await setup()
    await settle()
    expect(screen.getByTestId('index-NIFTY')).toBeTruthy()
    expect(screen.getByTestId('index-SENSEX')).toBeTruthy()
    expect(screen.queryByTestId('index-INDIAVIX')).toBeNull()
    await act(async () => h.store.put(NIFTY, { ltp: 24500, close: 24400 }, 'ws'))
    expect(screen.getByTestId('index-NIFTY')).toHaveTextContent(/24,500\.00/)
    expect(screen.getByTestId('index-NIFTY')).toHaveTextContent(/\+100\.00/)
  })

  test('adding INDIAVIX persists and shows its chip', async () => {
    const h = await setup()
    await settle()
    await fireEvent.press(screen.getByTestId('index-edit'))
    await fireEvent.press(screen.getByTestId('index-pick-INDIAVIX'))
    await settle()
    expect(h.saved()).toEqual([NIFTY, SENSEX, VIX])
    expect(screen.getByTestId('index-INDIAVIX')).toBeTruthy()
  })

  test('a saved choice is read back', async () => {
    await setup([VIX])
    await settle()
    expect(screen.getByTestId('index-INDIAVIX')).toBeTruthy()
    expect(screen.queryByTestId('index-NIFTY')).toBeNull()
  })

  test('the last chip cannot be removed', async () => {
    const h = await setup([NIFTY])
    await settle()
    await fireEvent.press(screen.getByTestId('index-edit'))
    await fireEvent.press(screen.getByTestId('index-pick-NIFTY'))
    await settle()
    expect(screen.getByTestId('index-NIFTY')).toBeTruthy()
    expect(h.saved()).toEqual([NIFTY])
  })

  test('funds load only after expanding, and the panel shows the docs fixture', async () => {
    const h = await setup()
    await settle()
    expect(h.funded()).toBe(0)
    expect(screen.queryByTestId('index-panel')).toBeNull()
    await act(async () =>
      h.store.put(NIFTY, { ltp: 24500, open: 24410, high: 24550, low: 24390, close: 24400 }, 'ws'),
    )
    await fireEvent.press(screen.getByTestId('index-NIFTY'))
    await settle()
    expect(h.funded()).toBe(1)
    expect(screen.getByTestId('index-panel-available')).toHaveTextContent(/320\.66/)
    expect(screen.getByTestId('index-panel-used')).toHaveTextContent(/679\.34/)
    expect(screen.getByTestId('index-panel-open')).toHaveTextContent(/24,410\.00/)
    expect(screen.getByTestId('index-panel-high')).toHaveTextContent(/24,550\.00/)
    expect(screen.getByTestId('index-panel-low')).toHaveTextContent(/24,390\.00/)
    expect(screen.getByTestId('index-panel-close')).toHaveTextContent(/24,400\.00/)
    await fireEvent.press(screen.getByTestId('index-NIFTY'))
    expect(screen.queryByTestId('index-panel')).toBeNull()
  })

  test('funds are not asked for while the broker is logged out', async () => {
    const h = await setup()
    await act(() => useConnection.getState().set({ brokerSession: 'logged_out' }))
    await settle()
    await fireEvent.press(screen.getByTestId('index-NIFTY'))
    await settle()
    expect(screen.getByTestId('index-panel')).toBeTruthy()
    expect(h.funded()).toBe(0)
  })
})
