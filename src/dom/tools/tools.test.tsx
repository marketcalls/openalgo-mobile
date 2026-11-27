// The tool DOM pages (design 7.7, 7.8): three 'use dom' entries on one provider shell. The "dom"
// project runs the real web pages in jsdom over a fake bridge, as the WebView runs them over
// DomHost; only Plotly's drawing (`@/lib/Plot2D`) and openalgo-charts' canvas are stubbed. The
// page is on jsdom's http origin, not file://, only because jsdom gives a file:// page no
// localStorage; every request resolves against DOM_ORIGIN either way (dom/web/request.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { act, createElement, type ReactElement } from 'react'
import {
  type BrokerCapsJson,
  type DomEvent,
  type DomReply,
  type DomRequest,
  type DomToNative,
  type JSONValue,
  NATIVE_KEY,
  TOOL_TOPICS,
  type ToolDomProps,
  type ToolInit,
  type ToolPageId,
} from '~/dom/bridge/protocol'

jest.mock('./tool.css', () => ({}))
jest.mock('./options.phone.css', () => ({}))
jest.mock('./portfolio.phone.css', () => ({}))
jest.mock('./rotation.phone.css', () => ({}))
// Plotly draws nothing in jsdom: the core is a recorder, the page's Plot a div with its style.
jest.mock('plotly.js/lib/core', () => ({
  react: jest.fn(async () => undefined),
  newPlot: jest.fn(async () => undefined),
  register: jest.fn(),
}))
jest.mock('@/lib/Plot2D', () => {
  const { createElement: h } = require('react') as typeof import('react')
  return {
    __esModule: true,
    default: (p: { style?: object }) => h('div', { 'data-testid': 'plot', style: p.style }),
  }
})
// openalgo-charts needs a canvas; the report's line chart is a plain holder here.
jest.mock('@/components/portfolio/PortfolioLineChart', () => {
  const { createElement: h } = require('react') as typeof import('react')
  return { PortfolioLineChart: () => h('div', { role: 'application' }) }
})

// What every WebView has and jsdom does not: TextEncoder (react-router makes one as it loads), and
// ResizeObserver and scrollIntoView (Radix's popper and cmdk's list, once a picker opens).
Object.assign(globalThis, { TextEncoder, TextDecoder })
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= () => {}

// The report page builds every one of its 15 tabs' content from the reply as it renders, so it
// needs a full reply (T15-02 brings one). Tests of the shell's routing read the same store through
// a stand-in; the thin-reply tests set `mockReport.real` and render the real page.
const mockReport = { real: false }
jest.mock('@/pages/PortfolioBacktesterResults', () => {
  const { createElement: h } = require('react') as typeof import('react')
  const Real = jest.requireActual('@/pages/PortfolioBacktesterResults').default
  const { usePortfolioBacktestStore } = require('@/stores/portfolioBacktestStore') as {
    usePortfolioBacktestStore: () => { result: { meta: { start: string; end: string } } }
  }
  const StandIn = () => {
    const { result } = usePortfolioBacktestStore()
    return h(
      'div',
      { className: 'container mx-auto space-y-4 p-4' },
      h('h1', null, 'Backtest Report'),
      h('p', null, `${result.meta.start} to ${result.meta.end}`),
    )
  }
  return { __esModule: true, default: () => h(mockReport.real ? Real : StandIn) }
})

// Before any frontend store loads: this WebView's web build last ran in analyzer mode, light, with
// a colour theme. The stores rehydrate from it as they load, as on the web (themeStore.ts:176-190).
localStorage.setItem(
  'openalgo-theme',
  JSON.stringify({ state: { mode: 'light', color: 'zinc', appMode: 'analyzer' }, version: 0 }),
)

type Entry = (p: ToolDomProps & { bridge: (m: JSONValue) => Promise<JSONValue> }) => ReactElement
const OptionToolsDom = require('./OptionToolsDom').default as Entry
const PortfolioToolsDom = require('./PortfolioToolsDom').default as Entry
const { adaptPlotly } = require('./plotlyTouch') as typeof import('./plotlyTouch')
const { TOOL_MARKER } = require('./marker') as typeof import('./marker')
const { useAuthStore } = require('@/stores/authStore') as {
  useAuthStore: { getState(): { apiKey: string | null; user: { broker: string | null } | null } }
}
const { useBrokerStore } = require('@/stores/brokerStore') as {
  useBrokerStore: { getState(): { capabilities: BrokerCapsJson | null; isLoaded: boolean } }
}
const { useThemeStore } = require('@/stores/themeStore') as {
  useThemeStore: { getState(): { mode: string; appMode: string } }
}

