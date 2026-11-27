import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { StyleSheet } from 'react-native'
import InstrumentRoute from '~/app/(app)/instrument/[key]'
import OptionChainRoute from '~/app/(app)/optionchain/[key]'
import ToolRoute from '~/app/(app)/tools/[toolId]'
import type { Capabilities } from '~/core/capabilities/gates'
import { profileStorage } from '~/core/config/storage'
import { createOrderEventBus } from '~/core/realtime/orderEvents'
import type { QuotePatch } from '~/core/realtime/protocol'
import type { SubRequest } from '~/core/realtime/subscriptions'
import { createTickStore } from '~/core/realtime/tickStore'
import { LiveContext, type LiveServices } from '~/core/realtime/useLive'
import { TickStoreContext } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import { chartHref, depthHref, optionChainHref, ticketHref } from '~/market/links'
import { liveChain } from '~/market/options/live'
import { type ChainLeg, type OptionChain, OptionChainSchema } from '~/market/options/schemas'
import { TradingProvider } from '~/market/trading'
import { fmtOi, fmtPrice } from '~/ui/format'
import { ToastHost } from '~/ui/Toast'
import { buildTheme } from '~/ui/theme'
import { chainReply } from '../../../test/helpers/chains'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { CHAIN_LINK_INCOMPLETE, legTicket, OptionChainScreen, targetFromKey, targetFromU } from '.'
import { chainSession, type LadderRow, ladderItems } from './model'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: jest.fn() }))
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() }
let mockParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}))
// FlashList measures native layout, which jest has none of: this stand-in renders every item and
// records what the screen asked of the list (its props at each render, its mounts, its scrolls).
const mockList = {
  props: [] as Record<string, unknown>[],
  mounts: 0,
  scrollToIndex: jest.fn(),
}
jest.mock('@shopify/flash-list', () => {
  const { createElement, Fragment, useEffect, useImperativeHandle } = require('react')
  const { ScrollView } = require('react-native')
  type MockListProps = {
    ref?: unknown
    testID?: string
    data: unknown[]
    keyExtractor: (item: unknown, i: number) => string
    renderItem: (info: { item: unknown; index: number }) => unknown
  }
  function FlashList(p: MockListProps) {
    useEffect(() => {
      mockList.mounts++
    }, [])
    useImperativeHandle(p.ref, () => ({ scrollToIndex: mockList.scrollToIndex }))
    mockList.props.push(p as unknown as Record<string, unknown>)
    return createElement(
      ScrollView,
      { testID: p.testID },
      p.data.map((item, index) =>
        createElement(
          Fragment,
          { key: p.keyExtractor(item, index) },
          p.renderItem({ item, index }),
        ),
      ),
    )
  }
  return { FlashList }
})

const PID = 'p1'
const EXPIRIES = ['02-DEC-26', '09-DEC-26', '30-DEC-26']
const NOW = Date.UTC(2026, 10, 30, 5, 0) // Mon 30 Nov 2026, 10:30 IST
const HOME = 'http://192.168.1.20:5000'
const TUNNEL = 'https://x.ngrok-free.app'
const { c, trade } = buildTheme('dark')

const capsOf = (version: string): Capabilities => ({
  host: 'https://algo.example.com',
  version,
  versionSource: 'app-info',
  endpoints: [],
  probed: {},
  fields: {},
  features: {},
  ws: { orderStream: true, ping: true, close1012: true, authDeadline: true },
  probedAt: 1,
})

type Body = Record<string, unknown>
type Answer = (body: Body) => unknown

type SetupOptions = {
  version?: string
  origin?: string
  /** Server minus device, as the clock read it from the `Date` header. */
  offsetMs?: number
  answers?: Record<string, Answer>
}

