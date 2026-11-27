// Loads an exported DOM page in jsdom as the WebView does (design 7.7): the page's own html, its
// inline scripts with the host's injected object, then its one bundle. What the bytes that ship do
// at load is what the device gets, so a page that throws at load, or that runs without its CSP or
// its import.meta.env seed, fails here before any device sees it. jsdom has no canvas and no
// layout, so only what the prelude and the entry's first effect do is checked, not the drawing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM, VirtualConsole } from 'jsdom'

const WWW = 'www.bundle'
const INLINE = /<script>([\s\S]*?)<\/script>/g

/** The props the host gives a page: a tool page is opened on one of its entry's tools. */
const TOOL_PAGE = {
  OptionToolsDom: 'maxpain',
  PortfolioToolsDom: 'portfolio-backtester',
  SectorRotationDom: 'sector-rotation',
}
export function initialProps(page) {
  if (page.marker === 'chartDom') return { scheme: 'dark' }
  return { scheme: 'dark', page: TOOL_PAGE[page.entry] ?? 'maxpain', reduceMotion: true }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Loads `page` (a domPages() entry of `dir`) and reports, after `settleMs`: an exception its
 *  script threw while it evaluated, the CSP <meta> it installed, its import.meta.env, the prelude
 *  literal its entry wrote on <html>, and every message it posted to the host. */
export async function loadPage(dir, page, { settleMs = 1500 } = {}) {
  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => errors.push(String(e?.detail?.message ?? e?.message ?? e)))
  // the head and body without their scripts: those run below, in their order
  const html = page.html.replace(/<script\b[\s\S]*?<\/script>/g, '')
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: `file:///android_asset/${WWW}/${page.name}`,
    virtualConsole: vc,
    pretendToBeVisual: true,
  })
  const w = dom.window
  const posted = []
  const injected = JSON.stringify({
    EXPO_DOM_HOST_OS: 'android',
    initialProps: { names: ['bridge'], props: initialProps(page) },
  })
  w.ReactNativeWebView = {
    postMessage: (m) => posted.push(String(m)),
    injectedObjectJson: () => injected,
  }
  // What every WebView has and jsdom does not: User Timing (Expo's inline polyfill binds it) and
  // the text codecs
  w.performance.measure ??= () => {}
  w.performance.clearMeasures ??= () => {}
  w.TextEncoder ??= TextEncoder
  w.TextDecoder ??= TextDecoder
  // each <script> runs on its own, as in a browser: one that throws does not stop the next
  let thrown = null
  const run = (code) => {
    try {
      w.eval(code)
    } catch (e) {
      thrown ??= String(e?.message ?? e)
    }
  }
  for (const m of page.html.matchAll(INLINE)) run(m[1])
  for (const s of page.scripts) run(readFileSync(join(dir, WWW, s.file), 'utf8'))
  await wait(settleMs)
  const metas = [...w.document.head.querySelectorAll('meta')]
  const csp = metas.find((m) => m.httpEquiv === 'Content-Security-Policy')?.content ?? null
  const env = w.__ExpoImportMetaRegistry?.env ?? null
  const prelude = w.document.documentElement.dataset.oaPrelude ?? null
  const result = { thrown, errors, csp, env, prelude, posted }
  w.close()
  return result
}

/** What makes a loaded page unfit to ship. */
export function loadProblems(name, r, needles) {
  const problems = []
  if (r.thrown !== null) problems.push(`${name}: threw while it loaded: ${r.thrown}`)
  if (r.csp !== needles.policy) {
    problems.push(`${name}: no release CSP <meta> after load (got ${JSON.stringify(r.csp)})`)
  }
  if (r.env === null || r.env.VITE_API_URL !== '') {
    problems.push(`${name}: import.meta.env is not seeded after load`)
  }
  if (r.prelude !== needles.prelude) {
    problems.push(`${name}: its entry never ran (no data-oa-prelude after load)`)
  }
  if (!r.posted.some((m) => m.includes('"loaded"'))) {
    problems.push(`${name}: never told the host it loaded`)
  }
  return problems
}
