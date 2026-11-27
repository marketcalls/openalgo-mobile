import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compare, measure } from './check-bundles.mjs'
import { checkDomExport, DOM_MARKERS, domPages, preludeNeedles } from './lib/dom-export.mjs'
import { loadPage, loadProblems } from './lib/dom-load.mjs'

const NEEDLES = preludeNeedles()
/** What a page's JS holds when its prelude shipped: the policy, the env seed and the literal. */
const PRELUDE_JS = `var P="${NEEDLES.policy}",E={MODE:'production',VITE_API_URL:''},L='${NEEDLES.prelude}';`

const page = (scripts, styles = []) =>
  `<!DOCTYPE html><html><head>${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join('')}<style>x{}</style></head><body><div id="root"></div><script>var polyfill=1</script>${scripts.map((s) => `<script src="${s}" defer></script>`).join('')}</body></html>`

/** An export dir whose www.bundle holds the given pages: {name, scripts:{file: js}, styles?}. */
function exportDir(pages, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dom-export-'))
  const www = join(dir, 'www.bundle')
  mkdirSync(www, { recursive: true })
  for (const p of pages) {
    for (const [file, js] of Object.entries(p.scripts)) writeFileSync(join(www, file), js)
    writeFileSync(join(www, `${p.name}.html`), page(Object.keys(p.scripts), p.styles))
  }
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(www, file), text)
  return dir
}

const CHART_JS = `${PRELUDE_JS}document.title="${DOM_MARKERS.chartDom}";window.__loadBundleAsync=function(){}`

test('domPages finds each page, its one script and its marker', () => {
  const dir = exportDir([
    { name: 'a', scripts: { 'c.js': CHART_JS } },
    { name: 'b', scripts: { 't.js': `x="${DOM_MARKERS.toolDom}"` } },
    { name: 'c', scripts: { 'u.js': 'nothing' } },
  ])
  const pages = domPages(dir)
  assert.equal(pages.length, 3)
  const byMarker = Object.fromEntries(pages.map((p) => [p.marker, p]))
  assert.deepEqual(byMarker.chartDom.scripts, [{ file: 'c.js', bytes: CHART_JS.length }])
  assert.equal(byMarker.toolDom.scripts.length, 1)
  assert.equal(byMarker[null].scripts[0].file, 'u.js')
  assert.deepEqual(byMarker.chartDom.styles, [])
})

test('domPages is empty when the export holds no DOM pages', () => {
  assert.deepEqual(domPages(mkdtempSync(join(tmpdir(), 'dom-none-'))), [])
})

test('chartDom is the JS size of the chart page', () => {
  const dir = exportDir([
    { name: 'a', scripts: { 'c.js': CHART_JS } },
    { name: 'b', scripts: { 't.js': `x="${DOM_MARKERS.toolDom}"` } },
  ])
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ fileMetadata: {} }))
  const m = measure(dir)
  assert.equal(m.chartDom, CHART_JS.length)
  assert.equal(m.toolDom, `x="${DOM_MARKERS.toolDom}"`.length)
})

