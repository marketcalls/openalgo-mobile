import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { AccessibilityInfo, Alert, type AlertButton } from 'react-native'
import { profileStorage } from '~/core/config/storage'
import { ApiError } from '~/core/http/errors'
import { istDate } from '~/core/realtime/marketHours'
import { createPollingEngine } from '~/core/realtime/polling'
import { createTickStore } from '~/core/realtime/tickStore'
import { LiveContext, type LiveServices } from '~/core/realtime/useLive'
import { TickStoreContext } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import { instrumentHref, searchHref, ticketHref } from '~/market/links'
import { TradingProvider } from '~/market/trading'
import { DEFAULT_WATCHLISTS, type Watchlists, WatchlistsSchema } from '~/market/watchlists/model'
import { loadWatchlists, saveWatchlists } from '~/market/watchlists/store'
import { ToastHost } from '~/ui/Toast'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { newListId, useSeedQuotes } from './api'
import { WatchRow } from './components/WatchRow'
import { WatchlistScreen } from './screens/WatchlistScreen'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: jest.fn() }))
const screenActive = useScreenActive as jest.Mock
const mockPush = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }))

const ORIGIN = 'https://algo.example.com'
/** The server's own validation refusal, put ahead of the broker results (quotes_service.py:30-36). */
const GONE =
  "Symbol 'NIFTY25NOV25FUT' not found for exchange 'NFO'. " +
  'Please verify the symbol name and ensure master contracts are downloaded.'
/** A broker failure: kotak and nuvama give every symbol of a failed batch `error: str(e)`. */
const TIMED_OUT = "HTTPSConnectionPool(host='api.example.com', port=443): Read timed out."

beforeEach(() => {
  jest.useFakeTimers()
  screenActive.mockReturnValue(true)
  useConnection.getState().reset()
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  mockPush.mockReset()
})

type Sym = { symbol: string; exchange: string }
type Call = (id: string, body: { symbols?: Sym[] } & Record<string, unknown>) => Promise<unknown>

/** multiquotes answers every symbol with a price, unless a test scripts the reply. */
const priced: Call = async (_id, body) =>
  (body.symbols ?? []).map((s) => ({ ...s, data: { ltp: 1500, prev_close: 1490 } }))

const setup = (o: { live?: boolean; call?: Call; seed?: Record<string, string> } = {}) => {
  let pending: (() => void) | null = null
  const store = createTickStore((fn) => {
    pending = fn
  })
  const flush = () =>
    act(async () => {
      const f = pending
      pending = null
      f?.()
    })
  const call = jest.fn(o.call ?? priced)
  const api = { call } as unknown as Services['api']
  const kv = memoryKV(o.seed)
  const polling = createPollingEngine({
    api,
    store,
    isLive: () => o.live ?? true,
    network: () => 'home',
    now: Date.now,
    isExchangeOpen: () => true,
  })
  /** The feed subscriptions rows hold now, by key. */
  const held = new Map<string, number>()
  const realtime = {
    acquire: jest.fn((r: Sym) => {
      const k = `${r.exchange}:${r.symbol}`
      held.set(k, (held.get(k) ?? 0) + 1)
      return () => held.set(k, (held.get(k) ?? 1) - 1)
    }),
    confirmedDepth: () => undefined,
  }
  const live = { realtime, polling, store } as unknown as LiveServices
  const services = {
    api,
    store,
    storage: profileStorage(kv, 'p1'),
    profile: { get: () => ({ id: 'p1', restOrigin: ORIGIN }) },
  } as unknown as Services
  const wrap = (ui: React.ReactElement) => (
    <ServicesProvider value={services}>
      <TradingProvider now={Date.now}>
        <TickStoreContext.Provider value={store}>
          <LiveContext.Provider value={live}>
            {ui}
            <ToastHost />
          </LiveContext.Provider>
        </TickStoreContext.Provider>
      </TradingProvider>
    </ServicesProvider>
  )
  const count = (id: string) => call.mock.calls.filter((c) => c[0] === id).length
  const saved = (): Watchlists =>
    WatchlistsSchema.parse(JSON.parse(kv.data.get('oa.p1.watchlists') ?? 'null'))
  const holds = (k: string) => held.get(k) ?? 0
  return { store, flush, call, count, wrap, polling, holds, kv, saved }
}

