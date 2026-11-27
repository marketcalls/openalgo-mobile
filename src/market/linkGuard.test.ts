import fs from 'node:fs'
import path from 'node:path'
import { guardOutsideLink } from './linkGuard'
import {
  chartHref,
  depthHref,
  gttHref,
  gttModifyHref,
  instrumentHref,
  modifyHref,
  optionChainHref,
  ordersHref,
  searchHref,
  ticketHref,
  toolHref,
} from './links'

// A link from outside the app (another app, a web page, a QR code) never opens a screen that can
// send an order: the ticket, the modify sheet, the GTT ticket or GTT modify (policy audit).
const SELL = 'exchange=NSE&symbol=SBIN&action=SELL&pricetype=MARKET&quantity=1000'
const SBIN = '/instrument/NSE%3ASBIN'
const WATCHLIST = '/'

const refused = (url: string) => guardOutsideLink(url)

describe('an order ticket link is refused, in every spelling', () => {
  test.each([
    // the app scheme: host form, empty host, no slashes
    [`openalgo://order/new?${SELL}`],
    [`openalgo:///order/new?${SELL}`],
    [`openalgo:order/new?${SELL}`],
    // bare paths, as the router also takes them
    [`/order/new?${SELL}`],
    [`order/new?${SELL}`],
    [`//order/new?${SELL}`],
    [`///order/new?${SELL}`],
    // trailing slash, doubled slashes, a fragment
    [`/order/new/?${SELL}`],
    [`openalgo://order/new/?${SELL}`],
    [`/order//new?${SELL}`],
    [`/order/new?${SELL}#top`],
    // case variants
    [`/ORDER/NEW?${SELL}`],
    [`/Order/New?${SELL}`],
    [`OPENALGO://ORDER/NEW?${SELL}`],
    [`OpenAlgo://Order/new?${SELL}`],
    // percent-encoded, once and twice
    [`/%6Frder/new?${SELL}`],
    [`/order%2Fnew?${SELL}`],
    [`openalgo://%6F%72%64%65%72/%6E%65%77?${SELL}`],
    [`/%256Frder/new?${SELL}`],
    [`openalgo%3A%2F%2Forder%2Fnew?${SELL}`],
    // a route group, dot segments (plain and encoded), backslashes, a tab or newline
    [`/(app)/order/new?${SELL}`],
    [`openalgo://(app)/order/new?${SELL}`],
    [`/./order/new?${SELL}`],
    [`/chart/../order/new?${SELL}`],
    [`/chart/%2e%2e/order/new?${SELL}`],
    [`\\order\\new?${SELL}`],
    [`openalgo:\\\\order\\new?${SELL}`],
    [`/or\tder/new?${SELL}`],
    [`/or%09der/new?${SELL}`],
    [` /order/new?${SELL}`],
    // user info and other schemes: the dev client's, Expo Go's, and an https link
    [`openalgo://someone@order/new?${SELL}`],
    [`openalgo://a:b@order/new?${SELL}`],
    [`exp+openalgo-mobile://order/new?${SELL}`],
    [`exp://192.168.1.2:8081/--/order/new?${SELL}`],
    [`https://example.com/order/new?${SELL}`],
    [`http://example.com/order/new/?${SELL}`],
  ])('%s', (url) => {
    expect(refused(url)).toEqual({ path: SBIN, refused: true })
  })

  test('with no query, or an incomplete one, it opens the watchlist', () => {
    for (const url of [
      '/order/new',
      '/order/new/',
      'openalgo://order/new',
      'openalgo://order/new?action=SELL&quantity=1000',
      'openalgo://order/new?exchange=NSE&action=SELL',
      'openalgo://order/new?symbol=SBIN&action=SELL',
    ]) {
      expect(refused(url)).toEqual({ path: WATCHLIST, refused: true })
    }
  })

  test('the link built by ticketHref, with and without the scheme', () => {
    const href = ticketHref({
      exchange: 'NSE',
      symbol: 'SBIN',
      action: 'SELL',
      pricetype: 'MARKET',
      quantity: 1000,
      source: 'chart',
    })
    expect(refused(href)).toEqual({ path: SBIN, refused: true })
    expect(refused(`openalgo://${href.slice(1)}`)).toEqual({ path: SBIN, refused: true })
    expect(refused(`openalgo://${href}`)).toEqual({ path: SBIN, refused: true })
  })
})

