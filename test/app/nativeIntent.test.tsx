// First, so this file's expo-linking mock is the one loaded: expo-router/testing-library mocks it
// too (a `url` listener that never fires), and the first mock required stays.
import 'expo-linking'
import { render } from '@testing-library/react-native'
import { ExpoRoot, router, Slot, useLocalSearchParams } from 'expo-router'
import { getMockContext } from 'expo-router/build/testing-library/mock-config'
import { act, renderRouter, screen } from 'expo-router/testing-library'
import { Text } from 'react-native'
import * as nativeIntent from '~/app/+native-intent'
import { ticketHref } from '~/market/links'
import type { TicketParams } from '~/market/types'
import { LONG_TOAST_MS, ToastHost } from '~/ui/Toast'

// Expo Router subscribes to expo-linking's `url` event for links that come while the app runs; a
// test delivers one through it as the OS does. At a cold start it reads the OS's initial URL
// (getLinkingURL on iOS, the platform jest-expo runs).
const mockUrlListeners = new Set<(e: { url: string }) => unknown>()
let mockLinkingURL: string | null = null
jest.mock('expo-linking', () => ({
  ...jest.requireActual('expo-linking'),
  createURL: (p: string) => `openalgo://${p}`,
  resolveScheme: () => 'openalgo',
  getLinkingURL: () => mockLinkingURL,
  addEventListener: (_type: string, fn: (e: { url: string }) => unknown) => {
    mockUrlListeners.add(fn)
    return { remove: () => mockUrlListeners.delete(fn) }
  },
}))

// The app's own +native-intent over stand-in screens: only where a link lands is under test.
// redirectSystemPath runs on every link from outside the app (the cold start's initial URL and
// each `url` event while it runs) and never on router.push.
function Stub({ name }: { name: string }) {
  const params = useLocalSearchParams()
  return <Text testID={name}>{`${name} ${JSON.stringify(params)}`}</Text>
}

const routes = {
  '+native-intent': nativeIntent,
  _layout: () => (
    <>
      <Slot />
      <ToastHost />
    </>
  ),
  index: () => <Stub name="watchlist" />,
  'instrument/[key]': () => <Stub name="instrument" />,
  'chart/[key]': () => <Stub name="chart" />,
  'order/new': () => <Stub name="ticket" />,
  'order/[id]/modify': () => <Stub name="modify" />,
  'gtt/new': () => <Stub name="gtt" />,
  'gtt/[id]/modify': () => <Stub name="gtt-modify" />,
}

const SELL: TicketParams = {
  exchange: 'NSE',
  symbol: 'SBIN',
  action: 'SELL',
  pricetype: 'MARKET',
  quantity: 1000,
}
const REFUSED = "Orders can't be opened from a link"
const SELL_QUERY = 'exchange=NSE&symbol=SBIN&action=SELL&pricetype=MARKET&quantity=1000'

/**
 * A cold start as the device has one: the OS's initial URL, whole. renderRouter's `initialUrl`
 * is read as a path against `file:`, which drops a link's scheme and host, so it cannot stand in
 * for `openalgo://order:/new?…`.
 */
async function coldStart(url: string) {
  mockLinkingURL = url
  process.env.EXPO_ROUTER_IMPORT_MODE = 'sync'
  return render(<ExpoRoot context={getMockContext(routes)} />)
}

// The toast store outlives a render: a host left over from the last test lets it time out.
beforeEach(async () => {
  mockLinkingURL = null
  jest.useFakeTimers()
  const host = await render(<ToastHost />)
  await act(async () => jest.advanceTimersByTime(LONG_TOAST_MS))
  await act(async () => host.unmount())
})

test('the app directory has the native intent, and it exports redirectSystemPath', () => {
  expect(typeof nativeIntent.redirectSystemPath).toBe('function')
})

