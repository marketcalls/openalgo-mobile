/**
 * @jest-environment <rootDir>/test/helpers/jsdomNodeEnv.js
 */
// The real Max Pain and OI Tracker pages in jsdom over the real native gateway and the mock: the
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
import { type MockServerProcess, startMockServerProcess } from '../helpers/mockServer'
import { toolGateway } from '../helpers/toolGateway'

jest.mock('~/dom/tools/tool.css', () => ({}))
jest.mock('~/dom/tools/options.phone.css', () => ({}))
jest.mock('~/dom/tools/portfolio.phone.css', () => ({}))
jest.mock('~/dom/tools/rotation.phone.css', () => ({}))
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
const OptionToolsDom = require('~/dom/tools/OptionToolsDom').default as Entry
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

/** The page mounted over the gateway: its requests answered by native over the mock. */
async function mountOver(page: ToolPageId) {
  mock = await startMockServerProcess({ PROFILE: '2.0.3.5' })
  app = await makeApp(mock)
  await until(() => useConnection.getState().brokerSession === 'active', 3000, 'broker checked')
  await sleep(300)
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
  await act(async () => {
    root.render(
      createElement(OptionToolsDom, { scheme: 'dark', page, reduceMotion: false, bridge }),
    )
  })
  cleanups.push(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
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
  return { mock, app, paths }
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