describe('the modify sheet and the GTT screens are refused too', () => {
  test.each([
    ['/order/123/modify?price=1&trigger_price=1&source=chart', WATCHLIST],
    ['/order/123/modify', WATCHLIST],
    ['/order/123/modify/', WATCHLIST],
    ['openalgo://order/ABC-123/modify?price=500', WATCHLIST],
    ['openalgo:///ORDER/123/MODIFY', WATCHLIST],
    ['/order/123%2Fmodify', WATCHLIST],
    ['//order/123/modify', WATCHLIST],
    [`/gtt/new?${SELL}`, SBIN],
    ['openalgo://gtt/new?exchange=NSE&symbol=SBIN&action=BUY&quantity=5', SBIN],
    ['openalgo://gtt/new/?exchange=NSE&symbol=SBIN', SBIN],
    ['/GTT/New?exchange=NSE&symbol=SBIN', SBIN],
    ['/%67tt/new?exchange=NSE&symbol=SBIN', SBIN],
    ['/(app)/gtt/new', WATCHLIST],
    ['/gtt/77/modify', WATCHLIST],
    ['openalgo://gtt/77/modify/', WATCHLIST],
    ['https://example.com/gtt/77/modify', WATCHLIST],
  ])('%s', (url, to) => {
    expect(refused(url)).toEqual({ path: to, refused: true })
  })

  test('the links modifyHref, gttHref and gttModifyHref build', () => {
    for (const href of [
      modifyHref('123'),
      modifyHref('123', { price: 101.5, trigger_price: 100, source: 'chart' }),
      gttModifyHref('77'),
    ]) {
      expect(refused(href)).toEqual({ path: WATCHLIST, refused: true })
      expect(refused(`openalgo://${href.slice(1)}`)).toEqual({ path: WATCHLIST, refused: true })
    }
    const gtt = gttHref({ exchange: 'NSE', symbol: 'SBIN', action: 'SELL', quantity: 10 })
    expect(refused(gtt)).toEqual({ path: SBIN, refused: true })
    expect(refused(`openalgo://${gtt.slice(1)}`)).toEqual({ path: SBIN, refused: true })
  })

  test('a link wrapping an order link for the launcher (__expo_url, the legacy url param)', () => {
    const inner = encodeURIComponent(`openalgo://order/new?${SELL}`)
    for (const url of [
      `openalgo://instrument/NSE%3ASBIN?__expo_url=${inner}`,
      `openalgo://chart/NSE%3ASBIN?__expo_url=${encodeURIComponent(inner)}`,
      `openalgo://expo-development-client/?url=${inner}`,
      `/?__expo_url=${encodeURIComponent('/order/new')}`,
      `/?__expo_url=${encodeURIComponent('order/123/modify')}`,
    ]) {
      expect(refused(url)).toEqual({ path: WATCHLIST, refused: true })
    }
  })
})

describe('where a refused link goes', () => {
  test('the instrument it names, only when the exchange and symbol are real ones', () => {
    const at = (q: string) => refused(`openalgo://order/new?${q}`).path
    expect(at('exchange=NFO&symbol=NIFTY28NOV2524000CE')).toBe(
      instrumentHref('NFO', 'NIFTY28NOV2524000CE'),
    )
    expect(at('exchange=NSE&symbol=M%26M&action=BUY')).toBe(instrumentHref('NSE', 'M&M'))
    expect(at('exchange=NSE&symbol=BAJAJ-AUTO')).toBe(instrumentHref('NSE', 'BAJAJ-AUTO'))
    expect(at('exchange=NSE_INDEX&symbol=NIFTY')).toBe(instrumentHref('NSE_INDEX', 'NIFTY'))
    // the first of a repeated param, as a route param reads it
    expect(at('exchange=NSE&exchange=BSE&symbol=SBIN&symbol=ITC')).toBe(SBIN)
    // not an exchange, not a symbol, or not decodable: the watchlist
    for (const q of [
      'exchange=XYZ&symbol=SBIN',
      'exchange=nse&symbol=SBIN',
      'exchange=NSE&symbol=',
      'exchange=NSE&symbol=..%2Forder%2Fnew',
      'exchange=NSE&symbol=SBIN%3Fx%3D1',
      'exchange=NSE&symbol=%E0%A4%A',
      'exchange=NSE&symbol=SB IN',
      `exchange=NSE&symbol=${'A'.repeat(61)}`,
    ]) {
      expect(at(q)).toBe(WATCHLIST)
    }
  })
})