describe('a link at the cold start', () => {
  test('an order ticket link opens the instrument sheet and says why', async () => {
    await renderRouter(routes, { initialUrl: ticketHref(SELL) })
    expect(screen.getByTestId('instrument')).toHaveTextContent('"key":"NSE:SBIN"', { exact: false })
    expect(screen.queryByTestId('ticket')).toBeNull()
    expect(screen.getByTestId('toast')).toHaveTextContent(REFUSED)
  })

  test.each([
    ['/order/123/modify?price=1', 'modify'],
    ['/gtt/9/modify', 'gtt-modify'],
    ['/(app)/order/new?action=SELL&quantity=5', 'ticket'],
  ])('%s opens the watchlist', async (url, blocked) => {
    await renderRouter(routes, { initialUrl: url })
    expect(screen.getByTestId('watchlist')).toBeOnTheScreen()
    expect(screen.queryByTestId(blocked)).toBeNull()
    expect(screen.getByTestId('toast')).toHaveTextContent(REFUSED)
  })

  // The URL parser drops an empty port (host `order`, path `/new`), and the launcher's
  // `__expo_url` names an ftp link whose default port it drops: the router reads both as the
  // ticket, with every value the link gives.
  test.each([
    [`openalgo://order/new?${SELL_QUERY}`, 'instrument'],
    [`openalgo://order:/new?${SELL_QUERY}`, 'instrument'],
    [
      `openalgo://x?__expo_url=${encodeURIComponent(`ftp://order:21/new?${SELL_QUERY}`)}`,
      'watchlist',
    ],
  ])('the OS starts the app with %s: the %s opens, never the ticket', async (url, lands) => {
    await coldStart(url)
    expect(screen.getByTestId(lands)).toBeOnTheScreen()
    expect(screen.queryByTestId('ticket')).toBeNull()
    expect(screen.getByTestId('toast')).toHaveTextContent(REFUSED)
  })

  test('the OS starts the app with a chart link: the chart opens, with no toast', async () => {
    await coldStart('openalgo://chart:/NSE%3AITC')
    expect(screen.getByTestId('chart')).toHaveTextContent('"key":"NSE:ITC"', { exact: false })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('a GTT ticket link opens the instrument it names', async () => {
    await renderRouter(routes, { initialUrl: '/gtt/new?exchange=NSE&symbol=SBIN&action=SELL' })
    expect(screen.getByTestId('instrument')).toHaveTextContent('"key":"NSE:SBIN"', { exact: false })
    expect(screen.queryByTestId('gtt')).toBeNull()
  })

  test('a chart link opens the chart, with no toast', async () => {
    await renderRouter(routes, { initialUrl: '/chart/NSE%3ASBIN' })
    expect(screen.getByTestId('chart')).toHaveTextContent('"key":"NSE:SBIN"', { exact: false })
    expect(screen.queryByTestId('toast')).toBeNull()
  })
})

describe('a link while the app runs', () => {
  async function deliver(url: string) {
    expect(mockUrlListeners.size).toBe(1)
    await act(async () => {
      for (const fn of mockUrlListeners) await fn({ url })
    })
  }

  test('an order link from another app opens the instrument, never the ticket', async () => {
    await renderRouter(routes, { initialUrl: '/' })
    expect(screen.getByTestId('watchlist')).toBeOnTheScreen()
    await deliver(`openalgo://order/new?exchange=NSE&symbol=SBIN&action=SELL&quantity=1000`)
    expect(screen.getByTestId('instrument')).toHaveTextContent('"key":"NSE:SBIN"', { exact: false })
    expect(screen.queryByTestId('ticket')).toBeNull()
    expect(screen.getByTestId('toast')).toHaveTextContent(REFUSED)
  })

  test('a modify link from another app opens nothing new', async () => {
    await renderRouter(routes, { initialUrl: '/chart/NSE%3ASBIN' })
    await deliver('openalgo://order/123/modify?price=1')
    expect(screen.queryByTestId('modify')).toBeNull()
    expect(screen.getByTestId('watchlist')).toBeOnTheScreen()
  })

  // As at the cold start: the router reads both as the ticket, with every value the link gives.
  test.each([
    [`openalgo://order:/new?${SELL_QUERY}`, 'instrument'],
    [
      `openalgo://x?__expo_url=${encodeURIComponent(`ftp://order:21/new?${SELL_QUERY}`)}`,
      'watchlist',
    ],
  ])('%s opens the %s, never the ticket', async (url, lands) => {
    await renderRouter(routes, { initialUrl: '/chart/NSE%3AITC' })
    await deliver(url)
    expect(screen.getByTestId(lands)).toBeOnTheScreen()
    expect(screen.queryByTestId('ticket')).toBeNull()
    expect(screen.queryByTestId('chart')).toBeNull()
    expect(screen.getByTestId('toast')).toHaveTextContent(REFUSED)
  })

  test('a link opens the route the router reads from it, here past an empty port', async () => {
    await renderRouter(routes, { initialUrl: '/' })
    await deliver('openalgo://chart:/NSE%3AITC')
    expect(screen.getByTestId('chart')).toHaveTextContent('"key":"NSE:ITC"', { exact: false })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('a chart link from another app opens the chart', async () => {
    await renderRouter(routes, { initialUrl: '/' })
    await deliver('openalgo://chart/NSE%3AITC')
    expect(screen.getByTestId('chart')).toHaveTextContent('"key":"NSE:ITC"', { exact: false })
    expect(screen.queryByTestId('toast')).toBeNull()
  })
})

test('in the app, router.push still opens the ticket with its values', async () => {
  await renderRouter(routes, { initialUrl: '/chart/NSE%3ASBIN' })
  await act(async () => router.push(ticketHref(SELL)))
  expect(screen.getByTestId('ticket')).toHaveTextContent('"action":"SELL"', { exact: false })
  expect(screen.getByTestId('ticket')).toHaveTextContent('"quantity":"1000"', { exact: false })
  expect(screen.queryByTestId('toast')).toBeNull()
})

test('in the app, router.push still opens the modify sheet and the GTT ticket', async () => {
  await renderRouter(routes, { initialUrl: '/' })
  await act(async () => router.push('/order/123/modify?price=101.5'))
  expect(screen.getByTestId('modify')).toHaveTextContent('"price":"101.5"', { exact: false })
  await act(async () => router.push('/gtt/new?exchange=NSE&symbol=SBIN&action=BUY'))
  expect(screen.getByTestId('gtt')).toHaveTextContent('"action":"BUY"', { exact: false })
})
