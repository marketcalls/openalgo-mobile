// The tool DOM pages (design 7.7, 7.8): three 'use dom' entries on one provider shell, the option
// entry on its bare option (no router, no query client; ruling 12a). The "dom" project runs the
// real web pages in jsdom over a fake bridge, as the WebView runs them over DomHost; only Plotly's
// drawing (`@/lib/Plot2D`) and openalgo-charts' canvas are stubbed. The page is on jsdom's http
// origin, not file://, only because jsdom gives a file:// page no localStorage; every request
// resolves against DOM_ORIGIN either way (dom/web/request.ts).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { act, createElement, type ReactElement, type ReactNode } from 'react'
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
    default: (p: { style?: object; data?: unknown[] }) =>
      h('div', { 'data-testid': 'plot', 'data-traces': p.data?.length ?? 0, style: p.style }),
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

// Before any frontend store loads: this WebView's web build last ran in analyzer mode, light, with
// a colour theme. The stores rehydrate from it as they load, as on the web (themeStore.ts:176-190).
localStorage.setItem(
  'openalgo-theme',
  JSON.stringify({ state: { mode: 'light', color: 'zinc', appMode: 'analyzer' }, version: 0 }),
)

type Entry = (p: ToolDomProps & { bridge: (m: JSONValue) => Promise<JSONValue> }) => ReactElement
const OptionToolsDom = require('./OptionToolsDom').default as Entry
const PortfolioToolsDom = require('./PortfolioToolsDom').default as Entry
const SectorRotationDom = require('./SectorRotationDom').default as Entry
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
/**
 * The full BacktestResponse the mock serves (dev/mock-server/toolReports.mjs, T15-02): every tab of
 * the real report renders from it, so the shell's routing tests run the real page.
 */
const { backtestReport } = require('../../../dev/mock-server/toolReports.mjs') as {
  backtestReport(body: object): typeof THIN_BACKTEST
}
const BACKTEST = backtestReport({
  holdings: [
    { symbol: 'NIFTYBEES', exchange: 'NSE', weight: 60 },
    { symbol: 'GOLDBEES', exchange: 'NSE', weight: 40 },
  ],
  start_date: '2021-11-27',
  end_date: '2026-11-27',
  benchmark: 'NIFTY',
  source: 'api',
})

/** frontend api/sector-rotation.ts RotationOptions and RotationResult, one sector on the map. */
const ROTATION_OPTIONS = {
  benchmarks: [{ symbol: 'NIFTY', exchange: 'NSE_INDEX', label: 'Nifty 50' }],
  timeframes: ['daily', 'weekly'],
  exchanges: ['NSE', 'NSE_INDEX'],
  max_instruments: 40,
  sectors: [{ symbol: 'NIFTYIT', exchange: 'NSE_INDEX', label: 'IT' }],
  optional_sectors: [],
  max_tail: 20,
}
const ROTATION = {
  benchmark: 'NIFTY',
  benchmark_exchange: 'NSE_INDEX',
  benchmark_label: 'Nifty 50',
  timeframe: 'daily',
  source: 'api',
  as_of: '2026-11-26',
  max_tail: 20,
  instruments: [
    {
      symbol: 'NIFTYIT',
      exchange: 'NSE_INDEX',
      label: 'IT',
      quadrant: 'leading',
      rs_ratio: 101.2,
      rs_momentum: 100.6,
      bars_in_quadrant: 3,
      tail: [
        { date: '2026-11-24', rs_ratio: 100.4, rs_momentum: 99.8 },
        { date: '2026-11-25', rs_ratio: 100.8, rs_momentum: 100.2 },
        { date: '2026-11-26', rs_ratio: 101.2, rs_momentum: 100.6 },
      ],
    },
  ],
  unavailable: [],
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
/** Root pages that call the hooks only ToolShell's providers serve. */
function RouterHookPage() {
  ;(require('react-router') as typeof import('react-router')).useNavigate()
  return 'hooked'
}
function QueryHookPage() {
  ;(require('@tanstack/react-query') as typeof import('@tanstack/react-query')).useQueryClient()
  return 'hooked'
}

/** The default shell and its bare option. */
const SHELLS = ['ToolShell', 'BareToolShell'] as const
const shellOf = (name: (typeof SHELLS)[number]) =>
  name === 'ToolShell'
    ? (require('./shell') as typeof import('./shell')).ToolShell
    : (require('./shellCore') as typeof import('./shellCore')).BareToolShell

/** A shell with one root page at /oitracker and a recording host. */
async function mountShell(name: (typeof SHELLS)[number], Page: () => ReactNode) {
  const sent: DomEvent[] = []
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      createElement(shellOf(name), {
        page: 'oitracker',
        pages: { oitracker: { '/oitracker': Page } },
        seed: initFor('oitracker').seed,
        scheme: 'dark',
        host: { send: (e: DomEvent) => sent.push(e), onPush: () => () => {} },
      }),
    ),
  )
  let gone = false
  const unmount = async () => {
    if (gone) return
    gone = true
    await act(async () => root.unmount())
    container.remove()
  }
  mounted.push(unmount)
  return { sent, container, unmount }
}