// The app has no @types/react-dom: the call this file makes, typed here.
const { createRoot } = require('react-dom/client') as {
  createRoot(container: Element): { render(node: ReactElement): void; unmount(): void }
}

const ACCEPTED: DomReply = { status: 202, body: null }
const ok = (body: JSONValue): DomReply => ({ status: 200, body })

/** A broker with BFO and no NFO: a page that rendered before the seed would ask for NFO. */
const CAPS: BrokerCapsJson = {
  broker_name: 'zerodha',
  broker_type: 'IN_stock',
  supported_exchanges: ['NSE', 'BSE', 'BFO', 'NSE_INDEX'],
  leverage_config: false,
}
const initFor = (page: ToolPageId): ToolInit => ({
  page,
  seed: { broker: 'zerodha', capabilities: CAPS },
})

const PAIN = [24000, 24100, 24200, 24300, 24400].map((strike, i) => ({
  strike,
  ce_pain: i,
  pe_pain: 4 - i,
  total_pain: 4,
  total_pain_cr: 4 + i,
}))
const MAX_PAIN = {
  status: 'success',
  underlying: 'SENSEX',
  spot_price: 24210.5,
  futures_price: null,
  atm_strike: 24200,
  max_pain_strike: 24200,
  lot_size: 20,
  pcr_oi: 1.1,
  pcr_volume: 0.9,
  expiry_date: '04DEC26',
  pain_data: PAIN,
}

/** The thin reply the T4 mock serves (dev/mock-server/tools.mjs toolReply). */
const THIN_BACKTEST = {
  status: 'success',
  meta: {
    symbols: ['NIFTYBEES', 'GOLDBEES'],
    target_weights: { NIFTYBEES: 60, GOLDBEES: 40 },
    rule: 'never',
    drift_band: 0,
    cost_bps: 0,
    slippage: 0,
    initial_capital: 100_000,
    sessions: 0,
    source: 'api',
    start: '2021-11-27',
    end: '2026-11-27',
    benchmark: 'NIFTY',
    risk_free_rate: 0,
    total_return_basis: 'price',
    data_warnings: {},
  },
  equity: [],
  benchmark_equity: [],
  metrics: {},
}
/** Enough of frontend api/portfolio.ts BacktestResponse for the report's Overview tab. */
const BACKTEST = {
  ...THIN_BACKTEST,
  metrics: { cagr: 0.112, benchmark_cagr: 0.1, max_drawdown: -0.18, sharpe: 1.2 },
  diversification: { effective_holdings: 1.9, holdings: 2 },
  rebalancing: { cost_drag: 0, count: 0 },
  costs: {
    brokerage: 0,
    stt: 100,
    exchange_txn: 3,
    gst: 1,
    sebi: 0,
    stamp_duty: 15,
    slippage: 0,
    total: 119,
    turnover: 1,
    drag: 0.001,
  },
}

type Answer = (m: DomToNative) => DomReply | Promise<DomReply> | undefined
const isReq = (m: DomToNative, path: string): m is DomRequest =>
  m.kind === 'request' && m.path === path

/** What native answers for these pages: the startup routes, the pickers, the tool routes. */
function standard(m: DomToNative): DomReply {
  if (m.kind !== 'request') return ACCEPTED
  switch (m.path) {
    case '/auth/csrf-token':
      return ok({ csrf_token: 'native' })
    case '/search/api/underlyings':
      return ok({ status: 'success', underlyings: ['SENSEX', 'BANKEX'] })
    case '/search/api/expiries':
      return ok({ status: 'success', expiries: ['04-DEC-26', '11-DEC-26'] })
    case '/oitracker/api/maxpain':
      return ok(MAX_PAIN)
    case '/api/v1/portfolio/benchmarks':
      return ok({ status: 'success', data: [{ symbol: 'NIFTY', exchange: 'NSE_INDEX' }] })
    case '/api/v1/portfolio/backtest':
      return ok(BACKTEST)
    default:
      return { status: 404, body: { status: 'error', message: 'Not found' } }
  }
}

