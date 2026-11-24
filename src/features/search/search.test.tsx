import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { profileStorage } from '~/core/config/storage'
import { ApiError } from '~/core/http/errors'
import { type Services, ServicesProvider } from '~/core/services/services'
import { TradingProvider } from '~/market/trading'
import { WATCHLIST_LIMITS, WatchlistsSchema } from '~/market/watchlists/model'
import { TOAST_MS, ToastHost } from '~/ui/Toast'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { DEBOUNCE_MS, normalizeQuery } from './api'
import { SearchScreen } from './screens/SearchScreen'

const mockReplace = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }))

beforeEach(() => jest.useFakeTimers())
afterEach(() => {
  jest.useRealTimers()
  jest.clearAllMocks()
})

type Row = Record<string, unknown>
const ITC: Row = { symbol: 'ITC', name: 'ITC LTD', exchange: 'NSE', lotsize: 1, tick_size: 0.05 }
const NIFTY: Row = { symbol: 'NIFTY', name: 'NIFTY 50', exchange: 'NSE_INDEX', tick_size: 0.05 }

const setup = (o: { version?: string | null; rows?: Row[]; fail?: boolean } = {}) => {
  const kv = memoryKV()
  const storage = profileStorage(kv, 'p1')
  const call = jest.fn(async (_id: string, _body: unknown, _schema: unknown) => {
    if (o.fail) throw new ApiError({ kind: 'Server', status: 500, endpoint: 'search' })
    return o.rows ?? [ITC, NIFTY]
  })
  const services = {
    api: { call },
    storage,
    caps: { get: () => ({ version: o.version === undefined ? '2.0.3.5' : o.version }) },
    profile: { get: () => ({ id: 'p1' }) },
  } as unknown as Services
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (addTo?: string) => (
    <ServicesProvider value={services}>
      <TradingProvider now={Date.now}>
        <QueryClientProvider client={client}>
          <SearchScreen addTo={addTo} />
          <ToastHost />
        </QueryClientProvider>
      </TradingProvider>
    </ServicesProvider>
  )
  return { kv, call, ui }
}

const type = (t: string) => fireEvent.changeText(screen.getByTestId('search-input'), t)
const settle = async (ms = DEBOUNCE_MS) => {
  await act(async () => void jest.advanceTimersByTime(ms))
  // let the request, the query and the cache write finish
  // (react-query notifies through a 0 ms timer)
  for (let i = 0; i < 5; i++) await act(async () => void jest.advanceTimersByTime(1))
}

describe('normalizeQuery', () => {
  test('trims, collapses spaces, upper-cases and cuts to 40', () => {
    expect(normalizeQuery('  bank   nifty ')).toBe('BANK NIFTY')
    expect(normalizeQuery('a'.repeat(50))).toBe('A'.repeat(40))
  })
})

