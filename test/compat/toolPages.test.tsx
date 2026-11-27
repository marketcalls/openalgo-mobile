/**
 * @jest-environment <rootDir>/test/helpers/jsdomNodeEnv.js
 */
// The ten plan E pages in jsdom over the real native gateway and the mock: the
// page's own requests go through the in-memory bridge to the router that useToolGateway builds
// (test/helpers/toolGateway.ts), which answers the session routes on the phone from /api/v1.
// jsdom stands in for the WebView as src/dom/tools/tools.test.tsx does (Plotly and the canvas are
// stubbed); the pages are loaded through typed require() as there, never a static import.
import { TextDecoder, TextEncoder } from 'node:util'
import { act, createElement, type ReactElement } from 'react'
import { useConnection } from '~/core/services/connection'
import {
  type DomToNative,
  type JSONValue,
  TOOL_TOPICS,
  type ToolDomProps,
  type ToolInit,
  type ToolPageId,
} from '~/dom/bridge/protocol'
import { brokerCaps } from '~/market/brokers/seed'
import { type App, apiCalls, makeApp, sleep, until } from '../helpers/compatApp'
import { cssText, type EntryName, matches, rulesFor } from '../helpers/cssContract'
import { type MockServerProcess, startMockServerProcess } from '../helpers/mockServer'
import { toolGateway } from '../helpers/toolGateway'

jest.mock('~/dom/tools/tool.css', () => ({}))
jest.mock('~/dom/tools/options.phone.css', () => ({}))
jest.mock('~/dom/tools/portfolio.phone.css', () => ({}))
jest.mock('~/dom/tools/rotation.phone.css', () => ({}))
// openalgo-charts needs a canvas: the report's line chart is a plain holder with its role.
jest.mock('@/components/portfolio/PortfolioLineChart', () => {
  const { createElement: h } = require('react') as typeof import('react')
  return { PortfolioLineChart: () => h('div', { role: 'application' }) }
})
// Plotly draws nothing in jsdom (the pages' 2D plot is jest.compat.config.js's stub).
jest.mock('plotly.js/lib/core', () => ({
  react: jest.fn(async () => undefined),
  newPlot: jest.fn(async () => undefined),
  register: jest.fn(),
}))

Object.assign(globalThis, { TextEncoder, TextDecoder })
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= () => {}

type Entry = (p: ToolDomProps & { bridge: (m: JSONValue) => Promise<JSONValue> }) => ReactElement
const ENTRIES: Record<EntryName, Entry> = {
  OptionToolsDom: require('~/dom/tools/OptionToolsDom').default as Entry,
  PortfolioToolsDom: require('~/dom/tools/PortfolioToolsDom').default as Entry,
  SectorRotationDom: require('~/dom/tools/SectorRotationDom').default as Entry,
}
const ENTRY_OF: Record<ToolPageId, EntryName> = {
  oitracker: 'OptionToolsDom',
  oirange: 'OptionToolsDom',
  maxpain: 'OptionToolsDom',
  ivsmile: 'OptionToolsDom',
  gex: 'OptionToolsDom',
  gammadensity: 'OptionToolsDom',
  'portfolio-backtester': 'PortfolioToolsDom',
  'sip-backtester': 'PortfolioToolsDom',
  'portfolio-analyzer': 'PortfolioToolsDom',
  'sector-rotation': 'SectorRotationDom',
}
const { createRoot } = require('react-dom/client') as {
  createRoot(container: Element): { render(node: ReactElement): void; unmount(): void }
}