type Win = typeof window & {
  ReactNativeWebView?: { postMessage: jest.Mock }
  _domRefProxy?: { deliver?: unknown }
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
const win = window as Win

/** Runs `code` as expo's wrapper does with injectJavaScript: a script in the page. */
function inject(code: string) {
  const script = document.createElement('script')
  script.textContent = code
  document.body.append(script)
  script.remove()
}

async function waitFor(check: () => unknown, ms = 4000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await act(() => new Promise((r) => setTimeout(r, 10)))
  }
}

const mounted: Array<() => Promise<void>> = []

async function mountTool(
  Dom: Entry,
  o: { page: ToolPageId; answer?: Answer; scheme?: 'dark' | 'light'; reduceMotion?: boolean },
) {
  const sent: DomToNative[] = []
  const bridge = async (m: JSONValue): Promise<JSONValue> => {
    const msg = m as DomToNative
    sent.push(msg)
    return (await o.answer?.(msg)) ?? standard(msg)
  }
  const container = document.createElement('div')
  container.id = 'root'
  document.body.append(container)
  const root = createRoot(container)
  const render = (scheme: 'dark' | 'light', reduceMotion = o.reduceMotion ?? false) =>
    act(async () => {
      root.render(createElement(Dom, { scheme, page: o.page, reduceMotion, bridge }))
    })
  await render(o.scheme ?? 'dark')
  let gone = false
  const unmount = async () => {
    if (gone) return
    gone = true
    await act(async () => root.unmount())
    container.remove()
  }
  mounted.push(unmount)
  const events = () => sent.flatMap((m) => (m.kind === 'event' ? [m] : []))
  const push = (topic: string, payload: JSONValue) =>
    act(async () =>
      inject(`window._domRefProxy.deliver(${JSON.stringify([{ kind: 'push', topic, payload }])})`),
    )
  return {
    sent,
    events,
    requests: (path: string) => sent.filter((m): m is DomRequest => isReq(m, path)),
    named: <N extends DomEvent['name']>(name: N) =>
      events().filter((e): e is Extract<DomEvent, { name: N }> => e.name === name),
    push,
    init: () => push(TOOL_TOPICS.init, initFor(o.page)),
    rerender: render,
    unmount,
  }
}

const q = <E extends Element = HTMLElement>(sel: string) => document.querySelector<E>(sel)
const text = () => document.body.textContent ?? ''
/** Sets an input's value the way a keystroke does, so React's onChange runs. */
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const click = (el: Element | null) =>
  act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) ?? null

/** A violation as the WebView fires it at the document (SecurityPolicyViolationEvent). */
function violation(blockedURI: string, effectiveDirective = 'img-src') {
  const e = Object.assign(new Event('securitypolicyviolation', { bubbles: true }), {
    blockedURI,
    effectiveDirective,
  })
  document.dispatchEvent(e)
}

/** A root page that throws as it renders. */
function BrokenPage(): never {
  throw new Error(`boom ${'x'.repeat(300)}`)
}

beforeAll(() => {
  win.IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  // The page runs inside the WebView: expo's hook takes its native path.
  win.ReactNativeWebView = { postMessage: jest.fn() }
  // An enforcing browser refuses the CSP probe's image with a violation.
  jest.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation((v: string) => {
    queueMicrotask(() => violation(v))
  })
  // A WebView that draws WebGL.
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    getExtension: () => ({ loseContext: () => {} }),
  })) as unknown as HTMLCanvasElement['getContext'])
  window.scrollTo = jest.fn() as unknown as typeof window.scrollTo
})
afterEach(async () => {
  mockReport.real = false
  for (const unmount of mounted.splice(0)) await unmount()
  jest.restoreAllMocks()
  delete win.ReactNativeWebView
  delete win._domRefProxy
})