function setup(o: SetupOptions = {}) {
  const version = o.version ?? '2.0.3.5'
  const old = version === '2.0.0.0'
  const caps = capsOf(version)
  const store = createTickStore((fn) => fn(), { evictAfterMs: 0 })
  const answers: Record<string, Answer> = {
    expiry: () => ({ status: 'success', data: EXPIRIES }),
    optionchain: (b) =>
      chainReply({ expiry: String(b.expiry_date), each: Number(b.strike_count), old }),
    symbol: (b) => ({
      status: 'success',
      data: { symbol: b.symbol, exchange: b.exchange, name: `${b.symbol}`, lotsize: 1 },
    }),
    ...o.answers,
  }
  const call = jest.fn(async (id: string, body: Body, schema: { parse(v: unknown): unknown }) => {
    const a = answers[id]
    if (!a) throw new Error(`unexpected ${id}`)
    return schema.parse(await a(body))
  })
  const releases: jest.Mock[] = []
  const acquire = jest.fn((_r: SubRequest) => {
    const release = jest.fn()
    releases.push(release)
    return release
  })
  const realtime = {
    acquire,
    isLive: () => false,
    confirmedDepth: () => undefined,
    status: () => ({ broker: null }),
    onStatus: () => () => {},
  }
  const polling = { register: () => () => {}, health: () => 'none', onHealth: () => () => {} }
  const live = { realtime, polling, store } as unknown as LiveServices
  const offset = o.offsetMs ?? 0
  const clock = {
    now: () => Date.now() + offset,
    offsetMs: () => offset,
    noteServerTs: jest.fn(),
    noteDate: jest.fn(),
  }
  // no gc timer: it would hold the test process open
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  })
  const services = {
    api: {
      call,
      get: jest.fn(async () => {
        throw new Error('no instruments here')
      }),
    },
    store,
    realtime,
    polling,
    caps: { get: () => caps, subscribe: () => () => {}, setFeature: jest.fn() },
    clock,
    queryClient: client,
    storage: profileStorage(memoryKV(), PID),
    profile: { get: () => ({ id: PID, broker: null, restOrigin: o.origin ?? HOME }) },
    orderEvents: createOrderEventBus(),
  } as unknown as Services
  const tree = (node: ReactElement) => (
    <ServicesProvider value={services}>
      <TradingProvider now={Date.now}>
        <QueryClientProvider client={client}>
          <TickStoreContext.Provider value={store}>
            <LiveContext.Provider value={live}>
              {node}
              <ToastHost />
            </LiveContext.Provider>
          </TickStoreContext.Provider>
        </QueryClientProvider>
      </TradingProvider>
    </ServicesProvider>
  )
  let view: Awaited<ReturnType<typeof render>> | null = null
  return {
    store,
    call,
    acquire,
    releases,
    tree,
    async show(node: ReactElement = <OptionChainScreen initial={null} />) {
      view = await render(tree(node))
      await settle()
      return view
    },
    async rerender(node: ReactElement = <OptionChainScreen initial={null} />) {
      await view?.rerender(tree(node))
      await settle()
    },
    /** The bodies of each read of `id`, in order. */
    bodies: (id: string) => call.mock.calls.filter(([i]) => i === id).map(([, b]) => b),
    ids: () => call.mock.calls.map(([i]) => i),
    tick: (key: string, patch: QuotePatch) => act(async () => store.put(key, patch, 'ws')),
  }
}

const settle = () =>
  act(async () => {
    // react-query tells its observers from a 0 ms timer
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })

const press = (id: string) => act(async () => fireEvent.press(screen.getByTestId(id)))
const text = (id: string) => {
  const parts: string[] = []
  const walk = (n: unknown): void => {
    if (typeof n === 'string') parts.push(n)
    else if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object' && 'children' in n)
      walk((n as { children: unknown }).children)
  }
  walk(screen.getByTestId(id).children)
  return parts.join(' ')
}

/** The chain the fake server sends for these reads, parsed as the app parses it. */
const chainOf = (spec: Parameters<typeof chainReply>[0] = {}): OptionChain =>
  OptionChainSchema.parse(chainReply(spec))
/** The ATM (nearest-strike) call of the default chain: spot 24567.8, so 24550. */
const ATM = 24550
const legAt = (ch: OptionChain, strike: number, side: 'ce' | 'pe'): ChainLeg => {
  const leg = ch.chain.find((r) => r.strike === strike)?.[side]
  if (!leg) throw new Error(`no ${side} at ${strike}`)
  return leg
}

beforeEach(() => {
  ;(useScreenActive as jest.Mock).mockReturnValue(true)
  useConnection.getState().reset()
  mockList.props.length = 0
  mockList.mounts = 0
  chainSession.view = 'price'
  chainSession.greeks = ['iv', 'delta']
  mockParams = {}
  keepExpectedLogs()
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  jest.clearAllMocks()
})