/** Lets the storage reads, the seed and the store writes finish. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })

const later = (ms: number) =>
  act(async () => {
    jest.advanceTimersByTime(ms)
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })

const lists = (...ls: { id: string; name: string; items: Sym[] }[]): Record<string, string> => ({
  'oa.p1.watchlists': JSON.stringify({ version: 1, activeId: ls[0]?.id, lists: ls }),
})

const ITEMS = [{ exchange: 'NSE', symbol: 'RELIANCE' }]
let seeded: ReadonlySet<string> = new Set()
const Probe = ({ items = ITEMS }: { items?: Sym[] }) => {
  seeded = useSeedQuotes(items).unknown
  return <WatchRow exchange="NSE" symbol="RELIANCE" reduceMotion />
}

const tick = async (h: ReturnType<typeof setup>, ltp: number) => {
  h.store.put('NSE:RELIANCE', { ltp, close: 1490 }, 'ws')
  await h.flush()
}

/** Answers the next Alert with the button labelled `label`. */
const answerAlert = (label: string) =>
  jest.spyOn(Alert, 'alert').mockImplementationOnce((_t, _m, buttons?: AlertButton[]) => {
    const b = buttons?.find((x) => x.text === label)
    if (!b) throw new Error(`no ${label} button`)
    b.onPress?.()
  })

/** A left swipe of `dx` px on a row, through its responder handlers. */
async function swipe(id: string, dx: number) {
  const el = screen.getByTestId(`watch-swipe-${id}`)
  const at = (x: number, prev: number, ts: number) => ({
    nativeEvent: { touches: [{}], changedTouches: [] },
    touchHistory: {
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: ts,
      touchBank: [
        {
          touchActive: true,
          startPageX: 300,
          startPageY: 20,
          startTimeStamp: 1,
          currentPageX: x,
          currentPageY: 20,
          currentTimeStamp: ts,
          previousPageX: prev,
          previousPageY: 20,
          previousTimeStamp: ts - 1,
        },
      ],
    },
  })
  // The responder system's order: start capture (resets), move capture (measures), then ask.
  el.props.onStartShouldSetResponderCapture(at(300, 300, 1))
  el.props.onMoveShouldSetResponderCapture(at(300 + dx, 300, 10))
  expect(el.props.onMoveShouldSetResponder(at(300 + dx, 300, 10))).toBe(true)
  await act(async () => {
    el.props.onResponderGrant(at(300 + dx, 300, 10))
    el.props.onResponderMove(at(300 + dx, 300, 20))
    el.props.onResponderRelease(at(300 + dx, 300 + dx, 30))
  })
  await settle()
}

describe('watchlist storage', () => {
  test('the first load seeds the defaults under oa.<pid>.watchlists', async () => {
    const kv = memoryKV()
    const s = profileStorage(kv, 'p1')
    const w = await loadWatchlists(s)
    expect(w).toEqual(DEFAULT_WATCHLISTS)
    expect(WatchlistsSchema.parse(JSON.parse(kv.data.get('oa.p1.watchlists') ?? 'null'))).toEqual(
      DEFAULT_WATCHLISTS,
    )
    const list = DEFAULT_WATCHLISTS.lists[0]
    expect(list?.id).toBe('default')
    expect(list?.name).toBe('Watchlist')
    expect(list?.items.map((i) => `${i.exchange}:${i.symbol}`)).toEqual([
      'NSE:RELIANCE',
      'NSE:TCS',
      'NSE:INFY',
      'NSE:HDFCBANK',
      'NSE:ICICIBANK',
      'NSE:SBIN',
      'NSE_INDEX:NIFTY',
    ])
  })

  test('a saved list is loaded back, not replaced by the defaults', async () => {
    const s = profileStorage(memoryKV(), 'p1')
    await loadWatchlists(s)
    const mine = {
      version: 1 as const,
      activeId: 'default',
      lists: [{ id: 'default', name: 'Mine', items: [{ exchange: 'NSE', symbol: 'ITC' }] }],
    }
    await saveWatchlists(s, mine)
    expect(await loadWatchlists(s)).toEqual(mine)
  })
})