test('the stores are seeded before the page renders: placeholder key, broker caps, dark mode', async () => {
  // The rehydrated analyzer theme put its class on <html> as the store loaded.
  expect(document.documentElement.classList.contains('analyzer')).toBe(true)
  let atFirst: object | null = null
  const page = await mountTool(OptionToolsDom, {
    page: 'maxpain',
    answer: (m) => {
      if (atFirst === null && isReq(m, '/search/api/underlyings')) {
        atFirst = {
          apiKey: useAuthStore.getState().apiKey,
          broker: useAuthStore.getState().user?.broker,
          caps: useBrokerStore.getState().capabilities,
          loaded: useBrokerStore.getState().isLoaded,
          theme: useThemeStore.getState(),
          html: [...document.documentElement.classList].sort(),
          dataTheme: document.documentElement.getAttribute('data-theme'),
          tool: document.documentElement.dataset.oaTool,
        }
      }
      return undefined
    },
  })
  expect(page.named('loaded')).toHaveLength(1)
  // nothing renders before tool.init
  expect(q('#oa-tool')).toBeNull()
  await page.init()
  await waitFor(() => page.requests('/oitracker/api/maxpain').length > 0)

  expect(atFirst).toEqual({
    apiKey: NATIVE_KEY,
    broker: 'zerodha',
    caps: CAPS,
    loaded: true,
    theme: expect.objectContaining({ mode: 'dark', appMode: 'live' }),
    html: ['dark'],
    dataTheme: null,
    tool: 'maxpain',
  })
  // Seeded before the first render: the page never asked for the fallback NFO.
  for (const r of page.requests('/search/api/underlyings'))
    expect(r.query).toEqual({ exchange: 'BFO' })
  expect(page.requests('/oitracker/api/maxpain')[0]?.body).toEqual({
    underlying: 'SENSEX',
    exchange: 'BFO',
    expiry_date: '04DEC26',
  })
  expect(document.title).toBe(TOOL_MARKER)
  expect(document.documentElement.dataset.oaEntry).toBe('oa-entry:src/dom/tools/OptionToolsDom.tsx')
})

test('the page renders at its route inside MemoryRouter; the results route renders after navigate', async () => {
  const page = await mountTool(PortfolioToolsDom, { page: 'portfolio-backtester' })
  await page.init()
  await waitFor(() => button('Analyze Portfolio'))

  const main = q('#oa-tool')
  expect(main?.tagName).toBe('MAIN')
  // T11-01: one full-width column with no gutter of its own (the page root carries the 16 px)
  expect(main?.className.split(' ')).toEqual(expect.arrayContaining(['w-full', 'min-w-0']))
  expect(main?.className).not.toMatch(/container|px-|py-/)
  const rootRoute = q('#oa-tool > [data-oa-route="root"]')
  expect(rootRoute?.children).toHaveLength(1)
  expect(main?.hasAttribute('data-oa-main')).toBe(true)
  expect(page.named('route').map((e) => e.path)).toEqual(['/portfolio-backtester'])

  await click(button('Analyze Portfolio'))
  await waitFor(() => text().includes('Backtest Report'))
  expect(page.requests('/api/v1/portfolio/backtest')).toHaveLength(1)
  expect(q('#oa-tool > [data-oa-route="extra"]')?.textContent).toContain('Backtest Report')
  expect(main?.hasAttribute('data-oa-main')).toBe(false)
  expect(page.named('route').map((e) => e.path)).toEqual([
    '/portfolio-backtester',
    '/portfolio-backtester/results',
  ])
})

test('toolReady carries page, csp and webgl', async () => {
  const page = await mountTool(OptionToolsDom, { page: 'gex' })
  await page.init()
  await waitFor(() => page.named('toolReady').length > 0)
  expect(page.named('toolReady')).toEqual([
    { v: 1, kind: 'event', name: 'toolReady', info: { page: 'gex', csp: true, webgl: true } },
  ])
  // then the layout probe's first measure (ux-bar T11-03): jsdom lays nothing out, so 0
  await waitFor(() => page.named('layout').length > 0)
  expect(page.named('layout')).toEqual([{ v: 1, kind: 'event', name: 'layout', overflow: 0 }])
  // a second init changes nothing
  await page.init()
  await act(() => new Promise((r) => setTimeout(r, 50)))
  expect(page.named('toolReady')).toHaveLength(1)
  expect(q('#oa-tool')).not.toBeNull()
})