type Win = typeof window & {
  ReactNativeWebView?: { postMessage: jest.Mock }
  _domRefProxy?: unknown
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
const win = window as Win
const ACCEPTED = { status: 202, body: null }

let mock: MockServerProcess | null = null
let app: App | null = null
const cleanups: Array<() => Promise<void>> = []
beforeAll(() => {
  win.IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  win.ReactNativeWebView = { postMessage: jest.fn() }
  jest.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation((v: string) => {
    queueMicrotask(() =>
      document.dispatchEvent(
        Object.assign(new Event('securitypolicyviolation', { bubbles: true }), {
          blockedURI: v,
          effectiveDirective: 'img-src',
        }),
      ),
    )
  })
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    getExtension: () => ({ loseContext: () => {} }),
  })) as unknown as HTMLCanvasElement['getContext'])
  window.scrollTo = jest.fn() as unknown as typeof window.scrollTo
})
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  jest.restoreAllMocks()
  delete win.ReactNativeWebView
  delete win._domRefProxy
  app?.dispose()
  app = null
  await mock?.stop()
  mock = null
})

/** The mock and the app on it, once per test; a test may mount several pages on them in turn. */
async function startApp() {
  if (mock !== null && app !== null) return { mock, app }
  mock = await startMockServerProcess({ PROFILE: '2.0.3.5' })
  app = await makeApp(mock)
  await until(() => useConnection.getState().brokerSession === 'active', 3000, 'broker checked')
  await sleep(300)
  return { mock, app }
}

