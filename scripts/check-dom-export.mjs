// Fails when the exported DOM pages are not one self-contained script each, when their bytes lack
// what the prelude does (the release CSP, the import.meta.env seed), or when a page, loaded in
// jsdom as the WebView loads it, throws at load, runs without its CSP or env, or never says it
// loaded. A tree-shaken export once shipped every page that way (src/dom/web/prelude.ts).
//   node scripts/check-dom-export.mjs <export-dir>
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDomExport, domPages, preludeNeedles } from './lib/dom-export.mjs'
import { loadPage, loadProblems } from './lib/dom-load.mjs'

async function main(argv) {
  const dir = argv[0]
  if (!dir) {
    console.error('usage: check-dom-export.mjs <export-dir>')
    return 2
  }
  const root = resolve(dir)
  const pages = domPages(root)
  if (pages.length === 0) {
    console.log('FAILED: no DOM page under www.bundle')
    return 1
  }
  for (const p of pages) {
    const bytes = p.scripts.reduce((n, s) => n + s.bytes, 0)
    console.log(`${p.name}: ${p.marker ?? 'unmarked'}, ${p.scripts.length} script(s), ${bytes} B`)
  }
  const needles = preludeNeedles()
  const problems = checkDomExport(root, needles)
  for (const p of pages) {
    if (p.scripts.length !== 1) continue
    const r = await loadPage(root, p)
    const found = loadProblems(p.name, r, needles)
    console.log(`${p.name}: loaded in jsdom, ${found.length ? 'FAIL' : 'ok'}`)
    problems.push(...found)
  }
  for (const m of problems) console.log(`FAIL ${m}`)
  console.log(problems.length ? 'FAILED' : 'ok')
  return problems.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