describe('model', () => {
  test('links name the chain by the underlying or by the options exchange', () => {
    expect(targetFromKey('NSE_INDEX:NIFTY')).toEqual({
      optionsExchange: 'NFO',
      underlying: 'NIFTY',
    })
    expect(targetFromKey('NSE_INDEX%3ANIFTY')).toEqual({
      optionsExchange: 'NFO',
      underlying: 'NIFTY',
    })
    expect(targetFromKey('BSE_INDEX:SENSEX')).toEqual({
      optionsExchange: 'BFO',
      underlying: 'SENSEX',
    })
    expect(targetFromKey('NSE:M&M')).toEqual({ optionsExchange: 'NFO', underlying: 'M&M' })
    expect(targetFromKey('MCX:CRUDEOIL')).toEqual({
      optionsExchange: 'MCX',
      underlying: 'CRUDEOIL',
    })
    expect(targetFromU('NFO:NIFTY')).toEqual({ optionsExchange: 'NFO', underlying: 'NIFTY' })
    expect(targetFromU(undefined)).toBeNull()
    for (const bad of ['', 'NIFTY', 'NSE_INDEX:', 'MCX_INDEX:MCXCOMDEX', 'NFO:nifty', 'NFO:A B']) {
      expect(targetFromKey(bad)).toBeNull()
    }
  })

  test('legTicket: BUY at ask, SELL at bid, LTP when the book is empty, MARKET when nothing is priced; quantity in units', () => {
    const leg = legAt(chainOf(), ATM, 'ce')
    const priced = { ...leg, ltp: 120.5, bid: 120.45, ask: 120.55, lotsize: 75 }
    const base = { exchange: 'NFO', symbol: leg.symbol, quantity: 150 }
    expect(legTicket(priced, 'BUY', 2, 'NFO')).toEqual({
      ...base,
      action: 'BUY',
      pricetype: 'LIMIT',
      price: 120.55,
    })
    expect(legTicket(priced, 'SELL', 2, 'NFO')).toEqual({
      ...base,
      action: 'SELL',
      pricetype: 'LIMIT',
      price: 120.45,
    })
    const bookless = { ...priced, bid: 0, ask: 0 }
    expect(legTicket(bookless, 'BUY', 2, 'NFO')).toMatchObject({ pricetype: 'LIMIT', price: 120.5 })
    expect(legTicket(bookless, 'SELL', 2, 'NFO')).toMatchObject({
      pricetype: 'LIMIT',
      price: 120.5,
    })
    const unpriced = { ...bookless, ltp: 0 }
    expect(legTicket(unpriced, 'BUY', 3, 'BFO')).toEqual({
      exchange: 'BFO',
      symbol: leg.symbol,
      action: 'BUY',
      pricetype: 'MARKET',
      quantity: 225,
    })
  })

  test('one live spot marks ATM, the money and its own place (ux OC-3)', () => {
    const rows = [24400, 24500, 24600].map((strike) => ({ strike, ce: null, pe: null }))
    const { items, atmIndex } = ladderItems(rows, 24567.8)
    expect(items.map((i) => (i.kind === 'spot' ? 'spot' : i.row.strike))).toEqual([
      24400,
      24500,
      'spot',
      24600,
    ])
    expect(atmIndex).toBe(3)
    const marks = items.filter((i): i is LadderRow => i.kind === 'row')
    expect(marks.map((m) => [m.atm, m.ceItm, m.peItm])).toEqual([
      [false, true, false],
      [false, true, false],
      [true, false, true],
    ])
    expect(ladderItems(rows, 24300).items[0]).toEqual({ kind: 'spot', spot: 24300 })
    expect(ladderItems(rows, 24700).items.at(-1)).toEqual({ kind: 'spot', spot: 24700 })
  })
})

