import fs from 'node:fs'
import path from 'node:path'
import { URL as NodeURL } from 'node:url'
import { extractExpoPathFromURL } from 'expo-router/build/fork/extractPathFromURL'
import {
  cleanPath,
  getUrlWithReactNavigationConcessions,
} from 'expo-router/build/fork/getStateFromPath-forks'
import { URL as DeviceURL } from 'whatwg-url-minimum'
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
const enc = encodeURIComponent

// Every URL a test below gives the guard, for the check against the router's own code.
const corpus = new Set<string>()
const seen = <T extends string>(urls: T[]): T[] => {
  for (const u of urls) corpus.add(u)
  return urls
}

// Special schemes whose host the URL parser rewrites to `order`: a default port dropped, IDNA
// mapping full-width letters, a soft hyphen removed. The router reads each as the ticket.
const REWRITTEN = [
  `ftp://order:21/new?${SELL}`,
  `ws://order:80/new?${SELL}`,
  `wss://order:443/new?${SELL}`,
  `ftp://ｏｒｄｅｒ/new?${SELL}`,
  `ftp://or%C2%ADder/new?${SELL}`,
]
/** A link the launcher unwraps to `url`, as any page can send one. */
const wrap = (url: string) => `openalgo://x?__expo_url=${enc(url)}`

const TICKET_SPELLINGS = seen([
  // the app scheme: host form, empty host, no slashes
  `openalgo://order/new?${SELL}`,
  `openalgo:///order/new?${SELL}`,
  `openalgo:order/new?${SELL}`,
  // bare paths, as the router also takes them
  `/order/new?${SELL}`,
  `order/new?${SELL}`,
  `//order/new?${SELL}`,
  `///order/new?${SELL}`,
  // trailing slash, doubled slashes, a fragment
  `/order/new/?${SELL}`,
  `openalgo://order/new/?${SELL}`,
  `/order//new?${SELL}`,
  `/order/new?${SELL}#top`,
  // case variants
  `/ORDER/NEW?${SELL}`,
  `/Order/New?${SELL}`,
  `OPENALGO://ORDER/NEW?${SELL}`,
  `OpenAlgo://Order/new?${SELL}`,
  // percent-encoded, once and twice
  `/%6Frder/new?${SELL}`,
  `/order%2Fnew?${SELL}`,
  `openalgo://%6F%72%64%65%72/%6E%65%77?${SELL}`,
  `/%256Frder/new?${SELL}`,
  `openalgo%3A%2F%2Forder%2Fnew?${SELL}`,
  // a route group, dot segments (plain and encoded), backslashes, a tab or newline
  `/(app)/order/new?${SELL}`,
  `openalgo://(app)/order/new?${SELL}`,
  `/./order/new?${SELL}`,
  `/chart/../order/new?${SELL}`,
  `/chart/%2e%2e/order/new?${SELL}`,
  `openalgo:chart/../order/new?${SELL}`,
  `openalgo:///chart/../order/new?${SELL}`,
  `\\order\\new?${SELL}`,
  `openalgo:\\\\order\\new?${SELL}`,
  `/or\tder/new?${SELL}`,
  `/or\nder/new?${SELL}`,
  `/or%09der/new?${SELL}`,
  ` /order/new?${SELL}`,
  // user info and other schemes: the dev client's, Expo Go's, and an https link
  `openalgo://someone@order/new?${SELL}`,
  `openalgo://a:b@order/new?${SELL}`,
  `exp+openalgo-mobile://order/new?${SELL}`,
  `exp://192.168.1.2:8081/--/order/new?${SELL}`,
  `https://example.com/order/new?${SELL}`,
  `http://example.com/order/new/?${SELL}`,
  // a port: empty (the URL parser drops it), a number, and a special scheme's default one
  `openalgo://order:/new?${SELL}`,
  `openalgo://order:8080/new?${SELL}`,
  // a host the parser rewrites (REWRITTEN), and full-width letters in the app scheme's host
  ...REWRITTEN,
  `openalgo://ｏｒｄｅｒ/new?${SELL}`,
])