test('adaptPlotly turns off drag, zoom and the mode bar and keeps hover', () => {
  const react = jest.fn()
  const newPlot = jest.fn()
  const P = { react, newPlot }
  adaptPlotly(P)
  adaptPlotly(P) // once is enough: a second call wraps nothing again
  const gd = { clientWidth: 800 }
  const layout = Object.freeze({ hovermode: 'x unified', dragmode: 'zoom' })
  const config = Object.freeze({ displayModeBar: true, scrollZoom: true, displaylogo: false })
  const data = Object.freeze([Object.freeze({ type: 'bar', x: [0, 1], y: [1, 2] })])

  P.react(gd, { data, layout, config, frames: [] })
  P.newPlot(gd, data, layout, config)

  const [objGd, fig] = react.mock.calls[0] as [unknown, Record<string, Record<string, unknown>>]
  expect(objGd).toBe(gd)
  expect(fig.data).toBe(data)
  expect(fig.frames).toEqual([])
  for (const [l, c] of [
    [fig.layout, fig.config],
    [newPlot.mock.calls[0][2], newPlot.mock.calls[0][3]],
  ] as [Record<string, unknown>, Record<string, unknown>][]) {
    expect(l).toEqual({ hovermode: 'x unified', dragmode: false })
    expect(c).toEqual({
      displayModeBar: false,
      scrollZoom: false,
      doubleClick: false,
      showTips: false,
      responsive: true,
      displaylogo: false,
      locale: 'en-IN',
    })
  }
  expect(newPlot.mock.calls[0][1]).toBe(data)
  // the page's own objects are untouched, and the same layout gives the same copy
  expect(layout).toEqual({ hovermode: 'x unified', dragmode: 'zoom' })
  P.react(gd, { data, layout, config })
  expect(react.mock.calls[1][1].layout).toBe(fig.layout)
  expect(react.mock.calls[1][1].config).toBe(fig.config)
})

test('a CSP violation is reported once as an event; the probe is not', async () => {
  const page = await mountTool(OptionToolsDom, { page: 'ivsmile' })
  await page.init()
  await waitFor(() => page.named('toolReady').length > 0)
  expect(page.named('toolReady')[0]?.info.csp).toBe(true)
  // the probe's own refusal is not a violation
  expect(page.named('violation')).toEqual([])

  violation('https://cdn.example/x.js', 'script-src-elem')
  await act(() => new Promise((r) => setTimeout(r, 0)))
  expect(page.named('violation')).toEqual([
    { v: 1, kind: 'event', name: 'violation', directive: 'script-src-elem' },
  ])
  // never the blocked URL, and at most 20 in a page's life
  for (let i = 0; i < 30; i++) violation(`https://x.example/${i}`, 'connect-src')
  await act(() => new Promise((r) => setTimeout(r, 0)))
  expect(page.named('violation')).toHaveLength(20)
  expect(JSON.stringify(page.sent)).not.toContain('example')
})