test('two scripts, a __common chunk or a web chunk path fails the export check', () => {
  const two = exportDir([{ name: 'a', scripts: { 'c.js': CHART_JS, 'd.js': 'y' } }])
  assert.match(checkDomExport(two).join('\n'), /2 scripts/)

  const none = exportDir([{ name: 'a', scripts: {} }])
  assert.match(checkDomExport(none).join('\n'), /0 scripts/)

  const common = exportDir([{ name: 'a', scripts: { 'c.js': CHART_JS } }], {
    '__common-abc.js': 'z',
  })
  assert.match(checkDomExport(common).join('\n'), /__common/)

  const web = exportDir([
    { name: 'a', scripts: { 'c.js': `${CHART_JS};n("/_expo/static/js/web/chunk-1.js")` } },
  ])
  assert.match(checkDomExport(web).join('\n'), /_expo\/static\/js\/web\//)
})

test('a correct page, whose JS holds __loadBundleAsync, passes', () => {
  const dir = exportDir([{ name: 'a', scripts: { 'c.js': CHART_JS } }])
  assert.deepEqual(checkDomExport(dir), [])
})

test('the needles are the app source: the whole release policy and the prelude literal', () => {
  assert.match(NEEDLES.policy, /^default-src 'none'; script-src 'self'; .*connect-src 'none'; /)
  assert.match(NEEDLES.policy, /base-uri 'none'$/)
  assert.equal(NEEDLES.prelude, 'oa-prelude:csp+env')
})

test('a page whose JS lacks the policy, the env seed or the prelude fails the export check', () => {
  // the tree-shaken export at ecb4f00: the prelude gone from every page
  const title = `document.title="${DOM_MARKERS.toolDom}";`
  const cases = [
    [title, /no release Content-Security-Policy[\s\S]*no import\.meta\.env seed[\s\S]*no prelude/],
    [
      PRELUDE_JS.replace(NEEDLES.policy, "default-src 'none'"),
      /no release Content-Security-Policy/,
    ],
    [PRELUDE_JS.replace("VITE_API_URL:''", "VITE_API_URL:'x'"), /no import\.meta\.env seed/],
    [PRELUDE_JS.replace(NEEDLES.prelude, 'oa-prelude:x'), /no prelude/],
  ]
  for (const [js, want] of cases) {
    const dir = exportDir([{ name: 'a', scripts: { 't.js': `${js}${title}` } }])
    assert.match(checkDomExport(dir).join('\n'), want)
  }
  // a double-quoted seed is the same seed
  const dq = exportDir([
    { name: 'a', scripts: { 't.js': PRELUDE_JS.replace("VITE_API_URL:''", 'VITE_API_URL:""') } },
  ])
  assert.deepEqual(checkDomExport(dq), [])
})

/** A page that does at load what the prelude and an entry do, less what `drop` names. */
const LOADING_JS = (drop = []) =>
  [
    drop.includes('throw')
      ? 'throw new Error("Cannot read properties of undefined (reading \'VITE_API_URL\')")'
      : '',
    drop.includes('env')
      ? ''
      : "globalThis.__ExpoImportMetaRegistry={url:location.href,env:{VITE_API_URL:''}}",
    drop.includes('csp')
      ? ''
      : `var m=document.createElement('meta');m.httpEquiv='Content-Security-Policy';m.content="${NEEDLES.policy}";document.head.prepend(m)`,
    drop.includes('entry')
      ? ''
      : `setTimeout(function(){document.documentElement.dataset.oaPrelude='${NEEDLES.prelude}';window.ReactNativeWebView.postMessage(JSON.stringify({type:'$$native_action',data:{args:[{v:1,kind:'event',name:'loaded'}]}}))},10)`,
  ].join(';\n')

test('a page loaded in jsdom passes with its CSP, its env and its entry run', async () => {
  const dir = exportDir([{ name: 'a', scripts: { 'c.js': LOADING_JS() } }])
  const [p] = domPages(dir)
  const r = await loadPage(dir, p, { settleMs: 100 })
  assert.deepEqual(loadProblems(p.name, r, NEEDLES), [])
  assert.equal(r.csp, NEEDLES.policy)
})

test('a page that throws at load, or loads without its CSP, env or entry, fails', async () => {
  const cases = [
    [
      'throw',
      /threw while it loaded: Cannot read properties of undefined \(reading 'VITE_API_URL'\)/,
    ],
    ['csp', /no release CSP <meta> after load/],
    ['env', /import\.meta\.env is not seeded/],
    ['entry', /its entry never ran[\s\S]*never told the host it loaded/],
  ]
  for (const [drop, want] of cases) {
    const dir = exportDir([{ name: 'a', scripts: { 'c.js': LOADING_JS([drop]) } }])
    const [p] = domPages(dir)
    const r = await loadPage(dir, p, { settleMs: 100 })
    assert.match(loadProblems(p.name, r, NEEDLES).join('\n'), want)
  }
})

test('a chartDom over 2,330,000 fails the budget', () => {
  const cfg = {
    growth: 0.05,
    limits: { android: 6000000, ios: 6000000, chartDom: 2330000, toolDom: 1900000 },
    baseline: { android: null, ios: null, chartDom: null, toolDom: null },
  }
  const r = compare({ android: 1, ios: 1, chartDom: 2330001 }, cfg)
  assert.equal(r.ok, false)
  assert.match(r.lines.join('\n'), /chartDom: 2330001 FAIL, over the 2330000 byte limit/)
  assert.equal(compare({ android: 1, ios: 1, chartDom: 2330000 }, cfg).ok, true)
})

const TOOL = (entry, pad = 0) =>
  `document.title="${DOM_MARKERS.toolDom}";x="oa-entry:src/dom/tools/${entry}.tsx";${'a'.repeat(pad)}`

test('three toolDom pages are found by their marker and toolDom is the largest', () => {
  const dir = exportDir([
    { name: 'a', scripts: { 'c.js': CHART_JS } },
    { name: 'b', scripts: { 'o.js': TOOL('OptionToolsDom', 300) } },
    { name: 'c', scripts: { 'p.js': TOOL('PortfolioToolsDom', 200) } },
    { name: 'd', scripts: { 's.js': TOOL('SectorRotationDom', 100) } },
  ])
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ fileMetadata: {} }))
  const tools = domPages(dir).filter((p) => p.marker === 'toolDom')
  assert.deepEqual(tools.map((p) => p.entry).sort(), [
    'OptionToolsDom',
    'PortfolioToolsDom',
    'SectorRotationDom',
  ])
  const m = measure(dir)
  assert.equal(m.toolDom, TOOL('OptionToolsDom', 300).length)
  assert.equal(m.toolPages.PortfolioToolsDom, TOOL('PortfolioToolsDom', 200).length)
  assert.equal(Object.keys(m.toolPages).length, 3)
})