const MODIFY_AND_GTT = seen([
  '/order/123/modify?price=1&trigger_price=1&source=chart',
  '/order/123/modify',
  '/order/123/modify/',
  'openalgo://order/ABC-123/modify?price=500',
  'openalgo:///ORDER/123/MODIFY',
  '/order/123%2Fmodify',
  '//order/123/modify',
  'openalgo://order:/123/modify?price=1',
  `/gtt/new?${SELL}`,
  'openalgo://gtt/new?exchange=NSE&symbol=SBIN&action=BUY&quantity=5',
  'openalgo://gtt/new/?exchange=NSE&symbol=SBIN',
  `openalgo://gtt:/new?${SELL}`,
  '/GTT/New?exchange=NSE&symbol=SBIN',
  '/%67tt/new?exchange=NSE&symbol=SBIN',
  '/(app)/gtt/new',
  '/gtt/77/modify',
  'openalgo://gtt/77/modify/',
  'openalgo://gtt:/77/modify',
  'https://example.com/gtt/77/modify',
])

// The launcher's `__expo_url` (and the legacy host's `url`), which the router unwraps on every
// link, release builds too: whatever it names is read as the link.
const LAUNCHER_WRAPPED = seen([
  `openalgo://instrument/NSE%3ASBIN?__expo_url=${enc(`openalgo://order/new?${SELL}`)}`,
  `openalgo://chart/NSE%3ASBIN?__expo_url=${enc(enc(`openalgo://order/new?${SELL}`))}`,
  `openalgo://expo-development-client/?url=${enc(`openalgo://order/new?${SELL}`)}`,
  `/?__expo_url=${enc('/order/new')}`,
  `/?__expo_url=${enc('order/123/modify')}`,
  // a special scheme whose host the parser rewrites, an empty port, an https link
  ...REWRITTEN.map(wrap),
  wrap(`openalgo://order:/new?${SELL}`),
  wrap(`https://example.com/gtt/new?${SELL}`),
  // wrapped twice: the router unwraps once, and what is left still names a target
  wrap(`openalgo://chart/NSE%3ASBIN?__expo_url=${enc('openalgo://order/new')}`),
])

// A route the app has no screen for, or one not spelled as the app's own links spell it (another
// case, an encoded letter, a route group), and a link no parser reads: the watchlist.
const UNKNOWN = seen([
  'openalgo://Chart/NSE%3ASBIN',
  'openalgo://%63hart/NSE%3ASBIN',
  'openalgo://(app)/chart/NSE%3ASBIN',
  'openalgo://_sitemap',
  'openalgo://nothing-here',
  'http://[',
])

// Links that open as they came, and the plain path the guard hands the router for each.
const OPENS: [string, string][] = [
  ['openalgo://', '/'],
  ['openalgo:///', '/'],
  ['/', '/'],
  ['', '/'],
  ['openalgo://chart/NSE%3ASBIN', '/chart/NSE%3ASBIN'],
  [`openalgo:/${chartHref('NSE', 'SBIN')}`, '/chart/NSE%3ASBIN'],
  ['openalgo://chart/NSE%3ASBIN/', '/chart/NSE%3ASBIN'],
  ['openalgo://chart//NSE%3ASBIN', '/chart/NSE%3ASBIN'],
  ['openalgo://chart/NSE%3ASBIN?__expo_disable_fab=1', '/chart/NSE%3ASBIN'],
  // what the router reads, not the text: a port dropped, dot segments, a launcher target
  ['openalgo://chart:/NSE%3ASBIN', '/chart/NSE%3ASBIN'],
  [`openalgo:///order/new/../../chart/NSE%3ASBIN?${SELL}`, `/chart/NSE%3ASBIN?${SELL}`],
  [`openalgo://chart/../order/new?${SELL}`, `/chart/order/new?${SELL}`],
  [`openalgo://order:/new?__expo_url=${enc('openalgo://chart/NSE%3ASBIN')}`, '/chart/NSE%3ASBIN'],
  [chartHref('NSE', 'M&M'), '/chart/NSE%3AM%26M'],
  [instrumentHref('NSE', 'SBIN'), SBIN],
  [
    `openalgo://${instrumentHref('NFO', 'NIFTY28NOV2524000CE').slice(1)}`,
    '/instrument/NFO%3ANIFTY28NOV2524000CE',
  ],
  [depthHref('NSE', 'SBIN'), '/depth/NSE%3ASBIN'],
  [optionChainHref('NSE_INDEX', 'NIFTY'), '/optionchain/NSE_INDEX%3ANIFTY'],
  ['openalgo://optionchain/NSE_INDEX%3ANIFTY', '/optionchain/NSE_INDEX%3ANIFTY'],
  [toolHref('maxpain', { u: 'NFO:NIFTY' }), '/tools/maxpain?u=NFO%3ANIFTY'],
  // the router decodes a deep link's query values, and the guard hands it them so
  [
    `openalgo://${toolHref('optionchain', { u: 'NFO:BANKNIFTY' }).slice(1)}`,
    '/tools/optionchain?u=NFO:BANKNIFTY',
  ],
  [toolHref('gex'), '/tools/gex'],
  [ordersHref({ segment: 'gtt' }), '/orders?segment=gtt'],
  ['openalgo://orders?segment=gtt', '/orders?segment=gtt'],
  ['openalgo://orders?segment=all', '/orders?segment=all'],
  [ordersHref(), '/orders'],
  [searchHref({ addTo: 'abc' }), '/search?addTo=abc'],
  ['openalgo://portfolio', '/portfolio'],
  ['openalgo://account/backup', '/account/backup'],
  ['openalgo://help', '/help'],
  ['https://example.com/help#top', '/help#top'],
  // a symbol that only contains the word
  ['openalgo://chart/NSE%3AORDERS', '/chart/NSE%3AORDERS'],
  ['openalgo://instrument/NSE%3AGTTX', '/instrument/NSE%3AGTTX'],
]
seen(OPENS.map(([url]) => url))