describe('WatchRow', () => {
  test('shows -- , then the seeded price after focus, then a later WS tick', async () => {
    const h = setup()
    await render(h.wrap(<Probe />))
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toHaveTextContent('--')
    await settle()
    await h.flush()
    expect(h.call).toHaveBeenCalledTimes(1)
    expect(h.call.mock.calls[0]?.[0]).toBe('multiquotes')
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toHaveTextContent('1,500.00')
    await tick(h, 1502.5)
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toHaveTextContent('1,502.50')
    expect(screen.getByText('NSE')).toBeTruthy()
    expect(screen.getByText('RELIANCE')).toBeTruthy()
  })

  test('a stale feed dims the row', async () => {
    const h = setup()
    await render(h.wrap(<WatchRow exchange="NSE" symbol="RELIANCE" reduceMotion />))
    const opacity = () => {
      const st = screen.getByTestId('watch-row-NSE-RELIANCE').props.style
      return [st].flat(3).find((x: { opacity?: number } | undefined) => x?.opacity !== undefined)
        ?.opacity
    }
    expect(opacity()).toBe(1)
    await act(async () => h.store.setStale(true))
    expect(opacity()).toBe(0.5)
  })

  test('a price change flashes for 400 ms; reduced motion has no flash', async () => {
    const h = setup()
    const { rerender } = await render(h.wrap(<WatchRow exchange="NSE" symbol="RELIANCE" />))
    await tick(h, 1500)
    expect(screen.queryByTestId('watch-flash-NSE-RELIANCE')).toBeNull() // first quote is no change
    await tick(h, 1501)
    expect(screen.getByTestId('watch-flash-NSE-RELIANCE')).toBeTruthy()
    await act(async () => void jest.advanceTimersByTime(400))
    expect(screen.queryByTestId('watch-flash-NSE-RELIANCE')).toBeNull()

    await rerender(h.wrap(<WatchRow exchange="NSE" symbol="RELIANCE" reduceMotion />))
    await tick(h, 1502)
    expect(screen.queryByTestId('watch-flash-NSE-RELIANCE')).toBeNull()
  })

  test('B and S open the ticket for BUY and SELL; a row press opens the instrument', async () => {
    const h = setup()
    await render(h.wrap(<WatchRow exchange="NSE" symbol="RELIANCE" reduceMotion />))
    await fireEvent.press(screen.getByTestId('watch-buy-NSE-RELIANCE'))
    expect(mockPush).toHaveBeenLastCalledWith('/order/new?exchange=NSE&symbol=RELIANCE&action=BUY')
    await fireEvent.press(screen.getByTestId('watch-sell-NSE-RELIANCE'))
    expect(mockPush).toHaveBeenLastCalledWith(
      ticketHref({ exchange: 'NSE', symbol: 'RELIANCE', action: 'SELL' }),
    )
    await fireEvent.press(screen.getByTestId('watch-row-NSE-RELIANCE'))
    expect(mockPush).toHaveBeenLastCalledWith(instrumentHref('NSE', 'RELIANCE'))
    expect(mockPush).toHaveBeenCalledTimes(3)
  })

  test('a quote-only index has no B/S', async () => {
    const h = setup()
    await render(h.wrap(<WatchRow exchange="NSE_INDEX" symbol="NIFTY" reduceMotion />))
    expect(screen.getByTestId('watch-row-NSE_INDEX-NIFTY')).toBeOnTheScreen()
    expect(screen.queryByTestId('watch-buy-NSE_INDEX-NIFTY')).toBeNull()
    expect(screen.queryByTestId('watch-sell-NSE_INDEX-NIFTY')).toBeNull()
  })

  test('while the broker is logged out, B/S are disabled', async () => {
    const h = setup()
    useConnection.getState().set({ brokerSession: 'logged_out' })
    await render(h.wrap(<WatchRow exchange="NSE" symbol="RELIANCE" reduceMotion />))
    expect(screen.getByTestId('watch-buy-NSE-RELIANCE')).toBeDisabled()
    expect(screen.getByTestId('watch-sell-NSE-RELIANCE')).toBeDisabled()
    await fireEvent.press(screen.getByTestId('watch-buy-NSE-RELIANCE'))
    expect(mockPush).not.toHaveBeenCalled()
  })
})

describe('newListId', () => {
  test('an id from the time, moved on past any list that has it', () => {
    const t = 1_764_000_000_000
    const w = { ...DEFAULT_WATCHLISTS, lists: [] }
    expect(newListId(w, t)).toBe(`l${t.toString(36)}`)
    const taken = { ...w, lists: [{ id: `l${t.toString(36)}`, name: 'A', items: [] }] }
    expect(newListId(taken, t)).toBe(`l${(t + 1).toString(36)}`)
  })
})