describe('SearchScreen', () => {
  test('typing r, re, rel inside 300 ms sends one search for REL; one letter sends none', async () => {
    const h = setup()
    await render(h.ui())
    expect(screen.getByText('Type at least 2 letters')).toBeOnTheScreen()
    await type('r')
    await settle(1000)
    expect(h.call).not.toHaveBeenCalled()
    await type('re')
    await settle(100)
    await type('rel')
    await settle(100)
    expect(h.call).not.toHaveBeenCalled()
    await settle(DEBOUNCE_MS)
    expect(h.call).toHaveBeenCalledTimes(1)
    expect(h.call.mock.calls[0]?.slice(0, 2)).toEqual(['search', { query: 'REL' }])
  })

  test('the NFO chip sends exchange NFO; ALL omits it', async () => {
    const h = setup()
    await render(h.ui())
    await fireEvent.press(screen.getByTestId('search-chip-NFO'))
    await type('nif')
    await settle()
    expect(h.call.mock.calls.at(-1)?.[1]).toEqual({ query: 'NIF', exchange: 'NFO' })
    await fireEvent.press(screen.getByTestId('search-chip-ALL'))
    await settle()
    expect(h.call.mock.calls.at(-1)?.[1]).toEqual({ query: 'NIF' })
  })

  test('at 2.0.0.0 there is no CRYPTO chip; 2.0.0.1 has one', async () => {
    const old = setup({ version: '2.0.0.0' })
    const { unmount } = await render(old.ui())
    expect(screen.getByTestId('search-chip-NFO')).toBeOnTheScreen()
    expect(screen.queryByTestId('search-chip-CRYPTO')).toBeNull()
    await unmount()
    await render(setup({ version: '2.0.0.1' }).ui())
    expect(screen.getByTestId('search-chip-CRYPTO')).toBeOnTheScreen()
  })

  test('an unknown version uses the 2.0.0.0 set', async () => {
    await render(setup({ version: null }).ui())
    expect(screen.queryByTestId('search-chip-CRYPTO')).toBeNull()
  })

  test('rows show the exchange, a Quote only badge for an index, and nothing else is flagged', async () => {
    const h = setup({
      rows: [
        ITC,
        NIFTY,
        { symbol: 'NIFTY30DEC26FUT', exchange: 'NFO', expiry: '30-DEC-26', strike: 0 },
      ],
    })
    await render(h.ui())
    await type('ni')
    await settle()
    expect(screen.getByTestId('search-row-NSE_INDEX-NIFTY')).toHaveTextContent(/Quote only/)
    expect(screen.getByTestId('search-row-NSE-ITC')).not.toHaveTextContent(/Quote only/)
    expect(screen.getByTestId('search-row-NFO-NIFTY30DEC26FUT')).toHaveTextContent(/30-DEC-26/)
  })

  test('shows at most 100 rows', async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ symbol: `S${i}`, exchange: 'NSE' }))
    const h = setup({ rows: many })
    await render(h.ui())
    await type('s')
    await type('s1')
    await settle()
    expect(screen.getByTestId('search-row-NSE-S0')).toBeOnTheScreen()
    expect(screen.queryByTestId('search-row-NSE-S100')).toBeNull()
  })

  test('no rows says so; an error offers a retry', async () => {
    const empty = setup({ rows: [] })
    const { unmount } = await render(empty.ui())
    await type('zz')
    await settle()
    expect(screen.getByText('No matching symbols')).toBeOnTheScreen()
    await unmount()

    const bad = setup({ fail: true })
    await render(bad.ui())
    await type('zz')
    await settle()
    expect(screen.getByText('Try again')).toBeOnTheScreen()
    await fireEvent.press(screen.getByText('Try again'))
    await settle(0)
    expect(bad.call.mock.calls.length).toBeGreaterThan(1)
  })

  test('browse mode replaces the route with the instrument sheet', async () => {
    const h = setup()
    await render(h.ui())
    await type('it')
    await settle()
    await fireEvent.press(screen.getByTestId('search-row-NSE-ITC'))
    expect(mockReplace).toHaveBeenCalledWith('/instrument/NSE%3AITC')
  })

  test('add mode adds the symbol, shows a tick and a toast; a second tap says already there', async () => {
    const h = setup()
    await render(h.ui('default'))
    await type('it')
    await settle()
    expect(screen.queryByTestId('search-added-NSE-ITC')).toBeNull()
    await act(async () => void fireEvent.press(screen.getByTestId('search-row-NSE-ITC')))
    expect(screen.getByTestId('search-status')).toHaveTextContent('Added ITC to Watchlist')
    // rendered inside the search screen, not by the root host
    expect(screen.queryByTestId('toast')).toBeNull()
    expect(screen.getByTestId('search-added-NSE-ITC')).toBeOnTheScreen()
    expect(mockReplace).not.toHaveBeenCalled()
    const saved = WatchlistsSchema.parse(JSON.parse(h.kv.data.get('oa.p1.watchlists') ?? 'null'))
    expect(saved.lists[0]?.items.at(-1)).toEqual({ exchange: 'NSE', symbol: 'ITC' })
    // the saved defaults are kept, not replaced
    expect(saved.lists[0]?.items.length).toBeGreaterThan(1)

    await act(async () => void fireEvent.press(screen.getByTestId('search-row-NSE-ITC')))
    expect(screen.getByTestId('search-status')).toHaveTextContent('Already in this list')
    await act(async () => void jest.advanceTimersByTime(TOAST_MS))
    expect(screen.queryByTestId('search-status')).toBeNull()
  })

  test('add mode names the list as stored at tap time', async () => {
    const h = setup()
    h.kv.data.set(
      'oa.p1.watchlists',
      JSON.stringify({
        version: 1,
        activeId: 'default',
        lists: [{ id: 'default', name: 'Swing picks', items: [] }],
      }),
    )
    await render(h.ui('default'))
    await type('it')
    await settle()
    await act(async () => void fireEvent.press(screen.getByTestId('search-row-NSE-ITC')))
    expect(screen.getByTestId('search-status')).toHaveTextContent('Added ITC to Swing picks')
  })

  test('add mode on a full list says so', async () => {
    const h = setup()
    const items = Array.from({ length: WATCHLIST_LIMITS.items }, (_, i) => ({
      exchange: 'NSE',
      symbol: `X${i}`,
    }))
    h.kv.data.set(
      'oa.p1.watchlists',
      JSON.stringify({
        version: 1,
        activeId: 'default',
        lists: [{ id: 'default', name: 'Full', items }],
      }),
    )
    await render(h.ui('default'))
    await type('it')
    await settle()
    await act(async () => void fireEvent.press(screen.getByTestId('search-row-NSE-ITC')))
    expect(screen.getByTestId('search-status')).toHaveTextContent('This list is full (250)')
  })

  test('search results warm the instrument cache', async () => {
    const h = setup()
    await render(h.ui())
    await type('it')
    await settle()
    const raw = h.kv.data.get('oa.p1.instruments') ?? ''
    expect(raw).toContain('"symbol":"ITC"')
  })
})