test('no entry file exports anything but its default', () => {
  for (const name of ['OptionToolsDom', 'PortfolioToolsDom', 'SectorRotationDom']) {
    const src = readFileSync(join(__dirname, `${name}.tsx`), 'utf8')
    expect(src.startsWith("'use dom'")).toBe(true)
    const exports = src.split('\n').filter((l) => /^\s*export\b/.test(l))
    expect(exports).toEqual([`export default function ${name}(p: ToolDomProps & DomEntryProps) {`])
    // its own marker for the preview manifest (ux-bar T11-20)
    expect(src).toContain(`'oa-entry:src/dom/tools/${name}.tsx'`)
    // prelude, then the stylesheets, then the shell's runtime
    const imports = src.split('\n').filter((l) => /^import ['"]/.test(l))
    expect(imports[0]).toBe("import '~/dom/web/prelude'")
    expect(imports[1]).toBe("import './tool.css'")
  }
  // Plotly's touch adaptation only where a page draws Plotly (ux-bar conflict 8)
  const plotly = (n: string) =>
    readFileSync(join(__dirname, `${n}.tsx`), 'utf8').includes('./plotlyTouch')
  expect(plotly('OptionToolsDom')).toBe(true)
  expect(plotly('PortfolioToolsDom')).toBe(false)
  expect(plotly('SectorRotationDom')).toBe(false)
})

describe('the shell (ux-bar T11)', () => {
  test('a height-only resize keeps --oa-vh; a width change measures it again (T11-07)', async () => {
    const size = (w: number, h: number) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: h })
    }
    size(360, 780)
    const page = await mountTool(OptionToolsDom, { page: 'oitracker' })
    await page.init()
    const vh = () => document.documentElement.style.getPropertyValue('--oa-vh')
    expect(vh()).toBe('7.8px')
    // the keyboard opens: the WebView loses height, not width
    size(360, 420)
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(vh()).toBe('7.8px')
    size(780, 360)
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(vh()).toBe('3.6px')
  })

  test('seeding clears analyzer, sandbox and data-theme; a scheme change re-seeds without a remount (T11-14)', async () => {
    document.documentElement.classList.add('analyzer', 'sandbox')
    document.documentElement.setAttribute('data-theme', 'zinc')
    const page = await mountTool(OptionToolsDom, { page: 'maxpain', scheme: 'light' })
    await page.init()
    await waitFor(() => text().includes('Max Pain: 24200'))
    const html = document.documentElement
    expect([...html.classList]).toEqual([])
    expect(html.hasAttribute('data-theme')).toBe(false)
    expect(useThemeStore.getState()).toEqual(
      expect.objectContaining({ mode: 'light', appMode: 'live' }),
    )

    const pageRoot = q('[data-oa-route="root"] > *')
    const calls = page.sent.length
    await page.rerender('dark')
    expect([...html.classList]).toEqual(['dark'])
    expect(useThemeStore.getState().mode).toBe('dark')
    // the same page, with its state: no remount, no request
    expect(q('[data-oa-route="root"] > *')).toBe(pageRoot)
    expect(text()).toContain('Max Pain: 24200')
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(page.sent.slice(calls).filter((m) => m.kind === 'request')).toEqual([])
    await page.rerender('light')
    expect(html.classList.contains('dark')).toBe(false)
  })

  test('reduced motion marks <html> (T11-18)', async () => {
    const page = await mountTool(OptionToolsDom, { page: 'oirange', reduceMotion: true })
    await page.init()
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(true)
    await page.rerender('dark', false)
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(false)
  })

  test('keep-alive: the report opens at the top, back returns to the builder with its edit and scroll (T11-15)', async () => {
    const page = await mountTool(PortfolioToolsDom, { page: 'portfolio-backtester' })
    await page.init()
    await waitFor(() => button('Analyze Portfolio'))

    // edit a holding's weight, then scroll the builder
    const weight = q<HTMLInputElement>('#oa-tool input[type="number"]')
    await act(async () => type(weight as HTMLInputElement, '75'))
    expect(weight?.value).toBe('75')
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 640 })
    await act(async () => window.dispatchEvent(new Event('scroll')))

    await click(button('Analyze Portfolio'))
    await waitFor(() => text().includes('Backtest Report'))
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 0)
    const builder = q('[data-oa-route="root"]')
    expect(builder?.hidden).toBe(true)
    // the builder stayed mounted, with the edit
    expect(builder?.contains(weight as Node)).toBe(true)

    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    await page.push('tool.back', null)
    await waitFor(() => !q('[data-oa-route="extra"]'))
    expect(page.named('back')).toEqual([{ v: 1, kind: 'event', name: 'back', handled: true }])
    expect(builder?.hidden).toBe(false)
    expect(q<HTMLInputElement>('#oa-tool input[type="number"]')).toBe(weight)
    expect(weight?.value).toBe('75')
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 640)

    // on the builder with nothing open, back is native's
    await page.push('tool.back', null)
    expect(page.named('back').at(-1)).toEqual({ v: 1, kind: 'event', name: 'back', handled: false })
    // top scrolls the page up
    await page.push('tool.top', null)
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 0)
  })

  test('back closes an open picker first (T11-15)', async () => {
    const page = await mountTool(OptionToolsDom, { page: 'maxpain' })
    await page.init()
    await waitFor(() => text().includes('Max Pain: 24200'))
    const trigger = q('[data-slot="popover-trigger"]')
    await click(trigger)
    await waitFor(() => q('[data-slot="popover-content"][data-state="open"]'))
    await page.push('tool.back', null)
    await waitFor(() => !q('[data-slot="popover-content"][data-state="open"]'))
    expect(page.named('back')).toEqual([{ v: 1, kind: 'event', name: 'back', handled: true }])
  })

  test('a report the reply cannot fill shows the fallback, posts pageError and keeps the builder (T11-15)', async () => {
    // React reports the error the boundary caught; the page goes on.
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockReport.real = true
    const page = await mountTool(PortfolioToolsDom, {
      page: 'portfolio-backtester',
      answer: (m) => (isReq(m, '/api/v1/portfolio/backtest') ? ok(THIN_BACKTEST) : undefined),
    })
    await page.init()
    await waitFor(() => button('Analyze Portfolio'))
    await click(button('Analyze Portfolio'))
    await waitFor(() => text().includes("This report couldn't be shown."))
    expect(text()).toContain("The server's reply is missing parts this app reads.")
    expect(page.named('pageError')).toHaveLength(1)
    expect(page.named('pageError')[0]?.message.length).toBeLessThanOrEqual(200)
    expect(logged).toHaveBeenCalled()

    await click(button('Back to builder'))
    await waitFor(() => !q('[data-oa-route="extra"]'))
    expect(q('[data-oa-route="root"]')?.hidden).toBe(false)
    expect(button('Analyze Portfolio')).not.toBeNull()
  })

  test('the SIP report without its headline shows the fallback too (T11-15)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const page = await mountTool(PortfolioToolsDom, {
      page: 'sip-backtester',
      answer: (m) => {
        if (isReq(m, '/api/v1/sip/frequencies'))
          return ok({ status: 'success', data: ['monthly', 'weekly'] })
        if (isReq(m, '/api/v1/sip/backtest'))
          return ok({
            status: 'success',
            request: { symbol: 'NIFTYBEES', exchange: 'NSE', amount: 10_000 },
            yearly: [],
            curves: { value: [], invested: [] },
            installments: [],
            frequency_comparison: [],
            warnings: [],
          })
        return undefined
      },
    })
    await page.init()
    await waitFor(() => button('Run SIP Backtest'))
    await click(button('Run SIP Backtest'))
    await waitFor(() => text().includes("This report couldn't be shown."))
    expect(page.named('pageError')).toHaveLength(1)
    expect(q('[data-oa-route="root"]')).not.toBeNull()
  })

  test('a root page that throws offers Reload tool, which asks native to load again', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const { ToolShell } = require('./shell') as typeof import('./shell')
    const sent: DomEvent[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () =>
      root.render(
        createElement(ToolShell, {
          page: 'oitracker',
          pages: { oitracker: { '/oitracker': BrokenPage } },
          seed: initFor('oitracker').seed,
          scheme: 'dark',
          host: { send: (e: DomEvent) => sent.push(e), onPush: () => () => {} },
        }),
      ),
    )
    expect(container.textContent).toContain("This report couldn't be shown.")
    const pageError = sent.find((e) => e.name === 'pageError') as { message: string }
    expect(pageError.message).toHaveLength(200)
    await click(button('Reload tool'))
    expect(sent.filter((e) => e.name === 'reload')).toHaveLength(1)
    await act(async () => root.unmount())
    container.remove()
  })
})