test('a toolDom page over 1,900,000 fails even when the others pass', () => {
  const cfg = {
    growth: 0.05,
    limits: { android: 7000000, ios: 7000000, chartDom: 2330000, toolDom: 1900000 },
    baseline: { android: null, ios: null, chartDom: null, toolDom: null },
  }
  const ok = { android: 1, ios: 1, chartDom: 1 }
  const r = compare(
    {
      ...ok,
      toolDom: 1900001,
      toolPages: { OptionToolsDom: 1000, PortfolioToolsDom: 1900001, SectorRotationDom: 5 },
    },
    cfg,
  )
  assert.equal(r.ok, false)
  assert.match(r.lines.join('\n'), /PortfolioToolsDom: 1900001 FAIL, over the 1900000 byte limit/)
})

test('a page over 1,900,000 passes under its own limit and fails over it', () => {
  const cfg = {
    growth: 0.05,
    limits: {
      android: 7000000,
      ios: 7000000,
      chartDom: 2330000,
      toolDom: 1900000,
      toolDomPages: { OptionToolsDom: 2200000 },
    },
    baseline: { android: null, ios: null, chartDom: null, toolDom: null },
  }
  const ok = { android: 1, ios: 1, chartDom: 1 }
  const pass = compare(
    { ...ok, toolDom: 2100000, toolPages: { OptionToolsDom: 2100000, SectorRotationDom: 9 } },
    cfg,
  )
  assert.equal(pass.ok, true)
  assert.match(pass.lines.join('\n'), /OptionToolsDom: 2100000 ok, 100000 B under the limit/)
  const fail = compare({ ...ok, toolDom: 2200001, toolPages: { OptionToolsDom: 2200001 } }, cfg)
  assert.equal(fail.ok, false)
  assert.match(fail.lines.join('\n'), /OptionToolsDom: 2200001 FAIL, over the 2200000 byte limit/)
  // another entry keeps 1,900,000
  assert.equal(compare({ ...ok, toolDom: 1900001, toolPages: { GexDom: 1900001 } }, cfg).ok, false)
})

test('toolDom growth over the baseline still fails', () => {
  const cfg = {
    growth: 0.05,
    limits: { android: 7000000, ios: 7000000, chartDom: 2330000, toolDom: 1900000 },
    baseline: { android: null, ios: null, chartDom: null, toolDom: 1000000 },
  }
  const r = compare(
    { android: 1, ios: 1, chartDom: 1, toolDom: 1060000, toolPages: { A: 1060000 } },
    cfg,
  )
  assert.equal(r.ok, false)
  assert.match(r.lines.join('\n'), /toolDom \+6\.0% over the baseline/)
})