/** The page mounted over the gateway: its requests answered by native over the mock. */
async function mountOver(page: ToolPageId) {
  const { mock, app } = await startApp()
  const gw = toolGateway(app, page)
  const paths: string[] = []
  const bridge = async (m: JSONValue): Promise<JSONValue> => {
    const msg = m as DomToNative
    if (msg.kind !== 'request') return ACCEPTED as never
    paths.push(`${msg.method} ${msg.path}`)
    return (await gw.send(msg.method, msg.path, {
      ...(msg.query ? { query: msg.query } : {}),
      ...(msg.body !== undefined ? { body: msg.body } : {}),
    })) as never
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (reduceMotion: boolean) =>
    act(async () => {
      root.render(
        createElement(ENTRIES[ENTRY_OF[page]], { scheme: 'dark', page, reduceMotion, bridge }),
      )
    })
  await render(false)
  let gone = false
  const unmount = async () => {
    if (gone) return
    gone = true
    await act(async () => root.unmount())
    container.remove()
    delete win._domRefProxy
    document.documentElement.removeAttribute('data-oa-tool')
  }
  cleanups.push(unmount)
  const init: ToolInit = {
    page,
    seed: {
      broker: 'zerodha',
      capabilities: brokerCaps('zerodha', app.caps.get()?.version ?? null),
    },
  }
  await act(async () => {
    const script = document.createElement('script')
    script.textContent = `window._domRefProxy.deliver(${JSON.stringify([
      { kind: 'push', topic: TOOL_TOPICS.init, payload: init },
    ])})`
    document.body.append(script)
    script.remove()
  })
  return { mock, app, paths, unmount, render }
}

const text = () => document.body.textContent ?? ''
async function waitFor(check: () => unknown, what: string, ms = 10_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms\n${text().slice(0, 400)}`)
    await act(() => new Promise((r) => setTimeout(r, 25)))
  }
}

/**
 * Everything the mock saw that is not an /api/v1 endpoint: the app's own server probe (app-info, swagger.json) only. A
 * session route (/oitracker, /search, /auth/csrf-token ...) would be listed by its path.
 */
const notApi = async (m: MockServerProcess) => {
  const { requests } = await m.stats()
  return Object.keys(requests).filter((k) => !(k in apiCalls(requests)))
}

test('Max Pain renders "Max Pain: <strike>" from the on-device route; the mock saw only /api/v1 calls', async () => {
  const { mock, paths } = await mountOver('maxpain')
  await waitFor(() => /Max Pain: \d+/.test(text()), 'Max Pain strike', 4000)
  expect(paths).toEqual(expect.arrayContaining(['POST /oitracker/api/maxpain']))
  const seen = Object.keys(apiCalls((await mock.stats()).requests))
  // the on-device route read the chain, never a session route
  expect(seen).toEqual(expect.arrayContaining(['optionchain', 'expiry']))
  expect(await notApi(mock)).toEqual(['/auth/app-info', 'swagger.json'])
})

test('OI Tracker renders its PCR badge; the page never calls a session route on the mock', async () => {
  const { mock, paths } = await mountOver('oitracker')
  await waitFor(() => /PCR \(OI\): \d/.test(text()), 'PCR badge')
  expect(paths).toEqual(expect.arrayContaining(['POST /oitracker/api/oi-data']))
  const seen = Object.keys(apiCalls((await mock.stats()).requests))
  expect(seen).toEqual(expect.arrayContaining(['optionchain']))
  expect(await notApi(mock)).toEqual(['/auth/app-info', 'swagger.json'])
})

// ---------------------------------------------------------------------------------------------
// T15-01, T15-03: the selector contract. Each entry's stylesheets are injected, the page rendered
// over the gateway in each named state, and every rule tagged `@pages <id>` (G19) must match at
// least one element on that page in one of its states. A layout rule that matches nothing would
// otherwise pass CI silently. Rules tagged `none` render in no state and are not checked.
// ---------------------------------------------------------------------------------------------

const q = <E extends Element = HTMLElement>(sel: string) => document.querySelector<E>(sel)
const qa = <E extends Element = HTMLElement>(sel: string, within: ParentNode = document) => [
  ...within.querySelectorAll<E>(sel),
]
const click = (el: Element | null | undefined) =>
  act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
/** Radix Tabs select on mousedown, not click. */
const press = (el: Element | null | undefined) =>
  act(async () => {
    el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  })
const key = (el: Element | Document | null | undefined, k: string) =>
  act(async () => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
const button = (label: string) => qa('button').find((b) => b.textContent?.trim() === label) ?? null
function typeInto(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  return act(async () => {
    set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const closeLayer = () => key(document, 'Escape')

/** What each page shows once its data is in. */
const READY: Record<ToolPageId, RegExp> = {
  oitracker: /PCR \(OI\): \d/,
  oirange: /PCR \(range\): \d/,
  maxpain: /Max Pain: \d/,
  ivsmile: /ATM IV: \d/,
  gex: /Net GEX: /,
  gammadensity: /Sigma Move/,
  'portfolio-backtester': /Portfolio Holdings/,
  'sip-backtester': /Run SIP Backtest/,
  'portfolio-analyzer': /Analyse Holdings/,
  'sector-rotation': /Leading|Lagging/,
}

/** The entry's stylesheets in the page, so computed style can be read. */
function injectCss(entry: EntryName) {
  const style = document.createElement('style')
  style.dataset.contract = entry
  style.textContent = cssText(entry)
  document.head.append(style)
  cleanups.push(async () => style.remove())
}

/** A request of this endpoint answered 400 with the server's sentence, once. */
const refuse = (path: string, message: string) =>
  act(async () => {
    await mock?.control({ failNext: { path, status: 400, body: { status: 'error', message } } })
  })

type Rule = ReturnType<typeof rulesFor>[number]
/** The rules of the page and the ones matched so far, over every state. */
function contractFor(page: ToolPageId) {
  const rules = rulesFor(ENTRY_OF[page], page)
  const hit = new Set<Rule>()
  return {
    rules,
    /** Checks the document now: each rule not yet matched. */
    scan() {
      for (const r of rules) {
        if (!hit.has(r) && r.selectors.some((s) => matches(document, s))) hit.add(r)
      }
    },
    unmatched: () =>
      rules.filter((r) => !hit.has(r)).map((r) => `${r.file}: ${r.selectors.join(' | ')}`),
  }
}

/** An option page's pickers: a popover (the underlying) and a select (exchange, expiry). */
async function openPickers(scan: () => void) {
  await click(q('[data-slot="popover-trigger"]'))
  await waitFor(() => q('[data-slot="popover-content"]'), 'the picker popover')
  scan()
  await closeLayer()
  await waitFor(() => !q('[data-slot="popover-content"]'), 'the popover closed')
  await openSelect(scan)
}
async function openSelect(scan: () => void) {
  await key(q('[data-slot="select-trigger"]'), 'Enter')
  await waitFor(() => q('[data-slot="select-item"]'), 'the select list')
  scan()
  await closeLayer()
  await waitFor(() => !q('[data-slot="select-item"]'), 'the select closed')
}

const PLOT_PAGES: ToolPageId[] = [
  'oitracker',
  'oirange',
  'maxpain',
  'ivsmile',
  'gex',
  'gammadensity',
]
/** The Plot's inline 500/450/420 px, which T11-07's rule sets from --oa-plot-h. */
const PLOT_BOX =
  '#oa-tool [data-slot="card-content"] > div:is([style*="height: 500px"], [style*="height: 450px"], [style*="height: 420px"])'

/** What every page has: the page root where the rules look for it, the data-slot hooks, the Plot stubs. */
function structure(page: ToolPageId) {
  expect(document.documentElement.dataset.oaTool).toBe(page)
  // T11-01: the route holds exactly the page's root, which the 16 px gutter rule styles
  const route = q('#oa-tool > [data-oa-route="root"]')
  expect(route?.children).toHaveLength(1)
  expect(route?.firstElementChild?.matches('#oa-tool > [data-oa-route] > *')).toBe(true)
  // G19: the hooks the rules read
  // (the Analyzer's first state is a bare control row: its cards come with the report)
  const slots = page === 'portfolio-analyzer' ? ['button'] : ['card', 'card-content', 'button']
  for (const slot of slots) {
    expect({ slot, n: qa(`[data-slot="${slot}"]`).length > 0 }).toEqual({ slot, n: true })
  }
  // T11-07: every Plot stub the page draws is a direct child of a card-content and carries one of
  // the three inline heights the rule replaces
  const plots = qa('[data-testid="plot"]')
  if (PLOT_PAGES.includes(page)) expect(plots.length).toBeGreaterThan(0)
  else expect(plots).toHaveLength(0)
  for (const plot of plots) {
    expect({ height: plot.style.height, boxed: plot.matches(PLOT_BOX) }).toEqual({
      height: expect.stringMatching(/^(500|450|420)px$/),
      boxed: true,
    })
  }
}

/** The per-tool text and markup each rule's selector relies on, in the page's first state. */
const TARGETS: Partial<Record<ToolPageId, () => void>> = {
  oitracker: () => {
    const stats = qa('#oa-tool > [data-oa-route] > * > .flex.flex-wrap.gap-2 > [data-slot="badge"]')
    expect(stats.some((b) => /^PCR \(OI\): \d/.test(b.textContent ?? ''))).toBe(true)
  },
  maxpain: () => {
    // MP-1: the hero is the badge with font-semibold
    const hero = q(
      '#oa-tool > [data-oa-route] > * > .flex.flex-wrap.gap-2 > [data-slot="badge"][class~="font-semibold"]',
    )
    expect(hero?.textContent).toMatch(/^Max Pain: \d/)
  },
  oirange: () => {
    // OR-1, OR-2: the steppers by aria-label, the switch's label, "Last updated" at the row's end
    expect(qa('[aria-label$="min strike"], [aria-label$="max strike"]')).toHaveLength(4)
    expect(q('label[for="auto-refresh"]')?.textContent).toMatch(/^Auto-refresh/)
    expect(q('.flex.flex-wrap.gap-2 > [class~="ml-auto"]')?.textContent).toMatch(/^Last updated: /)
    expect(qa('[data-slot="card-content"] > .flex.flex-wrap.items-end.gap-4')).toHaveLength(1)
  },
  ivsmile: () => {
    // IV-1: the near-ATM table, its header the sticky row
    const heads = qa('table thead th').map((t) => t.textContent)
    expect(heads.slice(0, 2)).toEqual(['Strike', 'Call IV'])
    expect(q('[data-slot="card-content"] > .overflow-x-auto > table')).not.toBeNull()
  },
  gex: () => {
    // GX-1, GX-3: the table box, its ATM row, the three level cards
    expect(q('[class~="max-h-[500px]"] table thead th:first-child')?.textContent).toBe('Strike')
    expect(
      q('[class~="max-h-[500px]"] tr[class~="bg-yellow-500/10"] > td:first-child'),
    ).not.toBeNull()
    expect(q('.grid[class~="md:grid-cols-3"]')?.children).toHaveLength(3)
  },
  gammadensity: () => {
    // GD-1, GD-4: eight stat cards, and the freshness badge right after the title
    expect(q('[class~="xl:grid-cols-8"]')?.children).toHaveLength(8)
    expect(q('h1 + [data-slot="badge"]')?.textContent).toMatch(/^(Live|Snapshot)$/)
  },
  'portfolio-backtester': () => {
    // E-PB-1: a holding is a row with its select trigger; the run row's total and Analyze
    expect(
      qa(
        '[data-slot="card-content"] > .flex.items-center.gap-2:has(> [data-slot="select-trigger"])',
      ),
    ).toHaveLength(2)
    expect(
      q('.border-t.pt-3 > [class~="ml-auto"] > [data-slot="button"]:last-child')?.textContent,
    ).toBe('Analyze Portfolio')
    expect(text()).toMatch(/Total 100\.0%/)
  },
  'sip-backtester': () => {
    // E-SB-2: the plan's fields as one flex row whose first child is the symbol search
    expect(
      q('[data-slot="card-content"] > .flex.flex-wrap.items-end.gap-3 > :first-child'),
    ).not.toBeNull()
    expect(q('.border-t.pt-3 > [class~="ml-auto"] > [data-slot="button"]')?.textContent).toBe(
      'Run SIP Backtest',
    )
  },
  'portfolio-analyzer': () => {
    // E-PA-1, E-PA-3: the controls row, its button, and the lone empty-state card in the root
    expect(
      q(
        '#oa-tool > [data-oa-route="root"] > * > :first-child > .flex.items-end.gap-3 > [data-slot="button"]',
      )?.textContent,
    ).toBe('Analyse Holdings')
    expect(
      q('#oa-tool > [data-oa-route="root"] > :only-child > :first-child:last-child'),
    ).not.toBeNull()
  },
  'sector-rotation': () => {
    // E-ROT-1..4: the map, its quadrant names, the symbol table of the two instruments
    const map = q('svg[aria-label="Sector rotation map"]')
    expect(map).not.toBeNull()
    expect(map?.querySelectorAll('g[letter-spacing] > text').length).toBeGreaterThan(0)
    expect(qa('.overflow-auto > table tbody tr')).toHaveLength(2)
    expect(qa('button[aria-label^="Remove "]')).toHaveLength(2)
    expect(qa('button[role="checkbox"]').length).toBeGreaterThan(0)
  },
}

/** One page, its states in turn, the contract scanned in each. */
const STATES: Record<ToolPageId, (scan: () => void) => Promise<void>> = {
  oitracker: openPickers,
  oirange: openPickers,
  maxpain: openPickers,
  ivsmile: openPickers,
  gex: openPickers,
  gammadensity: openPickers,
  'portfolio-backtester': async (scan) => {
    // the builder with three holdings: the third typed and chosen with Enter
    await click(button('Add Stock'))
    const rows = qa<HTMLInputElement>('input[placeholder="Search symbol"]')
    expect(rows).toHaveLength(3)
    await typeInto(rows[2] as HTMLInputElement, 'RELIANCE')
    await key(rows[2], 'Enter')
    expect(
      qa(
        '[data-slot="card-content"] > .flex.items-center.gap-2:has(> [data-slot="select-trigger"])',
      ),
    ).toHaveLength(3)
    scan()
    await openSelect(scan)
    // a refused run: the builder's error stays in view
    await refuse('portfolio/backtest', 'No history for RELIANCE')
    await click(button('Analyze Portfolio'))
    await waitFor(() => q('[class~="border-rose-500/40"]'), 'the builder error')
    scan()
    // twenty years back, so the end-of-year strip thins its labels at 9 and at 17 years
    const start = q<HTMLInputElement>('input[type="date"]')
    await typeInto(start as HTMLInputElement, `${new Date().getFullYear() - 20}-01-02`)
    await click(button('Analyze Portfolio'))
    await waitFor(() => q('[data-oa-route="extra"] [data-slot="tabs-list"]'), 'the report')
    // every results tab
    const tabs = qa('[data-oa-route="extra"] [data-slot="tabs-trigger"]')
    expect(tabs.length).toBeGreaterThanOrEqual(15)
    for (const t of tabs) {
      await press(t)
      await waitFor(() => t.getAttribute('data-state') === 'active', 'the tab')
      scan()
    }
  },
  'sip-backtester': async (scan) => {
    scan()
    await openSelect(scan)
    await refuse('sip/backtest', 'No history for NIFTYBEES')
    await click(button('Run SIP Backtest'))
    await waitFor(() => q('[class~="border-destructive/50"]'), 'the builder error')
    scan()
    await click(button('Run SIP Backtest'))
    await waitFor(() => q('[data-oa-route="extra"] .flex.gap-1.border-b'), 'the SIP report')
    scan()
    const strip = q('[data-oa-route="extra"] .flex.gap-1.border-b')
    // E-SR-1: every section of the report is one button of the strip
    expect(qa('button', strip as HTMLElement).map((b) => b.textContent)).toHaveLength(4)
    for (const t of qa('button', strip as HTMLElement)) {
      await click(t)
      scan()
    }
  },
  'portfolio-analyzer': async (scan) => {
    scan()
    await openSelect(scan)
    await click(button('Analyse Holdings'))
    scan() // the run is in flight: the button is disabled
    await waitFor(() => text().includes('NIFTYBEES'), 'the holdings')
    // E-PA-2: two rows of five summary metrics
    const grids = qa('.grid[class~="md:grid-cols-5"]')
    expect(grids.map((g) => g.children.length)).toEqual([5, 5])
    scan()
  },
  'sector-rotation': async (scan) => {
    scan()
    await openSelect(scan)
    await click(button('Methodology'))
    await waitFor(() => q('[data-slot="dialog-content"]'), 'the methodology dialog')
    scan()
    await closeLayer()
  },
}

const ALL_PAGES = Object.keys(ENTRY_OF) as ToolPageId[]

describe('the phone stylesheets against the live pages (T15-01, T15-03)', () => {
  test.each(ALL_PAGES)(
    '%s: every rule tagged for it matches an element in some state',
    async (page) => {
      const c = contractFor(page)
      expect(c.rules.length).toBeGreaterThan(0)
      const { unmount, render } = await mountOver(page)
      injectCss(ENTRY_OF[page])
      await waitFor(() => READY[page].test(text()), `${page} ready`, 20_000)
      c.scan()
      structure(page)
      TARGETS[page]?.()
      await STATES[page](c.scan)
      // the phone asks for reduced motion
      await render(true)
      c.scan()
      expect(c.unmatched()).toEqual([])
      await unmount()
    },
    120_000,
  )
})

test('with thinToolReplies the real report shows its fallback and the builder stays (E-SH-8, T15-02)', async () => {
  const logged = jest.spyOn(console, 'error').mockImplementation(() => {})
  const { mock } = await mountOver('portfolio-backtester')
  await waitFor(() => button('Analyze Portfolio'), 'the builder')
  await act(async () => {
    await mock.control({ thinToolReplies: true })
  })
  await click(button('Analyze Portfolio'))
  await waitFor(() => text().includes("This report couldn't be shown."), 'the fallback')
  expect(logged).toHaveBeenCalled()
  await click(button('Back to builder'))
  await waitFor(() => button('Analyze Portfolio'), 'the builder again')
  // the same run with the full fixtures renders the report
  await act(async () => {
    await mock.control({ thinToolReplies: false })
  })
  await click(button('Analyze Portfolio'))
  await waitFor(() => q('[data-oa-route="extra"] [data-slot="tabs-list"]'), 'the report')
})