// Every route file under src/app is listed here as a screen that sends an order with values a
// link gives it (refused from outside) or not (opens). A new route fails the route-table test
// until it is listed, so an order screen cannot be added under a new name without being refused.
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

const routeForms = (route: string) => {
  const url = urlOf(route)
  return [url, `openalgo://${url.slice(1)}`, `openalgo:///${url.slice(1)}`]
}
seen(Object.keys(ROUTES).flatMap(routeForms))

// The router's own code (expo-router 58): the path it reads from a link, as the cold start and a
// link that comes while the app runs both route it, and the route getStateFromPath matches.
const router = {
  path(url: string) {
    const p = extractExpoPathFromURL([], url)
    return p.startsWith('/') ? p : `/${p}`
  },
  route: (p: string) => cleanPath(getUrlWithReactNavigationConcessions(p).nonstandardPathname),
  /** The route the router opens for a link, or null where it cannot read the link. */
  routeOf(url: string): string | null {
    try {
      return router.route(router.path(url))
    } catch {
      return null
    }
  },
}

/** A route of an order screen, as the route patterns match one (case-sensitive, groups optional). */
const ORDER_SCREEN = /^(\(app\)\/)?(order|gtt)\//

// jest-expo installs Expo's own URL (whatwg-url-minimum), as the app has on the device. The guard
// and the router both read the global URL, so every test runs on that parser and on Node's.
const PARSERS: [string, typeof URL][] = [
  ['the device URL parser (whatwg-url-minimum)', DeviceURL as unknown as typeof URL],
  ["Node's URL parser", NodeURL as unknown as typeof URL],
]