describe('useSeedQuotes', () => {
  test('returns the keys whose multiquotes entry carried an error', async () => {
    const h = setup({
      call: async () => [
        { symbol: 'RELIANCE', exchange: 'NSE', data: { ltp: 1500, prev_close: 1490 } },
        { symbol: 'NIFTY25NOV25FUT', exchange: 'NFO', error: GONE },
      ],
    })
    const items = [...ITEMS, { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }]
    await render(h.wrap(<Probe items={items} />))
    await settle()
    expect([...seeded]).toEqual(['NFO:NIFTY25NOV25FUT'])
  })

  test("adds a seed 400's invalid_symbols", async () => {
    const h = setup({
      call: async () => {
        throw new ApiError({
          kind: 'Validation',
          status: 400,
          endpoint: 'multiquotes',
          serverMessage: GONE,
          invalidSymbols: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
        })
      },
    })
    await render(h.wrap(<Probe items={[{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }]} />))
    await settle()
    expect([...seeded]).toEqual(['NFO:NIFTY25NOV25FUT'])
  })

  test('a broker failure entry is not a refusal: no key joins the set', async () => {
    const h = setup({
      call: async (_id, body) => (body.symbols ?? []).map((s) => ({ ...s, error: TIMED_OUT })),
    })
    const items = [...ITEMS, { exchange: 'NFO', symbol: 'NIFTY30DEC25FUT' }]
    await render(h.wrap(<Probe items={items} />))
    await settle()
    expect(h.count('multiquotes')).toBe(1)
    expect([...seeded]).toEqual([])
  })

  test("the server's other refusal, an exchange it does not accept, is unknown too", async () => {
    const h = setup({
      call: async () => [
        { symbol: 'RELIANCE', exchange: 'NSE', data: { ltp: 1500, prev_close: 1490 } },
        {
          symbol: 'CRUDEOIL',
          exchange: 'NCO',
          error: "Invalid exchange 'NCO'. Must be one of: NSE, NFO, CDS, BSE, BFO, BCD, MCX",
        },
      ],
    })
    await render(h.wrap(<Probe items={[...ITEMS, { exchange: 'NCO', symbol: 'CRUDEOIL' }]} />))
    await settle()
    expect([...seeded]).toEqual(['NCO:CRUDEOIL'])
  })
})