/**
 * The packages a 'use dom' entry's bundle can hold: every import, re-export and require that its
 * app and frontend sources reach (`./`, `~/`, `@/`), followed as Metro follows them. A type-only
 * import is erased, so it is not followed. Packages are not walked into.
 */
function packagesReached(entryFile: string): Set<string> {
  const ts = require('typescript') as typeof import('typescript')
  const SRC = join(__dirname, '../..')
  const FRONTEND = join(__dirname, '../../../openalgo/frontend/src')
  const seen = new Set<string>()
  const packages = new Set<string>()
  const resolve = (from: string, spec: string): string => {
    const base = spec.startsWith('~/')
      ? join(SRC, spec.slice(2))
      : spec.startsWith('@/')
        ? join(FRONTEND, spec.slice(2))
        : join(dirname(from), spec)
    const file = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']
      .map((ext) => base + ext)
      .find((f) => existsSync(f) && statSync(f).isFile())
    if (file === undefined) throw new Error(`${spec} (from ${from}) does not resolve`)
    return file
  }
  const specifiers = (file: string): string[] => {
    const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const out: string[] = []
    const walk = (node: import('typescript').Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const c = node.importClause
        const named = c?.namedBindings
        const typeOnly =
          c !== undefined &&
          (c.isTypeOnly ||
            (c.name === undefined &&
              named !== undefined &&
              ts.isNamedImports(named) &&
              named.elements.length > 0 &&
              named.elements.every((e) => e.isTypeOnly)))
        if (!typeOnly) out.push(node.moduleSpecifier.text)
      } else if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        out.push(node.moduleSpecifier.text)
      } else if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
          node.expression.kind === ts.SyntaxKind.ImportKeyword)
      ) {
        const [arg] = node.arguments
        if (node.arguments.length === 1 && arg !== undefined && ts.isStringLiteral(arg))
          out.push(arg.text)
      }
      ts.forEachChild(node, walk)
    }
    walk(src)
    return out
  }
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    if (!/\.[jt]sx?$/.test(file)) return // a stylesheet or an asset
    for (const spec of specifiers(file)) {
      if (/^(\.|~\/|@\/)/.test(spec)) visit(resolve(file, spec))
      else
        packages.add(
          spec
            .split('/')
            .slice(0, spec.startsWith('@') ? 2 : 1)
            .join('/'),
        )
    }
  }
  visit(entryFile)
  return packages
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

