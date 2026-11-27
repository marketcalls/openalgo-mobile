// Fails when the exported DOM pages are not one self-contained script each.
//   node scripts/check-dom-export.mjs <export-dir>
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDomExport, domPages } from './lib/dom-export.mjs'

function main(argv) {
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
  const problems = checkDomExport(root)
  for (const m of problems) console.log(`FAIL ${m}`)
  console.log(problems.length ? 'FAILED' : 'ok')
  return problems.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
