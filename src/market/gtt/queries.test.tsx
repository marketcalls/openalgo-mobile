import { focusManager, onlineManager, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react-native'
import { useSyncExternalStore } from 'react'
import { Text } from 'react-native'
import type { z } from 'zod'
import type { Capabilities } from '~/core/capabilities/gates'
import { createCapabilityStore } from '~/core/capabilities/store'
import { profileStorage } from '~/core/config/storage'
import type { Api } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import { qk } from '~/core/query/keys'
import { createQueryClient } from '~/core/query/queryClient'
import { createOrderEventBus } from '~/core/realtime/orderEvents'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { TradingProvider } from '../trading'
import { useGttBook, useGttSupport } from './queries'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: jest.fn() }))
const screenActive = useScreenActive as jest.Mock

const T0 = Date.UTC(2026, 10, 24, 4, 0)
const PID = 'p1'

/** 2.0.1.6 without swagger: whether gttorderbook exists is unknown, so nothing rules GTT out. */
const CAPS: Capabilities = {
  host: 'https://algo.example.com',
  version: '2.0.1.6',
  versionSource: 'app-info',
  endpoints: null,
  probed: {},
  fields: {},
  features: {},
  ws: { orderStream: true, ping: true, close1012: false, authDeadline: true },
  probedAt: T0,
}

const ROW = {
  trigger_id: '1001',
  trigger_type: 'single',
  status: 'active',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  trigger_prices: [1500],
  last_price: 1800,
  legs: [{ action: 'SELL', quantity: 1, price: 1499, pricetype: 'LIMIT', product: 'CNC' }],
  created_at: '2026-11-24 09:30:00',
  updated_at: '2026-11-24 09:30:00',
  expires_at: '2027-11-24 09:30:00',
}

type Book = 'live' | 'analyze' | 'broker501' | 'network' | 'ratelimit'

/**
 * The book reply in LIVE (no mode), from the sandbox, or the broker's 501 (G3); or a read that
 * got no answer, or a 429. Neither of the last two records anything.
 */
function bookReply(book: Book, schema: z.ZodType) {
  if (book === 'broker501') {
    throw new ApiError({
      kind: 'Unsupported',
      status: 501,
      endpoint: 'gttorderbook',
      serverMessage: "GTT orders are not supported for broker 'zerodha' yet",
    })
  }
  if (book === 'network')
    throw new ApiError({ kind: 'Network', status: 0, endpoint: 'gttorderbook' })
  if (book === 'ratelimit') {
    throw new ApiError({ kind: 'RateLimited', status: 429, endpoint: 'gttorderbook' })
  }
  const body = { status: 'success', data: [ROW] }
  return schema.parse(book === 'analyze' ? { ...body, mode: 'analyze' } : body)
}

async function setup(o: { book?: Book; caps?: Capabilities } = {}) {
  let reads = 0
  const call = async (id: string, _body: unknown, schema: z.ZodType) => {
    if (id !== 'gttorderbook') throw new Error(`unexpected ${id}`)
    reads++
    return bookReply(o.book ?? 'live', schema)
  }
  const caps = createCapabilityStore(profileStorage(memoryKV(), PID))
  await caps.save(o.caps ?? CAPS)
  const queryClient = createQueryClient()
  const s = {
    api: { call } as unknown as Api,
    caps,
    queryClient,
    storage: profileStorage(memoryKV(), PID),
    // the feed and the connection name no broker: the profile's, from the ping, is the one
    realtime: { status: () => ({ broker: null }), onStatus: () => () => {} },
    profile: { get: () => ({ id: PID, broker: 'zerodha' }) },
    orderEvents: createOrderEventBus(),
  } as unknown as Services
  const mount = async (ui: React.ReactElement) => {
    await render(
      <ServicesProvider value={s}>
        <TradingProvider now={Date.now}>
          <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
        </TradingProvider>
      </ServicesProvider>,
    )
    await pass(0)
  }
  return { caps, queryClient, reads: () => reads, mount }
}

const pass = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })

/** A boolean a test flips from outside the tree, read by components as an external store. */
function flag(initial: boolean) {
  let v = initial
  const fns = new Set<() => void>()
  return {
    get: () => v,
    set(next: boolean) {
      v = next
      for (const fn of fns) fn()
    },
    subscribe(fn: () => void) {
      fns.add(fn)
      return () => {
        fns.delete(fn)
      }
    },
  }
}
type Flag = ReturnType<typeof flag>
const useFlag = (f: Flag) => useSyncExternalStore(f.subscribe, f.get)

/**
 * The app goes to the background and comes back. The screens' `useScreenActive` follows
 * AppState, so their queries unsubscribe and subscribe again, and TanStack's focus event fires.
 */
async function background(app: Flag) {
  await act(async () => {
    app.set(false)
    focusManager.setFocused(false)
  })
  await pass(0)
  await act(async () => {
    app.set(true)
    focusManager.setFocused(true)
  })
  await pass(0)
}

/** The phone's network drops and comes back. */
async function reconnect() {
  await act(async () => onlineManager.setOnline(false))
  await pass(0)
  await act(async () => onlineManager.setOnline(true))
  await pass(0)
}

const Support = ({ id = 'gtt', exchange = 'NSE' }: { id?: string; exchange?: string }) => {
  const g = useGttSupport(exchange)
  return <Text testID={id}>{g.state}</Text>
}

/** A `Support` mounted while `when` is true. */
const Shown = ({ when, id }: { when: Flag; id: string }) =>
  useFlag(when) ? <Support id={id} /> : null

const BookProbe = ({ enabled }: { enabled?: boolean }) => {
  const q = useGttBook(enabled === undefined ? undefined : { enabled })
  return <Text testID="book">{q.data ? `${q.data.rows.length} rows` : '-'}</Text>
}