describe('the phone stylesheets in the page (ux-bar T11)', () => {
  /** The stylesheets as a 360 px touch phone applies them: jsdom applies `screen` media only. */
  function phoneCss(...files: string[]) {
    const css = files
      .map((f) => readFileSync(join(__dirname, f), 'utf8'))
      .join('\n')
      .replace(/@media \((max-width: 767\.98px|pointer: coarse|hover: none)\)/g, '@media screen')
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    return () => style.remove()
  }
  let removeCss: () => void = () => {}
  afterEach(() => removeCss())

  test("the main route hides the page's h1 and blurb, which the native header carries (T11-08)", async () => {
    removeCss = phoneCss('phone.css', 'options.phone.css')
    const page = await mountTool(OptionToolsDom, { page: 'maxpain' })
    await page.init()
    await waitFor(() => text().includes('Max Pain: 24200'))
    const h1 = q('#oa-tool h1')
    expect(h1?.textContent).toBe('Max Pain')
    expect(getComputedStyle(h1 as Element).display).toBe('none')
    const badge = [...document.querySelectorAll('[data-slot="badge"]')].find(
      (b) => b.textContent === 'Max Pain: 24200',
    )
    expect(getComputedStyle(badge as Element).display).not.toBe('none')
    // MP-1: the hero number leads the stat grid
    expect(getComputedStyle(badge as Element).order).toBe('-1')
  })

  test('a results route keeps its h1 (T11-08)', async () => {
    removeCss = phoneCss('phone.css', 'portfolio.phone.css')
    const page = await mountTool(PortfolioToolsDom, { page: 'portfolio-backtester' })
    await page.init()
    await waitFor(() => button('Analyze Portfolio'))
    expect(getComputedStyle(q('#oa-tool h1') as Element).display).toBe('none')
    await click(button('Analyze Portfolio'))
    await waitFor(() => text().includes('Backtest Report'))
    const h1 = q('[data-oa-route="extra"] h1')
    expect(h1?.textContent).toBe('Backtest Report')
    expect(getComputedStyle(h1 as Element).display).not.toBe('none')
  })

  test("the builder's error card stays in view at the bottom on a 429 (E-PB-2)", async () => {
    removeCss = phoneCss('phone.css', 'portfolio.phone.css')
    const page = await mountTool(PortfolioToolsDom, {
      page: 'portfolio-backtester',
      answer: (m) =>
        isReq(m, '/api/v1/portfolio/backtest')
          ? {
              status: 429,
              body: { status: 'error', message: 'Too many requests. Try again in a minute.' },
            }
          : undefined,
    })
    await page.init()
    await waitFor(() => button('Analyze Portfolio'))
    await click(button('Analyze Portfolio'))
    await waitFor(() => text().includes('Too many requests'))
    const card = q('[data-oa-route="root"] > * > [data-slot="card"]:last-child')
    expect(card?.textContent).toContain('Too many requests')
    expect(getComputedStyle(card as Element).position).toBe('sticky')
    expect(getComputedStyle(card as Element).bottom).toBe('8px')
  })

  test("the SIP builder's error box stays in view at the bottom on a 400 (E-SB-1)", async () => {
    removeCss = phoneCss('phone.css', 'portfolio.phone.css')
    const page = await mountTool(PortfolioToolsDom, {
      page: 'sip-backtester',
      answer: (m) =>
        isReq(m, '/api/v1/sip/backtest')
          ? { status: 400, body: { status: 'error', message: 'amount must be at least 100' } }
          : undefined,
    })
    await page.init()
    await waitFor(() => button('Run SIP Backtest'))
    await click(button('Run SIP Backtest'))
    await waitFor(() => text().includes('amount must be at least 100'))
    const box = q('[data-oa-route="root"] > * > :last-child')
    expect(box?.textContent).toBe('amount must be at least 100')
    expect(getComputedStyle(box as Element).position).toBe('sticky')
  })

  /** The last phone rule that sets `property` on `el`, as the cascade of unlayered rules picks
   *  it (jsdom's getComputedStyle lets an inline style win over !important). */
  function phoneRule(el: Element, property: string) {
    const rules: CSSStyleRule[] = []
    const walk = (list: CSSRuleList) => {
      for (const r of Array.from(list)) {
        if ('selectorText' in r) rules.push(r as CSSStyleRule)
        else if ('cssRules' in r) walk((r as CSSMediaRule).cssRules)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules)
    const hit = rules.filter(
      (r) => r.style.getPropertyValue(property) && el.matches(r.selectorText),
    )
    const rule = hit.at(-1)
    return (
      rule && {
        value: rule.style.getPropertyValue(property),
        priority: rule.style.getPropertyPriority(property),
      }
    )
  }

  test('Plot heights come from --oa-plot-h, which the keyboard never changes (T11-07)', async () => {
    removeCss = phoneCss('phone.css', 'options.phone.css')
    const page = await mountTool(OptionToolsDom, { page: 'maxpain' })
    await page.init()
    await waitFor(() => q('[data-testid="plot"]'))
    const plot = q('[data-testid="plot"]') as HTMLElement
    // the page's own inline height, which only !important beats
    expect(plot.style.height).toBe('500px')
    expect(phoneRule(plot, 'height')).toEqual({ value: 'var(--oa-plot-h)', priority: 'important' })
    expect(getComputedStyle(document.documentElement).getPropertyValue('--oa-plot-h')).toMatch(
      /^clamp\(300px, calc\(var\(--oa-vh, 7\.8px\) \* 58\), 480px\)$/,
    )
  })

  test("GEX's two charts take the shorter --oa-plot-h2 (T11-07)", async () => {
    removeCss = phoneCss('phone.css', 'options.phone.css')
    const page = await mountTool(OptionToolsDom, {
      page: 'gex',
      answer: (m) =>
        isReq(m, '/gex/api/gex-data')
          ? ok({
              status: 'success',
              underlying: 'SENSEX',
              spot_price: 24210.5,
              futures_price: null,
              atm_strike: 24200,
              lot_size: 20,
              pcr_oi: 1.1,
              expiry_date: '04DEC26',
              chain: PAIN.map(({ strike }) => ({
                strike,
                ce_oi: 10,
                pe_oi: 12,
                ce_gex: 1,
                pe_gex: -1,
                net_gex: 0.5,
              })),
              total_ce_gex: 5,
              total_pe_gex: -5,
              total_net_gex: 2.5,
            })
          : undefined,
    })
    await page.init()
    await waitFor(() => document.querySelectorAll('[data-testid="plot"]').length === 2)
    for (const plot of Array.from(document.querySelectorAll('[data-testid="plot"]'))) {
      expect((plot as HTMLElement).style.height).toBe('450px')
      expect(phoneRule(plot, 'height')).toEqual({
        value: 'var(--oa-plot-h2)',
        priority: 'important',
      })
    }
  })
})