test("each new route wakes the shell's helpers, as the report mounts after its builder", async () => {
  // the observer that marks the web's always-emerald Total Return as a loss lets go after 10 s
  // idle; a backtest that runs longer must still have its report marked (helpers.test.ts)
  const helpers = require('./helpers') as typeof import('./helpers')
  const real = helpers.installHelpers
  const wake = jest.fn()
  const spy = jest.spyOn(helpers, 'installHelpers').mockImplementation((w) => {
    const h = real(w)
    return {
      wake: () => {
        wake()
        h.wake()
      },
      dispose: h.dispose,
    }
  })
  try {
    const page = await mountTool(PortfolioToolsDom, { page: 'portfolio-backtester' })
    await page.init()
    await waitFor(() => button('Analyze Portfolio'))
    expect(spy).toHaveBeenCalledTimes(1)
    const before = wake.mock.calls.length
    await click(button('Analyze Portfolio'))
    await waitFor(() => text().includes('Backtest Report'))
    expect(wake.mock.calls.length).toBe(before + 1)
  } finally {
    spy.mockRestore()
  }
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

test('adaptPlotly keeps the mode bar only for a 3D scene whose page chose its buttons (T11-04, plan F V4)', () => {
  const react = jest.fn()
  const newPlot = jest.fn()
  const P = { react, newPlot }
  adaptPlotly(P)
  const gd = { clientWidth: 800 }
  // deep-frozen: a write to any of them would throw (the module is strict)
  const buttons = Object.freeze([Object.freeze(['resetCameraDefault3d', 'hoverClosest3d'])])
  const scene = Object.freeze({
    hovermode: 'closest',
    scene: Object.freeze({ dragmode: 'turntable' }),
  })
  const flat = Object.freeze({ hovermode: 'x unified' })
  const chosen = Object.freeze({ modeBarButtons: buttons, displaylogo: false, scrollZoom: true })
  const plain = Object.freeze({ displaylogo: false })
  const data = Object.freeze([Object.freeze({ type: 'surface', z: Object.freeze([1, 2]) })])
  const configOf = (call: number) => react.mock.calls[call][1].config as Record<string, unknown>

  P.react(gd, { data, layout: scene, config: chosen })
  P.newPlot(gd, data, scene, chosen)
  for (const c of [configOf(0), newPlot.mock.calls[0][3] as Record<string, unknown>]) {
    expect(c).toEqual({
      modeBarButtons: buttons,
      displaylogo: false,
      displayModeBar: true,
      scrollZoom: false,
      doubleClick: false,
      showTips: false,
      responsive: true,
      locale: 'en-IN',
    })
    expect(c.modeBarButtons).toBe(buttons)
  }
  // hover is kept, drag is off, and the scene is the page's own
  expect(react.mock.calls[0][1].layout).toEqual({ ...scene, dragmode: false })
  expect(react.mock.calls[0][1].layout.scene).toBe(scene.scene)

  // a scene with Plotly's default buttons, and chosen buttons on a 2D figure: no mode bar
  P.react(gd, { data, layout: scene, config: plain })
  expect(configOf(1).displayModeBar).toBe(false)
  P.react(gd, { data, layout: flat, config: Object.freeze({ modeBarButtons: buttons }) })
  expect(configOf(2).displayModeBar).toBe(false)
  P.newPlot(gd, data, flat, chosen)
  expect((newPlot.mock.calls[1][3] as Record<string, unknown>).displayModeBar).toBe(false)

  // one config object follows the layout it is drawn with, both ways
  const reused = Object.freeze({ modeBarButtons: buttons })
  P.react(gd, { data, layout: flat, config: reused })
  P.react(gd, { data, layout: scene, config: reused })
  P.react(gd, { data, layout: flat, config: reused })
  expect([3, 4, 5].map((n) => configOf(n).displayModeBar)).toEqual([false, true, false])

  // the page's objects are as they were
  expect(scene).toEqual({ hovermode: 'closest', scene: { dragmode: 'turntable' } })
  expect(chosen).toEqual({ modeBarButtons: buttons, displaylogo: false, scrollZoom: true })
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
    // the prelude by a name it uses (prelude.ts: tree shaking drops a bare import), then the
    // stylesheets, then the shell's runtime
    const imports = src.split('\n').filter((l) => /^import\b/.test(l))
    expect(imports[0]).toBe("import { PRELUDE } from '~/dom/web/prelude'")
    expect(imports[1]).toBe("import './tool.css'")
    expect(src).toContain('prelude={PRELUDE}')
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

  test.each(SHELLS)(
    'a root page that throws offers Reload tool, which asks native to load again (%s)',
    async (name) => {
      jest.spyOn(console, 'error').mockImplementation(() => {})
      const { sent, container } = await mountShell(name, BrokenPage)
      expect(container.textContent).toContain("This report couldn't be shown.")
      const pageError = sent.find((e) => e.name === 'pageError') as { message: string }
      expect(pageError.message).toHaveLength(200)
      await click(button('Reload tool'))
      expect(sent.filter((e) => e.name === 'reload')).toHaveLength(1)
    },
  )
})

describe('the bare shell (ruling 12a): the six option pages with no MemoryRouter and no QueryClientProvider', () => {
  /** The server's own replies to each page's route for SENSEX on BFO (T5's mock-sensex golden). */
  const GOLDEN = JSON.parse(
    readFileSync(join(__dirname, '../../../test/golden/expected/mock-sensex.json'), 'utf8'),
  ) as { routes: Record<string, { status: number; body: JSONValue }> }
  const OPTION_PAGES: { page: ToolPageId; title: string; route: string; golden: string }[] = [
    {
      page: 'oitracker',
      title: 'OI Tracker',
      route: '/oitracker/api/oi-data',
      golden: 'get_oi_data',
    },
    { page: 'oirange', title: 'OI Range', route: '/oitracker/api/oi-data', golden: 'get_oi_data' },
    {
      page: 'maxpain',
      title: 'Max Pain',
      route: '/oitracker/api/maxpain',
      golden: 'calculate_max_pain',
    },
    {
      page: 'ivsmile',
      title: 'IV Smile',
      route: '/ivsmile/api/iv-smile-data',
      golden: 'get_iv_smile_data',
    },
    { page: 'gex', title: 'GEX Dashboard', route: '/gex/api/gex-data', golden: 'get_gex_data' },
    {
      page: 'gammadensity',
      title: 'Gamma Density',
      route: '/gammadensity/api/gamma-data',
      golden: 'calculate_gamma_density',
    },
  ]

  test.each(OPTION_PAGES)(
    '$page renders at its root, seeded and themed, draws the reply, and the layout probe reports',
    async ({ page: id, title, route, golden }) => {
      const reply = GOLDEN.routes[golden] as DomReply
      expect(reply.status).toBe(200)
      const page = await mountTool(OptionToolsDom, {
        page: id,
        answer: (m) => (isReq(m, route) ? reply : undefined),
      })
      await page.init()
      await waitFor(() => q('[data-testid="plot"]'))

      // the page, at its root path, kept alive in the shell's main
      expect(q('#oa-tool')?.hasAttribute('data-oa-main')).toBe(true)
      expect(q('#oa-tool > [data-oa-route="root"] h1')?.textContent).toBe(title)
      expect(q('[data-oa-route="extra"]')).toBeNull()
      expect(page.named('route').map((e) => e.path)).toEqual([`/${id}`])
      // the stores the page reads: the placeholder key, the broker's exchanges, dark and live
      expect(useAuthStore.getState().apiKey).toBe(NATIVE_KEY)
      expect(useBrokerStore.getState()).toEqual(
        expect.objectContaining({ capabilities: CAPS, isLoaded: true }),
      )
      expect(useThemeStore.getState()).toEqual(
        expect.objectContaining({ mode: 'dark', appMode: 'live' }),
      )
      expect([...document.documentElement.classList]).toEqual(['dark'])
      expect(document.documentElement.dataset.oaTool).toBe(id)
      // it works: the picks reach its route once, and the reply becomes its chart's traces
      expect(page.requests(route).map((r) => r.body)).toEqual([
        expect.objectContaining({ underlying: 'SENSEX', exchange: 'BFO', expiry_date: '04DEC26' }),
      ])
      for (const plot of Array.from(document.querySelectorAll('[data-testid="plot"]')))
        expect(Number(plot.getAttribute('data-traces'))).toBeGreaterThan(0)
      // ready, then the layout probe's first measure (jsdom lays nothing out, so 0)
      await waitFor(() => page.named('layout').length > 0)
      expect(page.named('toolReady').map((e) => e.info)).toEqual([
        { page: id, csp: true, webgl: true },
      ])
      expect(page.named('layout')).toEqual([{ v: 1, kind: 'event', name: 'layout', overflow: 0 }])
      expect(page.named('error')).toEqual([])
    },
  )

  test.each(OPTION_PAGES)(
    "$page's error reply is the alert store's toast",
    async ({ page: id, title, route }) => {
      const message = `${title}: the chain is not ready`
      const page = await mountTool(OptionToolsDom, {
        page: id,
        answer: (m) => (isReq(m, route) ? ok({ status: 'error', message }) : undefined),
      })
      await page.init()
      const toast = () =>
        [...document.querySelectorAll('[data-sonner-toast]')].find((t) =>
          t.textContent?.includes(message),
        )
      await waitFor(toast)
      expect(toast()?.getAttribute('data-type')).toBe('error')
      // where the seeded alert store puts it: top centre
      const toaster = toast()?.closest('[data-sonner-toaster]')
      expect(toaster?.getAttribute('data-y-position')).toBe('top')
      expect(toaster?.getAttribute('data-x-position')).toBe('center')
      // the page is still there
      expect(q('#oa-tool [data-oa-route="root"] h1')?.textContent).toBe(title)
      expect(page.named('pageError')).toEqual([])
    },
  )

  test.each([
    ['a router hook', 'useNavigate() may be used only in the context of a <Router> component'],
    ['a query hook', 'No QueryClient set, use QueryClientProvider to set one'],
  ])(
    'a page that calls %s renders on ToolShell; on BareToolShell it gets the fallback',
    async (what, thrown) => {
      jest.spyOn(console, 'error').mockImplementation(() => {})
      const Hooked = what === 'a router hook' ? RouterHookPage : QueryHookPage
      const full = await mountShell('ToolShell', Hooked)
      expect(full.container.textContent).toBe('hooked')
      expect(full.sent.filter((e) => e.name === 'pageError')).toEqual([])
      await full.unmount()

      const bare = await mountShell('BareToolShell', Hooked)
      expect(bare.container.textContent).toContain("This report couldn't be shown.")
      const pageError = bare.sent.find((e) => e.name === 'pageError') as { message: string }
      expect(pageError.message).toContain(thrown)
    },
  )

  test("the option entry's bundle reaches neither react-router nor @tanstack; the other two keep both", () => {
    const reached = (entry: string) => packagesReached(join(__dirname, `${entry}.tsx`))
    const providers = (pkgs: Set<string>) =>
      [...pkgs].filter((p) => p === 'react-router' || p.startsWith('@tanstack/')).sort()
    const option = reached('OptionToolsDom')
    // the walk does reach the pages' own packages
    for (const pkg of ['sonner', 'lucide-react', 'axios', 'zustand', 'plotly.js'])
      expect({ pkg, reached: option.has(pkg) }).toEqual({ pkg, reached: true })
    expect(providers(option)).toEqual([])
    for (const entry of ['PortfolioToolsDom', 'SectorRotationDom'])
      expect(providers(reached(entry))).toEqual(['@tanstack/react-query', 'react-router'])
  })
})

describe('the phone stylesheets in the page (ux-bar T11)', () => {
  /** The stylesheets as a touch phone `width` px wide applies them. jsdom applies `screen` media
   *  only, so each query is decided here: widths against `width`, a touch screen (no hover, a
   *  coarse pointer) and no reduced motion; a query that holds becomes `screen`, one that does
   *  not `print`. */
  function phoneCssAt(width: number, ...files: string[]) {
    const holds = (query: string) =>
      query.split(/\s+and\s+/).every((feature) => {
        const range = /^\((min|max)-width: ([\d.]+)px\)$/.exec(feature)
        if (range) return range[1] === 'min' ? width >= Number(range[2]) : width <= Number(range[2])
        if (feature === '(hover: none)' || feature === '(pointer: coarse)') return true
        if (feature === '(prefers-reduced-motion: reduce)') return false
        throw new Error(`phoneCssAt has no answer for ${feature}`)
      })
    const css = files
      .map((f) => readFileSync(join(__dirname, f), 'utf8'))
      .join('\n')
      .replace(
        /@media ([^{]+?)\s*\{/g,
        (_, query: string) => `@media ${holds(query.trim()) ? 'screen' : 'print'} {`,
      )
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    return () => style.remove()
  }
  /** The narrowest phone the bar names. */
  const phoneCss = (...files: string[]) => phoneCssAt(360, ...files)
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
   *  it (jsdom's getComputedStyle lets an inline style win over !important, and drops SVG's
   *  `r`). A query phoneCssAt decided does not hold is not in the cascade. */
  function phoneRule(el: Element, property: string) {
    const rules: CSSStyleRule[] = []
    const walk = (list: CSSRuleList) => {
      for (const r of Array.from(list)) {
        if ('selectorText' in r) rules.push(r as CSSStyleRule)
        else if ('cssRules' in r && (r as CSSMediaRule).media?.mediaText !== 'print')
          walk((r as CSSMediaRule).cssRules)
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

  test('the rotation map: head labels 64 at 360, 56 from 401 to 767, the rest the same across (E-ROT-1)', async () => {
    const page = await mountTool(SectorRotationDom, {
      page: 'sector-rotation',
      answer: (m) =>
        isReq(m, '/api/v1/sectorrotation/options')
          ? ok({ status: 'success', data: ROTATION_OPTIONS })
          : isReq(m, '/api/v1/sectorrotation')
            ? ok({ status: 'success', data: ROTATION })
            : undefined,
    })
    await page.init()
    await waitFor(() => q('svg[aria-label="Sector rotation map"] text.fill-foreground'))
    const map = q('svg[aria-label="Sector rotation map"]') as Element
    const label = map.querySelector('text.fill-foreground') as Element
    expect(label.textContent).toBe('IT')
    const quadrant = map.querySelector('g[letter-spacing] > text') as Element
    const axis = map.querySelector('text.fill-muted-foreground') as Element
    const head = map.querySelector('circle.stroke-background') as Element
    const tailDot = map.querySelector('g > circle:not(.stroke-background)') as Element
    const trail = map.querySelector('polyline') as Element
    const at = (width: number) => {
      removeCss()
      removeCss = phoneCssAt(width, 'phone.css', 'rotation.phone.css')
      return {
        label: phoneRule(label, 'font-size')?.value,
        quadrant: phoneRule(quadrant, 'font-size')?.value,
        axis: phoneRule(axis, 'font-size')?.value,
        head: phoneRule(head, 'r')?.value,
        tail: phoneRule(tailDot, 'r')?.value,
        trail: phoneRule(trail, 'stroke-width')?.value,
        rendered: getComputedStyle(label).fontSize,
      }
    }
    const marks = { quadrant: '60px', axis: '52px', head: '30px', tail: '11px', trail: '6' }
    for (const width of [320, 360, 400]) {
      expect({ width, ...at(width) }).toEqual({ width, label: '64px', rendered: '64px', ...marks })
    }
    for (const width of [401, 412, 767]) {
      expect({ width, ...at(width) }).toEqual({ width, label: '56px', rendered: '56px', ...marks })
    }
    // a tablet draws the web's own sizes
    expect(at(800)).toEqual({
      label: undefined,
      quadrant: undefined,
      axis: undefined,
      head: undefined,
      tail: undefined,
      trail: undefined,
      rendered: expect.not.stringMatching(/^(56|64)px$/),
    })
  })

  test("the EOY chart's year labels take their bars' slots and thin out at 9 or more years, the latest always shown (E-PR-3)", async () => {
    removeCss = phoneCss('phone.css', 'portfolio.phone.css')
    const { EoyChart } = require('@/components/portfolio/EoyChart') as {
      EoyChart: (p: {
        rows: { year: string; portfolio: number; benchmark: number }[]
      }) => ReactElement
    }
    /** The year labels a report of `years` years shows. Each count is a fresh chart: nwsapi
     *  keeps a parent's child positions after children are added, which a browser does not. */
    const shown = async (years: number) => {
      const rows = Array.from({ length: years }, (_, i) => ({
        year: String(2001 + i),
        portfolio: i % 3 === 0 ? -0.05 : 0.12,
        benchmark: 0.1,
      }))
      const main = document.createElement('main')
      main.id = 'oa-tool'
      document.body.append(main)
      const root = createRoot(main)
      try {
        await act(async () => root.render(createElement(EoyChart, { rows })))
        const labels = Array.from(main.querySelectorAll('.flex.pl-12 > span'))
        expect(labels.map((l) => l.textContent)).toEqual(rows.map((r) => r.year))
        // Every label, shown or hidden, is exactly 1/n of the strip, as its bars are in the SVG:
        // flex-1 with no automatic minimum, which would hold a slot at its year's width (about
        // 30 px at 12 px) and push the strip off the card from 9 years at 360 px. A year wider
        // than its slot centres on it. jsdom does no layout, so the browser measurement is in
        // the T11 report (fix round 2); this checks the rules that give it.
        for (const l of labels) {
          expect({
            year: l.textContent,
            minWidth: phoneRule(l, 'min-width')?.value,
            display: getComputedStyle(l).display,
            justify: getComputedStyle(l).justifyContent,
          }).toEqual({ year: l.textContent, minWidth: '0', display: 'flex', justify: 'center' })
          expect(l.className.split(' ')).toContain('flex-1')
        }
        const hidden = labels.filter((l) => getComputedStyle(l).visibility === 'hidden')
        // a hidden label keeps its slot under its bars
        for (const l of hidden) expect(getComputedStyle(l).display).not.toBe('none')
        return labels.filter((l) => !hidden.includes(l)).map((l) => l.textContent)
      } finally {
        await act(async () => root.unmount())
        main.remove()
      }
    }
    expect(await shown(8)).toEqual(['2001', '2002', '2003', '2004', '2005', '2006', '2007', '2008'])
    expect(await shown(9)).toEqual(['2001', '2003', '2005', '2007', '2009'])
    expect(await shown(10)).toEqual(['2002', '2004', '2006', '2008', '2010'])
    expect(await shown(16)).toEqual([
      '2002',
      '2004',
      '2006',
      '2008',
      '2010',
      '2012',
      '2014',
      '2016',
    ])
    expect(await shown(17)).toEqual(['2001', '2005', '2009', '2013', '2017'])
    expect(await shown(26)).toEqual(['2002', '2006', '2010', '2014', '2018', '2022', '2026'])
  })
})