const state = (id = 'gtt') => screen.getByTestId(id).props.children

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  keepExpectedLogs()
  screenActive.mockReturnValue(true)
  useConnection.getState().reset()
  useConnection.getState().set({ brokerSession: 'active', keyState: 'ok', analyzer: 'live' })
})
afterEach(() => {
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('useGttSupport', () => {
  test("support unknown: mounting reads gttorderbook once, and a success makes it 'yes'", async () => {
    const h = await setup()
    await h.mount(<Support />)
    expect(h.reads()).toBe(1)
    expect(state()).toBe('yes')
    expect(h.caps.get()?.features).toEqual({ 'gtt:zerodha:live': true })
    await pass(30_000)
    expect(h.reads()).toBe(1)
  })

  test("a 501 makes it 'no', and nothing more is read within 30 s", async () => {
    expectLog('warn', /GTT support read failed/)
    const h = await setup({ book: 'broker501' })
    await h.mount(<Support />)
    expect(h.reads()).toBe(1)
    expect(state()).toBe('no')
    expect(h.caps.get()?.features).toEqual({ 'gtt:zerodha:live': false })
    await pass(30_000)
    expect(h.reads()).toBe(1)
  })

  test('(RF 2) with the badge LIVE, a book reply in ANALYZE is recorded for ANALYZE, not LIVE', async () => {
    const h = await setup({ book: 'analyze' })
    await h.mount(<Support />)
    expect(h.reads()).toBe(1)
    expect(h.caps.get()?.features).toEqual({ 'gtt:zerodha:analyze': true })
    expect(state()).toBe('unknown')
  })

  test('two screens waiting on the same answer share one read', async () => {
    const h = await setup()
    await h.mount(
      <>
        <Support id="a" />
        <Support id="b" />
      </>,
    )
    expect(h.reads()).toBe(1)
    expect([state('a'), state('b')]).toEqual(['yes', 'yes'])
  })

  // Design 12: the GTT book is read on demand only, and detection is ONE read. A read that
  // cannot settle the answer leaves it unknown, and still nothing reads it again.
  test.each([
    ['a network failure', 'network', {}],
    ['a 429', 'ratelimit', {}],
    ['a reply in the other mode', 'analyze', { 'gtt:zerodha:analyze': true }],
  ] as const)(
    'a detection read that settles nothing (%s) is not repeated: not by a second screen, a remount, a foreground or a reconnect',
    async (_, book, features) => {
      if (book !== 'analyze') expectLog('warn', /GTT support read failed/)
      const app = flag(true)
      screenActive.mockImplementation(() => useFlag(app))
      const second = flag(true)
      const h = await setup({ book })
      await h.mount(
        <>
          <Support id="a" />
          <Shown when={second} id="b" />
        </>,
      )
      expect(h.reads()).toBe(1)
      expect(h.caps.get()?.features).toEqual(features)
      expect([state('a'), state('b')]).toEqual(['unknown', 'unknown'])
      // past the client's 5 s staleTime, where a remount or a focus would read a stale query again
      await pass(10_000)
      expect(h.reads()).toBe(1)

      await act(async () => second.set(false))
      await pass(0)
      expect(screen.queryByTestId('b')).toBeNull()
      await act(async () => second.set(true))
      await pass(0)
      expect(state('b')).toBe('unknown')

      await background(app)
      await reconnect()
      await pass(30_000)
      expect(h.reads()).toBe(1)
      expect([state('a'), state('b')]).toEqual(['unknown', 'unknown'])
    },
  )

  test('the detection runs again only for a new key: another mode, a re-probe or another broker, never a book poke', async () => {
    const failed = expectLog('warn', /GTT support read failed/)
    const h = await setup({ book: 'network' })
    await h.mount(<Support />)
    expect(h.reads()).toBe(1)
    await pass(10_000)
    expect(h.reads()).toBe(1)

    // a write or an order event pokes the books; detection is not one of them
    await act(async () => void h.queryClient.invalidateQueries({ queryKey: qk.gttbook(PID) }))
    await pass(0)
    expect(h.reads()).toBe(1)

    // ANALYZE has not been checked: one read; back in LIVE, already read for this probe
    await act(async () => useConnection.getState().set({ analyzer: 'analyze' }))
    await pass(0)
    expect(h.reads()).toBe(2)
    await act(async () => useConnection.getState().set({ analyzer: 'live' }))
    await pass(0)
    expect(h.reads()).toBe(2)

    // a re-probe forgets the features: LIVE is checked again, once
    await act(async () => h.caps.save({ ...CAPS, probedAt: T0 + 60_000 }))
    await pass(0)
    expect(h.reads()).toBe(3)

    // the server now names another broker: it is checked afresh, once
    await act(async () => useConnection.getState().set({ broker: 'dhan' }))
    await pass(0)
    expect(h.reads()).toBe(4)
    await pass(30_000)
    expect(h.reads()).toBe(4)
    expect(failed).toHaveLength(4)
    expect(state()).toBe('unknown')
  })

  test('support already known: nothing is read', async () => {
    const h = await setup({ caps: { ...CAPS, features: { 'gtt:zerodha:live': true } } })
    await h.mount(<Support />)
    expect(state()).toBe('yes')
    await pass(30_000)
    expect(h.reads()).toBe(0)
  })

  test('an index: no, and nothing is read', async () => {
    const h = await setup()
    await h.mount(<Support exchange="NSE_INDEX" />)
    expect(state()).toBe('no')
    expect(h.reads()).toBe(0)
  })

  test('mode unknown: nothing is read until the badge has a mode', async () => {
    useConnection.getState().set({ analyzer: 'unknown' })
    const h = await setup()
    await h.mount(<Support />)
    expect(state()).toBe('unknown')
    expect(h.reads()).toBe(0)
    await act(async () => useConnection.getState().set({ analyzer: 'live' }))
    await pass(0)
    expect(h.reads()).toBe(1)
    expect(state()).toBe('yes')
  })

  test('blocked: nothing is read', async () => {
    useConnection.getState().set({ brokerSession: 'logged_out' })
    const h = await setup()
    await h.mount(<Support />)
    expect(state()).toBe('unknown')
    expect(h.reads()).toBe(0)
  })

  test('the screen not focused: nothing is read', async () => {
    screenActive.mockReturnValue(false)
    const h = await setup()
    await h.mount(<Support />)
    expect(state()).toBe('unknown')
    expect(h.reads()).toBe(0)
  })
})

describe('useGttBook', () => {
  test('reads the GTT book', async () => {
    const h = await setup()
    await h.mount(<BookProbe />)
    expect(h.reads()).toBe(1)
    expect(screen.getByTestId('book').props.children).toBe('1 rows')
  })

  test('enabled false reads nothing', async () => {
    const h = await setup()
    await h.mount(<BookProbe enabled={false} />)
    expect(h.reads()).toBe(0)
    expect(screen.getByTestId('book').props.children).toBe('-')
  })
})