describe('the screen', () => {
  test('opens on NIFTY NFO nearest expiry with 21 rows and ATM in view', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    const h = setup()
    await h.show()
    // the budget's first load: one expiry read, one chain (design 12)
    expect(h.call.mock.calls.map(([id, body]) => [id, body])).toEqual([
      ['expiry', { symbol: 'NIFTY', exchange: 'NFO', instrumenttype: 'options' }],
      [
        'optionchain',
        {
          underlying: 'NIFTY',
          exchange: 'NFO',
          expiry_date: '02DEC26',
          strike_count: 10,
          with_greeks: true,
        },
      ],
    ])
    expect(text('oc-underlying')).toContain('NIFTY')
    expect(text('oc-expiry-0')).toBe('02 Dec · 2d')
    expect(text('oc-count')).toBe('±10')
    expect(screen.getAllByTestId(/^oc-row-/)).toHaveLength(21)
    // ATM is the strike nearest the spot, centred at the first layout
    const atmRow = screen.getByTestId(`oc-row-${ATM}`)
    expect(within(atmRow).getByTestId('oc-ce-ATM')).toBeTruthy()
    expect(within(atmRow).getByTestId('oc-pe-ATM')).toBeTruthy()
    const list = mockList.props.at(-1) as {
      initialScrollIndex: number
      initialScrollIndexParams: { viewOffset: number }
    }
    expect(list.initialScrollIndex).toBe(10)
    expect(list.initialScrollIndexParams.viewOffset).toBeLessThan(0)
    // the spot sits between the strikes around it
    const order = screen
      .getAllByTestId(/^oc-(row-\d+|spot)$/)
      .map((n) => String(n.props.testID))
      .slice(10, 13)
    expect(order).toEqual([`oc-row-${ATM}`, 'oc-spot', 'oc-row-24600'])
    // only the ladder scrolls: the header and the column heads are outside it (ux OC-1)
    const ladder = screen.getByTestId('oc-ladder')
    expect(within(ladder).queryByTestId('oc-colhead')).toBeNull()
    expect(within(ladder).queryByTestId('oc-expiry-0')).toBeNull()
    expect(screen.getByTestId('oc-colhead')).toBeTruthy()
    expect(text('oc-footer')).toMatch(/^PCR \d\.\d\d · CE OI .+ · PE OI .+ · Updated 10:30:00$/)
  })

  test('a cell reads as a sentence; OI bars are neutral and the largest OI is bold', async () => {
    const h = setup()
    await h.show()
    const ch = chainOf()
    const atm = legAt(ch, ATM, 'ce')
    expect(screen.getByTestId('oc-ce-ATM').props.accessibilityLabel).toBe(
      `NIFTY 24,550 call, LTP ${fmtPrice(atm.ltp)}, OI ${fmtOi(atm.oi).replace('L', ' lakh')}`,
    )
    const bar = StyleSheet.flatten(screen.getByTestId('oc-oibar-ce-24550').props.style)
    expect([trade.profit, trade.loss, trade.buy, trade.sell]).not.toContain(bar.backgroundColor)
    expect(String(bar.backgroundColor).startsWith(c.foreground)).toBe(true)
    // the ATM row holds the largest OI each side (the fixture's OI falls away from it)
    const oi = StyleSheet.flatten(screen.getByTestId('oc-ce-oi-24550').props.style)
    expect(oi.fontWeight).toBe('700')
    expect(
      StyleSheet.flatten(screen.getByTestId('oc-ce-oi-24600').props.style).fontWeight,
    ).not.toBe('700')
    // a number on the ATM band keeps the foreground colour (ux G20)
    expect(StyleSheet.flatten(screen.getByTestId('oc-ce-ltp-24550').props.style).color).toBe(
      c.foreground,
    )
    expect(h.ids()).not.toContain('search')
  })

  test('Greeks view shows IV and delta per side; a 2.0.0.0 server still shows them, from the derived expiry and the Date clock (RF 4)', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    const h = setup({ version: '2.0.0.0', offsetMs: 180_000 })
    await h.show()
    // an older server is never sent with_greeks
    expect(h.bodies('optionchain')[0]).not.toHaveProperty('with_greeks')
    await press('oc-greeks')
    const want = liveChain(chainOf({ old: true }), () => undefined, {
      optionsExchange: 'NFO',
      underlyingKey: 'NSE_INDEX:NIFTY',
      clockOffsetMs: 180_000,
    })
    const ce = legAt(want, ATM, 'ce')
    const pe = legAt(want, ATM, 'pe')
    expect(ce.implied_volatility).toBeGreaterThan(0)
    expect(text('oc-colhead')).toBe('IV Delta Strike Delta IV')
    expect(text('oc-ce-ATM')).toBe(`${fmtPrice(ce.implied_volatility, 2)} ${fmtPrice(ce.delta, 4)}`)
    expect(text('oc-pe-ATM')).toBe(`${fmtPrice(pe.delta, 4)} ${fmtPrice(pe.implied_volatility, 2)}`)
    // the view and the pair stay for the session (ux OC-9)
    expect(chainSession.view).toBe('greeks')
  })

  test('the Greek chips switch to gamma and vega, two at a time', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    const h = setup()
    await h.show()
    await press('oc-greeks')
    await press('oc-greek-gamma')
    expect(text('oc-colhead')).toBe('Delta Gamma Strike Gamma Delta')
    await press('oc-greek-vega')
    expect(text('oc-colhead')).toBe('Gamma Vega Strike Vega Gamma')
    const want = liveChain(chainOf(), () => undefined, {
      optionsExchange: 'NFO',
      underlyingKey: 'NSE_INDEX:NIFTY',
      clockOffsetMs: 0,
    })
    const ce = legAt(want, ATM, 'ce')
    expect(text('oc-ce-ATM')).toBe(`${fmtPrice(ce.gamma, 4)} ${fmtPrice(ce.vega, 2)}`)
    expect(screen.getByTestId('oc-greek-vega').props.accessibilityState).toMatchObject({
      selected: true,
    })
    expect(screen.getByTestId('oc-greek-iv').props.accessibilityState).toMatchObject({
      selected: false,
    })
    // a picked chip stays as it is
    await press('oc-greek-vega')
    expect(text('oc-colhead')).toBe('Gamma Vega Strike Vega Gamma')
  })

  test('on 2.0.0.0 the feed holds NSE_INDEX:NIFTY for the underlying (RF 4)', async () => {
    const h = setup({ version: '2.0.0.0' })
    await h.show()
    const held = h.acquire.mock.calls.map(([r]) => r)
    expect(held).toContainEqual({ exchange: 'NSE_INDEX', symbol: 'NIFTY', mode: 2 })
    const legs = held.filter((r) => r.exchange === 'NFO')
    expect(legs).toHaveLength(42)
    expect(legs.every((r) => r.mode === 3 && r.depth === 5)).toBe(true)
    // the underlying's tick drives the header
    await h.tick('NSE_INDEX:NIFTY', { ltp: 24601.25, close: 24447.8 })
    expect(text('oc-spot-ltp')).toBe('24,601.25')
  })

  test('tapping a CE opens the leg sheet; BUY pushes a LIMIT ticket for 2 lots in units', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    const h = setup()
    await h.show()
    const leg = legAt(chainOf(), ATM, 'ce')
    await press('oc-ce-ATM')
    expect(screen.getByTestId('oc-leg-sheet')).toBeTruthy()
    expect(text('oc-leg-title')).toBe('NIFTY 24,550 CE')
    expect(text('oc-leg-sub')).toBe('02 Dec 26 · NFO · Lot 75')
    expect(text('oc-leg-lots')).toBe('1 lot · 75 qty')
    await press('oc-leg-lots-inc')
    expect(text('oc-leg-lots')).toBe('2 lots · 150 qty')
    expect(text('oc-leg-buy-caption')).toBe(`at ${fmtPrice(leg.ask)} ask`)
    expect(text('oc-leg-sell-caption')).toBe(`at ${fmtPrice(leg.bid)} bid`)
    expect(text('oc-leg-greeks')).toMatch(/IV .+Delta .+Gamma .+Theta .+Vega /)
    // the sheet follows the leg's own ticks: a new ask is the new BUY price
    await h.tick(`NFO:${leg.symbol}`, {
      ltp: 131.2,
      depth: {
        buy: [{ price: 131.1, quantity: 75 }],
        sell: [{ price: 131.35, quantity: 150 }],
        levels: 1,
      },
    })
    expect(text('oc-leg-buy-caption')).toBe('at 131.35 ask')
    await press('oc-leg-buy')
    expect(mockRouter.push).toHaveBeenLastCalledWith(
      ticketHref({
        exchange: 'NFO',
        symbol: leg.symbol,
        action: 'BUY',
        pricetype: 'LIMIT',
        price: 131.35,
        quantity: 150,
      }),
    )
    await press('oc-leg-sell')
    expect(mockRouter.push).toHaveBeenLastCalledWith(
      ticketHref({
        exchange: 'NFO',
        symbol: leg.symbol,
        action: 'SELL',
        pricetype: 'LIMIT',
        price: 131.1,
        quantity: 150,
      }),
    )
    // BUY is green and on the left, SELL red (Button's own variants)
    const pair = screen.getByTestId('oc-leg-trade')
    const ids = within(pair)
      .getAllByRole('button')
      .map((b) => b.props.testID)
    expect(ids).toEqual(['oc-leg-buy', 'oc-leg-sell'])
    expect(StyleSheet.flatten(screen.getByTestId('oc-leg-buy').props.style).backgroundColor).toBe(
      trade.buy,
    )
  })

  test('chart and depth open from the leg sheet', async () => {
    const h = setup()
    await h.show()
    const leg = legAt(chainOf(), 24600, 'pe')
    await press('oc-pe-24600')
    await press('oc-leg-chart')
    expect(mockRouter.push).toHaveBeenLastCalledWith(chartHref('NFO', leg.symbol))
    await press('oc-leg-depth')
    expect(mockRouter.push).toHaveBeenLastCalledWith(depthHref('NFO', leg.symbol))
  })

  test('switching expiry twice fast renders only the last reply (RF 3)', async () => {
    const held = new Map<string, (v: unknown) => void>()
    const h = setup({
      answers: {
        optionchain: (b) => {
          const expiry = String(b.expiry_date)
          const reply = chainReply({ expiry, bump: expiry === '30DEC26' ? 7 : 3 })
          if (expiry === '02DEC26') return reply
          return new Promise((resolve) => held.set(expiry, () => resolve(reply)))
        },
      },
    })
    await h.show()
    await press('oc-expiry-1')
    expect(screen.getByTestId('oc-skeleton')).toBeTruthy()
    await press('oc-expiry')
    await press('oc-expiry-row-2')
    expect(h.bodies('optionchain').map((b) => b.expiry_date)).toEqual([
      '02DEC26',
      '09DEC26',
      '30DEC26',
    ])
    await act(async () => held.get('30DEC26')?.(null))
    await settle()
    await act(async () => held.get('09DEC26')?.(null))
    await settle()
    const last = legAt(chainOf({ expiry: '30DEC26', bump: 7 }), ATM, 'ce')
    const stale = legAt(chainOf({ expiry: '09DEC26', bump: 3 }), ATM, 'ce')
    expect(text(`oc-ce-ltp-${ATM}`)).toBe(fmtPrice(last.ltp))
    expect(text(`oc-ce-ltp-${ATM}`)).not.toBe(fmtPrice(stale.ltp))
    expect(screen.queryByTestId('oc-skeleton')).toBeNull()
    expect(text('oc-expiry')).toBe('30 Dec ▾')
  })

  test('live: optionchain every 30 s; polling home 5 s, tunnel 10 s; hidden: none (RF 3)', async () => {
    jest.useFakeTimers({ now: NOW })
    const advance = (ms: number) => act(async () => void (await jest.advanceTimersByTimeAsync(ms)))
    const h = setup({ origin: HOME })
    await render(h.tree(<OptionChainScreen initial={null} />))
    await advance(0)
    const chains = () => h.bodies('optionchain').length
    expect(chains()).toBe(1)
    await advance(29_000)
    expect(chains()).toBe(1)
    await advance(1_000)
    expect(chains()).toBe(2)
    // a refetch never moves the ladder (ux OC-4)
    expect(mockList.scrollToIndex).not.toHaveBeenCalled()
    expect(mockList.mounts).toBe(1)

    await act(async () => useConnection.getState().set({ feed: 'polling' }))
    expect(text('oc-polling-note')).toBe('Polling: prices refresh every 5 s.')
    await advance(5_000)
    expect(chains()).toBe(3)
    await advance(5_000)
    expect(chains()).toBe(4)

    ;(useScreenActive as jest.Mock).mockReturnValue(false)
    await screen.rerender(h.tree(<OptionChainScreen initial={null} />))
    await advance(60_000)
    expect(chains()).toBe(4)
    expect(h.ids().filter((id) => id === 'expiry')).toHaveLength(1)
    await screen.unmount()

    const t = setup({ origin: TUNNEL })
    ;(useScreenActive as jest.Mock).mockReturnValue(true)
    await render(t.tree(<OptionChainScreen initial={null} />))
    await advance(0)
    expect(text('oc-polling-note')).toBe('Polling: prices refresh every 10 s.')
    await advance(9_000)
    expect(t.bodies('optionchain')).toHaveLength(1)
    await advance(1_000)
    expect(t.bodies('optionchain')).toHaveLength(2)
  })

  test('legs are held at Depth while active and all released on blur', async () => {
    const h = setup()
    await h.show()
    expect(h.acquire).toHaveBeenCalledTimes(43)
    expect(h.acquire).toHaveBeenCalledWith({ exchange: 'NSE_INDEX', symbol: 'NIFTY', mode: 2 })
    expect(h.releases.every((r) => r.mock.calls.length === 0)).toBe(true)
    // a refetch of the same chain holds nothing again
    await act(async () => h.store.put('NSE_INDEX:NIFTY', { ltp: 24570 }, 'ws'))
    expect(h.acquire).toHaveBeenCalledTimes(43)
    ;(useScreenActive as jest.Mock).mockReturnValue(false)
    await h.rerender()
    expect(h.releases).toHaveLength(43)
    expect(h.releases.every((r) => r.mock.calls.length === 1)).toBe(true)
  })

  test('±25 strikes: 51 rows, at most 103 symbols held, the ladder centred anew', async () => {
    const h = setup()
    await h.show()
    expect(mockList.mounts).toBe(1)
    await press('oc-count')
    await press('oc-count-25')
    await settle()
    expect(h.bodies('optionchain').at(-1)).toMatchObject({ strike_count: 25 })
    expect(text('oc-count')).toBe('±25')
    expect(screen.getAllByTestId(/^oc-row-/)).toHaveLength(51)
    // the ±10 holds went with the old chain; the new one holds its 102 legs and the underlying
    expect(h.releases.slice(0, 43).every((r) => r.mock.calls.length === 1)).toBe(true)
    expect(h.acquire).toHaveBeenCalledTimes(43 + 103)
    expect(mockList.mounts).toBe(2)
    expect((mockList.props.at(-1) as { initialScrollIndex: number }).initialScrollIndex).toBe(25)
  })

  test('polling holds nothing on the feed; a stale store is not merged into the chain', async () => {
    useConnection.getState().set({ feed: 'polling' })
    const h = setup()
    const leg = legAt(chainOf(), ATM, 'ce')
    h.store.put(`NFO:${leg.symbol}`, { ltp: 999 }, 'ws')
    await h.show()
    expect(h.acquire).not.toHaveBeenCalled()
    expect(text(`oc-ce-ltp-${ATM}`)).toBe(fmtPrice(leg.ltp))
  })

  test('first load is a skeleton; a failed read offers Try again; an empty chain says what to do', async () => {
    let fail = true
    const h = setup({
      answers: {
        optionchain: (b) => {
          if (fail) throw new Error('down')
          return { ...chainReply({ expiry: String(b.expiry_date) }), chain: [] }
        },
      },
    })
    await render(h.tree(<OptionChainScreen initial={null} />))
    expect(screen.getByTestId('oc-skeleton')).toBeTruthy()
    expect(screen.getAllByTestId(/^oc-skeleton-row-/)).toHaveLength(11)
    // the header is usable meanwhile
    expect(screen.getByTestId('oc-underlying')).toBeTruthy()
    await settle()
    expect(screen.getByTestId('oc-error')).toBeTruthy()
    fail = false
    await act(async () => fireEvent.press(screen.getByText('Try again')))
    await settle()
    expect(screen.getByText('No strikes for NIFTY 02 Dec.')).toBeTruthy()
    await press('oc-empty-expiry')
    expect(screen.getByTestId('oc-expiry-sheet')).toBeTruthy()
  })

  test('a failed refresh keeps the rows and says when it failed', async () => {
    jest.useFakeTimers({ now: NOW })
    const advance = (ms: number) => act(async () => void (await jest.advanceTimersByTimeAsync(ms)))
    let n = 0
    const h = setup({
      answers: {
        optionchain: (b) => {
          n++
          if (n === 2) throw new Error('down')
          return chainReply({ expiry: String(b.expiry_date) })
        },
      },
    })
    await render(h.tree(<OptionChainScreen initial={null} />))
    await advance(0)
    // the failed refresh at 30 s, and react-query's notification after it
    await advance(30_050)
    expect(n).toBe(2)
    expect(screen.getAllByTestId(/^oc-row-/)).toHaveLength(21)
    expect(text('oc-refresh-error')).toBe("Couldn't refresh at 10:30:30. Retrying.")
    await advance(30_000)
    expect(n).toBe(3)
    expect(screen.queryByTestId('oc-refresh-error')).toBeNull()
  })

  test('one LIVE badge, in the header (ux G16)', async () => {
    useConnection.getState().set({ analyzer: 'live', transport: 'http' })
    const h = setup()
    await h.show()
    expect(screen.getAllByText('LIVE')).toHaveLength(1)
    expect(screen.getByTestId('oc-mode')).toBeTruthy()
    expect(screen.getByTestId('badge-http')).toBeTruthy()
  })
})