describe('every other link opens as it came', () => {
  test.each([
    ['openalgo://'],
    ['openalgo:///'],
    ['/'],
    [''],
    ['openalgo://chart/NSE%3ASBIN'],
    [`openalgo:/${chartHref('NSE', 'SBIN')}`],
    [chartHref('NSE', 'M&M')],
    [instrumentHref('NSE', 'SBIN')],
    [`openalgo://${instrumentHref('NFO', 'NIFTY28NOV2524000CE').slice(1)}`],
    [depthHref('NSE', 'SBIN')],
    [optionChainHref('NSE_INDEX', 'NIFTY')],
    ['openalgo://optionchain/NSE_INDEX%3ANIFTY'],
    [toolHref('maxpain', { u: 'NFO:NIFTY' })],
    [`openalgo://${toolHref('optionchain', { u: 'NFO:BANKNIFTY' }).slice(1)}`],
    [toolHref('gex')],
    [ordersHref({ segment: 'gtt' })],
    ['openalgo://orders?segment=gtt'],
    ['openalgo://orders?segment=all'],
    [ordersHref()],
    [searchHref({ addTo: 'abc' })],
    ['openalgo://portfolio'],
    ['openalgo://account/backup'],
    ['openalgo://help'],
    // a symbol that only contains the word
    ['openalgo://chart/NSE%3AORDERS'],
    ['openalgo://instrument/NSE%3AGTTX'],
  ])('%s', (url) => {
    expect(guardOutsideLink(url)).toEqual({ path: url, refused: false })
  })
})

// Every route file under src/app is listed here as a screen that sends an order with values a
// link gives it (refused from outside) or not (opens). A new route fails this test until it is
// listed, so an order screen cannot be added under a new name without being refused.
const APP = path.resolve(__dirname, '..', 'app')
const ROUTES: Record<string, 'refused' | 'opens'> = {
  '(app)/(tabs)/account': 'opens',
  '(app)/(tabs)/index': 'opens',
  '(app)/(tabs)/orders': 'opens',
  '(app)/(tabs)/portfolio': 'opens',
  '(app)/(tabs)/tools': 'opens',
  '(app)/account/backup': 'opens',
  '(app)/account/diagnostics': 'opens',
  '(app)/account/key': 'opens',
  '(app)/account/lost-phone': 'opens',
  '(app)/account/server': 'opens',
  '(app)/account/sign-out': 'opens',
  '(app)/chart/[key]': 'opens',
  '(app)/depth/[key]': 'opens',
  '(app)/gtt/[id]/modify': 'refused',
  '(app)/gtt/new': 'refused',
  '(app)/help': 'opens',
  '(app)/instrument/[key]': 'opens',
  '(app)/optionchain/[key]': 'opens',
  '(app)/order/[id]/modify': 'refused',
  '(app)/order/new': 'refused',
  '(app)/search': 'opens',
  '(app)/tools/[toolId]': 'opens',
  '(onboarding)/feed': 'opens',
  '(onboarding)/help': 'opens',
  '(onboarding)/index': 'opens',
  '(onboarding)/key': 'opens',
  '(onboarding)/server': 'opens',
  '(onboarding)/update': 'opens',
}

function routeFiles(dir: string, base = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) return routeFiles(path.join(dir, e.name), rel)
    const name = rel.replace(/\.tsx?$/, '')
    return /(^|\/)(_layout|\+[a-z-]+)$/.test(name) ? [] : [name]
  })
}

/** A URL for the route, as a link would name it: no groups, a sample value for each param. */
const urlOf = (route: string) =>
  `/${route
    .split('/')
    .filter((s) => !/^\(.*\)$/.test(s))
    .map((s) => (s === '[key]' ? 'NSE%3ASBIN' : s.replace(/^\[.*\]$/, '42')))
    .filter((s) => s !== 'index')
    .join('/')}?exchange=NSE&symbol=SBIN&action=SELL`

test('every route under src/app is listed, and only the order screens are refused', () => {
  expect(routeFiles(APP).sort()).toEqual(Object.keys(ROUTES).sort())
  for (const [route, verdict] of Object.entries(ROUTES)) {
    const url = urlOf(route)
    for (const form of [url, `openalgo://${url.slice(1)}`, `openalgo:///${url.slice(1)}`]) {
      expect([route, guardOutsideLink(form).refused]).toEqual([route, verdict === 'refused'])
    }
  }
})
