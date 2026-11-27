import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compare, measure } from './check-bundles.mjs'
import { checkDomExport, DOM_MARKERS, domPages } from './lib/dom-export.mjs'

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

const CHART_JS = `document.title="${DOM_MARKERS.chartDom}";window.__loadBundleAsync=function(){}`

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