describe('the underlying picker', () => {
  test('defaults-only master: typing BANK searches and offers BANKNIFTY', async () => {
    const warned = expectLog('warn', /the instruments CSV was not stored/)
    const row = (symbol: string) => ({ symbol, exchange: 'NFO', name: symbol })
    const h = setup({
      answers: {
        search: () => ({
          status: 'success',
          data: [
            row('BANKNIFTY30DEC2652000CE'),
            row('BANKNIFTY30DEC2652000PE'),
            row('BANKBARODA30DEC26250CE'),
            row('BANKBARODA30DEC26FUT'),
          ],
        }),
      },
    })
    await h.show()
    await press('oc-underlying')
    await settle()
    expect(screen.getByTestId('oc-underlying-sheet')).toBeTruthy()
    // the web's defaults, indices first, while no master is stored
    expect(screen.getAllByTestId(/^oc-pick-[A-Z]/).map((n) => n.props.testID)).toEqual([
      'oc-pick-NIFTY',
      'oc-pick-BANKNIFTY',
      'oc-pick-FINNIFTY',
      'oc-pick-MIDCPNIFTY',
    ])
    await act(async () => fireEvent.changeText(screen.getByTestId('oc-pick-search'), 'BANK'))
    await settle()
    expect(h.bodies('search')).toEqual([])
    await act(async () => void (await new Promise((r) => setTimeout(r, 320))))
    await settle()
    expect(h.bodies('search')).toEqual([{ query: 'BANK', exchange: 'NFO' }])
    expect(screen.getAllByTestId(/^oc-pick-[A-Z]/).map((n) => n.props.testID)).toEqual([
      'oc-pick-BANKNIFTY',
      'oc-pick-BANKBARODA',
    ])
    await press('oc-pick-BANKNIFTY')
    await settle()
    expect(text('oc-underlying')).toContain('BANKNIFTY')
    expect(h.bodies('expiry').at(-1)).toEqual({
      symbol: 'BANKNIFTY',
      exchange: 'NFO',
      instrumenttype: 'options',
    })
    expect(warned.length).toBeGreaterThan(0)
  })
})