describe.each(PARSERS)('on %s', (_name, Parser) => {
  const G = globalThis as { URL: typeof URL }
  const original = G.URL
  beforeAll(() => {
    G.URL = Parser
  })
  afterAll(() => {
    G.URL = original
  })

  test('the parser is the one named', () => {
    expect(new URL('openalgo://x')).toBeInstanceOf(Parser)
  })

  describe('an order ticket link is refused, in every spelling', () => {
    test.each(TICKET_SPELLINGS.map((u) => [u]))('%s', (url) => {
      expect(refused(url)).toEqual({ path: SBIN, refused: true })
    })

    test('the router itself opens the ticket from the forms a text match missed', () => {
      for (const url of [`openalgo://order:/new?${SELL}`, ...REWRITTEN]) {
        expect([url, router.routeOf(url)]).toEqual([url, 'order/new/'])
      }
    })

    test('with no query, or an incomplete one, it opens the watchlist', () => {
      for (const url of seen([
        '/order/new',
        '/order/new/',
        'openalgo://order/new',
        'openalgo://order:/new',
        'openalgo://order/new?action=SELL&quantity=1000',
        'openalgo://order/new?exchange=NSE&action=SELL',
        'openalgo://order/new?symbol=SBIN&action=SELL',
      ])) {
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
      for (const url of seen([href, `openalgo://${href.slice(1)}`, `openalgo://${href}`])) {
        expect(refused(url)).toEqual({ path: SBIN, refused: true })
      }
    })
  })

  describe('the modify sheet and the GTT screens are refused too', () => {
    test.each(MODIFY_AND_GTT.map((u) => [u, /symbol=SBIN/.test(u) ? SBIN : WATCHLIST]))(
      '%s',
      (url, to) => {
        expect(refused(url)).toEqual({ path: to, refused: true })
      },
    )

    test('the links modifyHref, gttHref and gttModifyHref build', () => {
      for (const href of [
        modifyHref('123'),
        modifyHref('123', { price: 101.5, trigger_price: 100, source: 'chart' }),
        gttModifyHref('77'),
      ]) {
        for (const url of seen([href, `openalgo://${href.slice(1)}`])) {
          expect(refused(url)).toEqual({ path: WATCHLIST, refused: true })
        }
      }
      const gtt = gttHref({ exchange: 'NSE', symbol: 'SBIN', action: 'SELL', quantity: 10 })
      for (const url of seen([gtt, `openalgo://${gtt.slice(1)}`])) {
        expect(refused(url)).toEqual({ path: SBIN, refused: true })
      }
    })

    test.each(LAUNCHER_WRAPPED.map((u) => [u]))('wrapped for the launcher: %s', (url) => {
      expect(refused(url)).toEqual({ path: WATCHLIST, refused: true })
    })

    test('the router unwraps those to the ticket', () => {
      for (const url of REWRITTEN.map(wrap)) {
        expect([url, router.routeOf(url)]).toEqual([url, 'order/new/'])
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

    test.each(UNKNOWN.map((u) => [u]))('a route the app does not open by that name: %s', (url) => {
      expect(refused(url)).toEqual({ path: WATCHLIST, refused: true })
    })
  })

  describe('every other link opens, as the plain path the router reads from it', () => {
    test.each(OPENS)('%s', (url, to) => {
      expect(guardOutsideLink(url)).toEqual({ path: to, refused: false })
    })
  })

  // Inside Expo Go the router reads Expo Go's own form, `exp://host/--/path`, and so does the guard.
  describe('inside Expo Go', () => {
    const g = globalThis as { expo?: { modules?: Record<string, unknown> } }
    let saved: typeof g.expo
    beforeAll(() => {
      saved = g.expo
      g.expo = { ...saved, modules: { ...saved?.modules, ExpoGo: {} } }
    })
    afterAll(() => {
      g.expo = saved
    })

    test.each([
      [`exp://192.168.1.2:8081/--/order/new?${SELL}`, { path: SBIN, refused: true }],
      [`exp://192.168.1.2:8081/--/order:/new?${SELL}`, { path: SBIN, refused: true }],
      ['exps://u.expo.dev/--/gtt/77/modify', { path: WATCHLIST, refused: true }],
      ['exp://192.168.1.2:8081/--/chart/NSE%3ASBIN', { path: '/chart/NSE%3ASBIN', refused: false }],
      ['exp://192.168.1.2:8081?segment=gtt', { path: '/?segment=gtt', refused: false }],
    ])('%s', (url, to) => {
      const out = guardOutsideLink(url)
      expect(out).toEqual(to)
      expect(router.path(out.path)).toBe(out.path)
      // the router reads the link the same way: an order screen when refused, else the route
      expect(router.routeOf(url)).toEqual(
        out.refused ? expect.stringMatching(ORDER_SCREEN) : router.route(out.path),
      )
    })
  })

  test('every route under src/app is listed, and only the order screens are refused', () => {
    expect(routeFiles(APP).sort()).toEqual(Object.keys(ROUTES).sort())
    for (const [route, verdict] of Object.entries(ROUTES)) {
      for (const form of routeForms(route)) {
        expect([form, guardOutsideLink(form).refused]).toEqual([form, verdict === 'refused'])
      }
    }
  })

  // The guard against the router's own code, over every URL above: a link the guard opens comes
  // back as a path the router takes as it is and routes to the link's own route; whatever the
  // guard returns never routes to an order screen; a link the router reads as one is refused.
  test('the router routes what the guard checked, for every link above', () => {
    expect(corpus.size).toBeGreaterThan(180)
    for (const url of corpus) {
      const out = guardOutsideLink(url)
      const routed = router.route(router.path(out.path))
      expect([url, router.path(out.path), out.path.startsWith('//')]).toEqual([
        url,
        out.path,
        false,
      ])
      expect([url, ORDER_SCREEN.test(routed)]).toEqual([url, false])
      if (!out.refused) {
        expect([url, routed]).toEqual([url, router.routeOf(url)])
        // the route-name check, which reads the path with no leading slash
        expect([url, router.route(extractExpoPathFromURL([], out.path))]).toEqual([url, routed])
      }
      const route = router.routeOf(url)
      if (route !== null && ORDER_SCREEN.test(route))
        expect([url, out.refused]).toEqual([url, true])
    }
  })
})