describe('WatchlistScreen', () => {
  test('lists the default symbols and, with a live feed, makes no REST call after the seed', async () => {
    const h = setup({ live: true })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.getByTestId('watch-row-NSE-RELIANCE')).toBeTruthy()
    expect(screen.getByTestId('watch-row-NSE_INDEX-NIFTY')).toBeTruthy()
    expect(h.kv.data.has('oa.p1.watchlists')).toBe(true)
    expect(h.call).toHaveBeenCalledTimes(1) // the seed
    expect(h.call.mock.calls[0]?.[1]).toEqual({
      symbols: DEFAULT_WATCHLISTS.lists[0]?.items.map((i) => ({
        symbol: i.symbol,
        exchange: i.exchange,
      })),
    })
    await later(10_000)
    expect(h.call).toHaveBeenCalledTimes(1)
  })

  test('waits for the saved lists: the seed asks for the saved list, never the defaults', async () => {
    const h = setup({
      seed: lists({ id: 'a', name: 'Mine', items: [{ exchange: 'NSE', symbol: 'ITC' }] }),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(h.call).toHaveBeenCalledTimes(1)
    expect(h.call.mock.calls[0]?.[1]).toEqual({ symbols: [{ symbol: 'ITC', exchange: 'NSE' }] })
    expect(screen.getByTestId('watch-row-NSE-ITC')).toBeOnTheScreen()
    expect(screen.queryByTestId('watch-row-NSE-RELIANCE')).toBeNull()
  })

  test('B on RELIANCE opens the BUY ticket; NIFTY has no B/S', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('watch-buy-NSE-RELIANCE'))
    expect(mockPush).toHaveBeenCalledWith(
      ticketHref({ exchange: 'NSE', symbol: 'RELIANCE', action: 'BUY' }),
    )
    expect(screen.queryByTestId('watch-buy-NSE_INDEX-NIFTY')).toBeNull()
    expect(screen.queryByTestId('watch-sell-NSE_INDEX-NIFTY')).toBeNull()
  })

  test('wl-add opens search to add to the active list', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('wl-add'))
    expect(mockPush).toHaveBeenCalledWith(searchHref({ addTo: 'default' }))
    expect(mockPush).toHaveBeenCalledWith('/search?addTo=default')
  })

  test('the remove action confirms, removes and saves', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    const alert = answerAlert('Remove')
    await fireEvent(screen.getByTestId('watch-row-NSE-TCS'), 'accessibilityAction', {
      nativeEvent: { actionName: 'remove' },
    })
    await settle()
    expect(alert).toHaveBeenCalledWith(
      'Remove TCS from Watchlist?',
      undefined,
      expect.any(Array),
      expect.anything(),
    )
    expect(screen.queryByTestId('watch-row-NSE-TCS')).toBeNull()
    expect(h.saved().lists[0]?.items.map((i) => i.symbol)).not.toContain('TCS')
    expect(h.saved().lists[0]?.items).toHaveLength(6)
  })

  test('a cancelled remove keeps the row', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    answerAlert('Cancel')
    await fireEvent(screen.getByTestId('watch-row-NSE-TCS'), 'accessibilityAction', {
      nativeEvent: { actionName: 'remove' },
    })
    await settle()
    expect(screen.getByTestId('watch-row-NSE-TCS')).toBeOnTheScreen()
    expect(h.saved().lists[0]?.items).toHaveLength(7)
  })

  test('a left swipe past the threshold asks to remove; a short one does nothing', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await swipe('NSE-INFY', -40)
    expect(alert).not.toHaveBeenCalled()
    alert.mockRestore()

    const confirmed = answerAlert('Remove')
    await swipe('NSE-INFY', -150)
    expect(confirmed.mock.calls[0]?.[0]).toBe('Remove INFY from Watchlist?')
    expect(screen.queryByTestId('watch-row-NSE-INFY')).toBeNull()
    expect(h.saved().lists[0]?.items.map((i) => i.symbol)).not.toContain('INFY')
  })

  test('edit mode moves rows up and down and saves; B/S give way to the controls', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.queryByTestId('wl-up-NSE-TCS')).toBeNull()
    await fireEvent.press(screen.getByTestId('wl-edit'))
    expect(screen.queryByTestId('watch-buy-NSE-RELIANCE')).toBeNull()
    expect(screen.getByTestId('wl-up-NSE-RELIANCE')).toBeDisabled()
    expect(screen.getByTestId('wl-down-NSE_INDEX-NIFTY')).toBeDisabled()

    await fireEvent.press(screen.getByTestId('wl-up-NSE-TCS'))
    await settle()
    const order = () => h.saved().lists[0]?.items.map((i) => i.symbol)
    expect(order()?.slice(0, 3)).toEqual(['TCS', 'RELIANCE', 'INFY'])
    await fireEvent.press(screen.getByTestId('wl-down-NSE-RELIANCE'))
    await settle()
    expect(order()?.slice(0, 3)).toEqual(['TCS', 'INFY', 'RELIANCE'])
    expect(screen.getByTestId('wl-up-NSE-TCS')).toBeDisabled()

    const alert = answerAlert('Remove')
    await fireEvent.press(screen.getByTestId('wl-remove-NSE-SBIN'))
    await settle()
    expect(alert.mock.calls[0]?.[0]).toBe('Remove SBIN from Watchlist?')
    expect(order()).not.toContain('SBIN')

    await fireEvent.press(screen.getByTestId('wl-edit'))
    expect(screen.queryByTestId('wl-up-NSE-TCS')).toBeNull()
    expect(screen.getByTestId('watch-buy-NSE-RELIANCE')).toBeOnTheScreen()
  })

  test('wl-new asks for a name; the new list appears, becomes active and starts empty', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('wl-new'))
    expect(screen.getByTestId('wl-name-save')).toBeDisabled()
    await fireEvent.changeText(screen.getByTestId('wl-name-input'), '  Swing  ')
    await fireEvent.press(screen.getByTestId('wl-name-save'))
    await settle()

    const doc = h.saved()
    expect(doc.lists.map((l) => l.name)).toEqual(['Watchlist', 'Swing'])
    const id = doc.lists[1]?.id ?? ''
    expect(id).not.toBe('default')
    expect(doc.activeId).toBe(id)
    expect(screen.getByTestId(`wl-tab-${id}`)).toBeSelected()
    expect(screen.getByTestId('wl-tab-default')).not.toBeSelected()
    expect(screen.queryByTestId('wl-name-input')).toBeNull()
    expect(screen.getByText('This list is empty')).toBeOnTheScreen()
    await fireEvent.press(screen.getByTestId('wl-empty-add'))
    expect(mockPush).toHaveBeenCalledWith(searchHref({ addTo: id }))
  })

  test('a tab press shows that list and seeds its symbols', async () => {
    const h = setup({
      seed: lists(
        { id: 'a', name: 'One', items: [{ exchange: 'NSE', symbol: 'ITC' }] },
        { id: 'b', name: 'Two', items: [{ exchange: 'NSE', symbol: 'SBIN' }] },
      ),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.getByTestId('wl-tab-a')).toBeSelected()
    await fireEvent.press(screen.getByTestId('wl-tab-b'))
    await settle()
    expect(screen.getByTestId('wl-tab-b')).toBeSelected()
    expect(screen.getByTestId('watch-row-NSE-SBIN')).toBeOnTheScreen()
    expect(screen.queryByTestId('watch-row-NSE-ITC')).toBeNull()
    expect(h.saved().activeId).toBe('b')
    expect(h.call.mock.calls.at(-1)?.[1]).toEqual({
      symbols: [{ symbol: 'SBIN', exchange: 'NSE' }],
    })
  })

  test('cancelling the name changes nothing; at 50 lists wl-new says so instead', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('wl-new'))
    await fireEvent.changeText(screen.getByTestId('wl-name-input'), 'Swing')
    await fireEvent.press(screen.getByTestId('wl-name-cancel'))
    await settle()
    expect(screen.queryByTestId('wl-name-input')).toBeNull()
    expect(h.saved().lists).toHaveLength(1)

    const full = Array.from({ length: 50 }, (_, i) => ({ id: `l${i}`, name: `L${i}`, items: [] }))
    const f = setup({ seed: lists(...full) })
    await render(f.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('wl-new'))
    expect(screen.queryByTestId('wl-name-input')).toBeNull()
    expect(screen.getByTestId('toast')).toHaveTextContent('You can keep up to 50 lists.')
  })

  test('a failed save says so and keeps the row', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    h.kv.set = async () => {
      throw new Error('disk full')
    }
    answerAlert('Remove')
    await fireEvent(screen.getByTestId('watch-row-NSE-TCS'), 'accessibilityAction', {
      nativeEvent: { actionName: 'remove' },
    })
    await settle()
    expect(screen.getByTestId('toast')).toHaveTextContent('Could not save your lists. Try again.')
    expect(screen.getByTestId('watch-row-NSE-TCS')).toBeOnTheScreen()
  })

  test('a long press renames a list', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    answerAlert('Rename')
    await fireEvent(screen.getByTestId('wl-tab-default'), 'longPress')
    expect(screen.getByTestId('wl-name-input').props.value).toBe('Watchlist')
    await fireEvent.changeText(screen.getByTestId('wl-name-input'), 'Long term')
    await fireEvent.press(screen.getByTestId('wl-name-save'))
    await settle()
    expect(screen.getByTestId('wl-tab-default')).toHaveTextContent('Long term')
    expect(h.saved().lists[0]?.name).toBe('Long term')
  })

  test('a long press deletes a list after confirming with its name and symbol count', async () => {
    const h = setup({
      seed: lists(
        { id: 'a', name: 'One', items: [{ exchange: 'NSE', symbol: 'ITC' }] },
        {
          id: 'b',
          name: 'Swing',
          items: [
            { exchange: 'NSE', symbol: 'SBIN' },
            { exchange: 'NSE', symbol: 'TCS' },
          ],
        },
      ),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    answerAlert('Delete')
    const confirmed = answerAlert('Delete')
    await fireEvent(screen.getByTestId('wl-tab-b'), 'longPress')
    await settle()
    expect(confirmed.mock.calls.at(-1)?.[0]).toBe('Delete Swing and its 2 symbols?')
    expect(screen.queryByTestId('wl-tab-b')).toBeNull()
    expect(h.saved().lists.map((l) => l.id)).toEqual(['a'])
  })

  test('deleting the last list shows "Keep at least one list." and asks nothing more', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    const alert = answerAlert('Delete')
    await fireEvent(screen.getByTestId('wl-tab-default'), 'longPress')
    await settle()
    expect(alert).toHaveBeenCalledTimes(1) // the menu; no delete confirm
    expect(screen.getByTestId('toast')).toHaveTextContent('Keep at least one list.')
    expect(screen.getByTestId('wl-tab-default')).toBeOnTheScreen()
    expect(h.saved().lists).toHaveLength(1)
  })

  test('a multiquotes error entry shows "Expired or unknown", with no B/S and no /symbol call', async () => {
    const h = setup({
      seed: lists({
        id: 'a',
        name: 'Mine',
        items: [
          { exchange: 'NSE', symbol: 'RELIANCE' },
          { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
        ],
      }),
      call: async () => [
        { symbol: 'NIFTY25NOV25FUT', exchange: 'NFO', error: GONE },
        { symbol: 'RELIANCE', exchange: 'NSE', data: { ltp: 1500, prev_close: 1490 } },
      ],
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.getByTestId('watch-row-NFO-NIFTY25NOV25FUT')).toHaveTextContent(
      /Expired or unknown/,
    )
    expect(screen.queryByTestId('watch-buy-NFO-NIFTY25NOV25FUT')).toBeNull()
    expect(screen.queryByTestId('watch-sell-NFO-NIFTY25NOV25FUT')).toBeNull()
    expect(screen.queryByTestId('watch-ltp-NFO-NIFTY25NOV25FUT')).toBeNull()
    expect(screen.getByTestId('watch-buy-NSE-RELIANCE')).toBeOnTheScreen()
    expect(screen.getByTestId('watch-row-NSE-RELIANCE')).not.toHaveTextContent(/Expired/)
    expect(h.count('symbol')).toBe(0)
    // once known, an unknown key holds no feed subscription and no poll
    expect(h.holds('NFO:NIFTY25NOV25FUT')).toBe(0)
    expect(h.holds('NSE:RELIANCE')).toBe(1)
    expect(h.polling.stats().consumers).toBe(1)
    // and can still be removed
    answerAlert('Remove')
    await fireEvent(screen.getByTestId('watch-row-NFO-NIFTY25NOV25FUT'), 'accessibilityAction', {
      nativeEvent: { actionName: 'remove' },
    })
    await settle()
    expect(screen.queryByTestId('watch-row-NFO-NIFTY25NOV25FUT')).toBeNull()
  })

  test('a broker error entry, not the server\'s "not found", is not badged', async () => {
    const h = setup({
      seed: lists({ id: 'a', name: 'Mine', items: [{ exchange: 'NSE', symbol: 'RELIANCE' }] }),
      call: async () => [{ symbol: 'RELIANCE', exchange: 'NSE', error: TIMED_OUT }],
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.queryByTestId('watch-unknown-NSE-RELIANCE')).toBeNull()
    expect(screen.getByTestId('watch-row-NSE-RELIANCE')).not.toHaveTextContent(/Expired/)
    expect(screen.getByTestId('watch-buy-NSE-RELIANCE')).toBeOnTheScreen()
    expect(screen.getByTestId('watch-sell-NSE-RELIANCE')).toBeOnTheScreen()
    // the row stays live: it holds the feed, and the next tick lands
    expect(h.holds('NSE:RELIANCE')).toBe(1)
    await tick(h, 1502.5)
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toHaveTextContent('1,502.50')
  })

  test('the broker session turning active again forgets the refusals and asks again', async () => {
    let listed = false // the server has not downloaded its master contracts yet
    const h = setup({
      seed: lists({
        id: 'a',
        name: 'Mine',
        items: [
          { exchange: 'NSE', symbol: 'RELIANCE' },
          { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
        ],
      }),
      call: async (_id, body) =>
        (body.symbols ?? []).map((s) =>
          s.symbol === 'NIFTY25NOV25FUT' && !listed
            ? { ...s, error: GONE }
            : { ...s, data: { ltp: 1500, prev_close: 1490 } },
        ),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    await act(async () => useConnection.getState().set({ brokerSession: 'logged_out' }))
    await settle()
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    listed = true
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    await settle()
    expect(h.count('multiquotes')).toBe(2)
    expect(h.call.mock.calls[1]?.[1].symbols).toContainEqual({
      symbol: 'NIFTY25NOV25FUT',
      exchange: 'NFO',
    })
    expect(screen.queryByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeNull()
    expect(screen.getByTestId('watch-buy-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    await h.flush()
    expect(screen.getByTestId('watch-ltp-NFO-NIFTY25NOV25FUT')).toHaveTextContent('1,500.00')
  })

  test('from "unknown", the session turning active forgets the refusals and seeds again', async () => {
    const h = setup({
      seed: lists({
        id: 'a',
        name: 'Mine',
        items: [
          { exchange: 'NSE', symbol: 'RELIANCE' },
          { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
        ],
      }),
      call: async () => [
        { symbol: 'NIFTY25NOV25FUT', exchange: 'NFO', error: GONE },
        { symbol: 'RELIANCE', exchange: 'NSE', data: { ltp: 1500, prev_close: 1490 } },
      ],
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(h.count('multiquotes')).toBe(1)
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    expect(useConnection.getState().brokerSession).toBe('unknown')
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    await settle()
    // still refused: badged again, and asked once, not in a loop
    expect(h.count('multiquotes')).toBe(2)
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    await later(10_000)
    expect(h.count('multiquotes')).toBe(2)
  })

  test('a reply sent before a clear does not bring its refusals back', async () => {
    const replies: ((refuse: string[]) => void)[] = []
    const h = setup({
      seed: lists({
        id: 'a',
        name: 'Mine',
        items: [
          { exchange: 'NSE', symbol: 'RELIANCE' },
          { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
        ],
      }),
      call: (_id, body) =>
        new Promise((resolve) => {
          replies.push((refuse) =>
            resolve(
              (body.symbols ?? []).map((s) =>
                refuse.includes(s.symbol)
                  ? { ...s, error: GONE.replaceAll('NIFTY25NOV25FUT', s.symbol) }
                  : { ...s, data: { ltp: 1500, prev_close: 1490 } },
              ),
            ),
          )
        }),
    })
    const { rerender } = await render(h.wrap(<WatchlistScreen />))
    await settle()
    replies[0]?.(['NIFTY25NOV25FUT'])
    await settle()
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    // a refocus asks for RELIANCE only; the session turns active while that is out
    screenActive.mockReturnValue(false)
    await rerender(h.wrap(<WatchlistScreen />))
    screenActive.mockReturnValue(true)
    await rerender(h.wrap(<WatchlistScreen />))
    await settle()
    expect(h.call.mock.calls[1]?.[1].symbols).toEqual([{ symbol: 'RELIANCE', exchange: 'NSE' }])
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    await settle()
    expect(h.count('multiquotes')).toBe(3)
    // the old reply refuses RELIANCE, the new one lists both: neither is badged
    replies[1]?.(['RELIANCE'])
    await settle()
    replies[2]?.([])
    await settle()
    expect(screen.queryByTestId('watch-unknown-NSE-RELIANCE')).toBeNull()
    expect(screen.queryByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeNull()
  })

  test('a new IST day forgets the refusals: the next focus asks once more', async () => {
    jest.setSystemTime(Date.UTC(2026, 10, 24, 9, 30)) // 15:00 IST
    const h = setup({
      live: false,
      seed: lists({
        id: 'a',
        name: 'Expired',
        items: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
      }),
      call: async () => {
        throw new ApiError({
          kind: 'Validation',
          status: 400,
          endpoint: 'multiquotes',
          serverMessage: GONE,
          invalidSymbols: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
        })
      },
    })
    const { rerender } = await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(h.count('multiquotes')).toBe(1)
    const refocus = async () => {
      screenActive.mockReturnValue(false)
      await rerender(h.wrap(<WatchlistScreen />))
      screenActive.mockReturnValue(true)
      await rerender(h.wrap(<WatchlistScreen />))
      await settle()
    }
    // the same IST day: nothing is asked again
    await refocus()
    expect(h.count('multiquotes')).toBe(1)
    jest.setSystemTime(Date.UTC(2026, 10, 25, 3, 45)) // 09:15 IST, the next day
    await refocus()
    expect(h.count('multiquotes')).toBe(2)
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    await later(10_000)
    expect(h.count('multiquotes')).toBe(2)
    expect(h.polling.stats().consumers).toBe(0)
  })

  test('RF 1: a list of only NIFTY25NOV25FUT gets a seed 400, then no more multiquotes', async () => {
    const h = setup({
      live: false, // polling mode: a live row would poll every 2 s
      seed: lists({
        id: 'a',
        name: 'Expired',
        items: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
      }),
      call: async (id) => {
        if (id !== 'multiquotes') throw new Error(`unexpected ${id}`)
        throw new ApiError({
          kind: 'Validation',
          status: 400,
          endpoint: 'multiquotes',
          serverMessage: GONE,
          invalidSymbols: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
        })
      },
    })
    const { rerender } = await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(h.count('multiquotes')).toBe(1)
    expect(screen.getByTestId('watch-row-NFO-NIFTY25NOV25FUT')).toHaveTextContent(
      /Expired or unknown/,
    )
    expect(screen.queryByTestId('watch-buy-NFO-NIFTY25NOV25FUT')).toBeNull()
    await later(10_000)
    expect(h.count('multiquotes')).toBe(1)
    // focusing again does not ask for it again
    screenActive.mockReturnValue(false)
    await rerender(h.wrap(<WatchlistScreen />))
    screenActive.mockReturnValue(true)
    await rerender(h.wrap(<WatchlistScreen />))
    await later(10_000)
    expect(h.count('multiquotes')).toBe(1)
    expect(h.count('symbol')).toBe(0)
    expect(h.polling.stats().consumers).toBe(0)
    expect(h.holds('NFO:NIFTY25NOV25FUT')).toBe(0)
  })

  test('a key the instrument cache already marks unknown is shown so and never seeded', async () => {
    const h = setup({
      seed: {
        ...lists({
          id: 'a',
          name: 'Mine',
          items: [
            { exchange: 'NSE', symbol: 'ITC' },
            { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
          ],
        }),
        'oa.p1.instruments': JSON.stringify({
          day: istDate(Date.now()),
          items: [],
          unknown: ['NFO:NIFTY25NOV25FUT'],
        }),
      },
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.getByTestId('watch-row-NFO-NIFTY25NOV25FUT')).toHaveTextContent(
      /Expired or unknown/,
    )
    expect(h.call.mock.calls.map((c) => c[1])).toEqual([
      { symbols: [{ symbol: 'ITC', exchange: 'NSE' }] },
    ])
  })

  test('blocked: focusing makes zero multiquotes calls; unblocking seeds', async () => {
    const h = setup({ live: true })
    useConnection.getState().set({ brokerSession: 'logged_out' })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await later(10_000)
    expect(screen.getByTestId('watch-row-NSE-RELIANCE')).toBeOnTheScreen()
    expect(h.count('multiquotes')).toBe(0)
    await act(async () => useConnection.getState().set({ keyState: 'invalid' }))
    await later(10_000)
    expect(h.count('multiquotes')).toBe(0)
    await act(async () => useConnection.getState().set({ brokerSession: 'active', keyState: 'ok' }))
    await settle()
    expect(h.count('multiquotes')).toBe(1)
  })
})