describe('links into the chain', () => {
  test('the instrument sheet offers Option chain for RELIANCE when it has options', async () => {
    const h = setup({
      answers: {
        expiry: (b) => ({ status: 'success', data: b.symbol === 'RELIANCE' ? EXPIRIES : [] }),
      },
    })
    mockParams = { key: 'NSE%3ARELIANCE' }
    await h.show(<InstrumentRoute />)
    await settle()
    // no master stored: one expiry read for the day says it has options
    expect(h.bodies('expiry')).toEqual([
      { symbol: 'RELIANCE', exchange: 'NFO', instrumenttype: 'options' },
    ])
    await press('inst-optionchain')
    expect(mockRouter.replace).toHaveBeenLastCalledWith(optionChainHref('NSE', 'RELIANCE'))
    expect(targetFromKey('NSE:RELIANCE')).toEqual({
      optionsExchange: 'NFO',
      underlying: 'RELIANCE',
    })
    await screen.unmount()

    mockParams = { key: 'NSE%3AIDEA' }
    await h.show(<InstrumentRoute />)
    await settle()
    expect(screen.queryByTestId('inst-optionchain')).toBeNull()
  })

  test('/optionchain/NSE_INDEX%3ANIFTY and /tools/optionchain?u=NFO%3ANIFTY render the same chain', async () => {
    const a = setup()
    mockParams = { key: 'NSE_INDEX%3ANIFTY' }
    await a.show(<OptionChainRoute />)
    expect(screen.getByTestId('oc-screen')).toBeTruthy()
    const viaKey = a.call.mock.calls.map(([id, body]) => [id, body])
    const rowsViaKey = screen.getAllByTestId(/^oc-row-/).map((n) => n.props.testID)
    await screen.unmount()

    const b = setup()
    mockParams = { toolId: 'optionchain', u: 'NFO%3ANIFTY' }
    await b.show(<ToolRoute />)
    expect(screen.getByTestId('oc-screen')).toBeTruthy()
    expect(b.call.mock.calls.map(([id, body]) => [id, body])).toEqual(viaKey)
    expect(screen.getAllByTestId(/^oc-row-/).map((n) => n.props.testID)).toEqual(rowsViaKey)
    await screen.unmount()

    // without u, the tool opens NIFTY on NFO; a bad link says so and offers a way back
    const d = setup()
    mockParams = { toolId: 'optionchain' }
    await d.show(<ToolRoute />)
    expect(d.bodies('optionchain')[0]).toMatchObject({ underlying: 'NIFTY', exchange: 'NFO' })
    await screen.unmount()

    const e = setup()
    mockParams = { key: 'NIFTY' }
    await e.show(<OptionChainRoute />)
    expect(screen.getByText(CHAIN_LINK_INCOMPLETE)).toBeTruthy()
    expect(e.call).not.toHaveBeenCalled()
    await press('oc-back')
    expect(mockRouter.back).toHaveBeenCalledTimes(1)
  })
})
