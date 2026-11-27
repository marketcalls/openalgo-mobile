// Writes <dir>/www.bundle/entries.json: the 'use dom' entry (its path from the project root, the
// `entry` DomHost passes) → its exported html. expo names each html by the md5 of its content, so
// an entry is recognised by a literal its JS holds: `oa-entry:<path>` (one per entry, proposed for
// plan E T11), or the chart's existing marker. Beside each page it writes <md5>.frame.html, the
// same page with the bridge boot first, which webEntry.web.tsx loads as the iframe's src (a
// srcdoc page's location is about:srcdoc, which axios cannot resolve a relative URL against).
//   node dom-manifest.mjs <export dir with www.bundle/>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const KNOWN = { 'oa-dom:chart': 'src/dom/chart/ChartDom.tsx' }
const ENTRY = /oa-entry:([A-Za-z0-9_./-]+\.tsx)/g

const dir = join(process.argv[2] ?? '.', 'www.bundle')
const out = {}
for (const html of readdirSync(dir).filter(
  (f) => f.endsWith('.html') && !f.endsWith('.frame.html'),
)) {
  const page = readFileSync(join(dir, html), 'utf8')
  const scripts = [...page.matchAll(/<script\b[^>]*\bsrc="\.\/([^"]+)"/g)].map((m) => m[1])
  for (const s of scripts) {
    const js = readFileSync(join(dir, s), 'utf8')
    const names = new Set([...js.matchAll(ENTRY)].map((m) => m[1]))
    for (const [marker, entry] of Object.entries(KNOWN)) if (js.includes(marker)) names.add(entry)
    for (const name of names) {
      if (out[name] && out[name] !== html) throw new Error(`${name}: both ${out[name]} and ${html}`)
      out[name] = html
    }
  }
}
/** The bridge boot: the host's frame, by the id in the query (webEntry.web.tsx FRAME_PARAM). */
const BOOT =
  '<script>window.ReactNativeWebView=parent.__oaDomFrames[new URLSearchParams(location.search).get("oaframe")];</script>'
for (const html of new Set(Object.values(out))) {
  const page = readFileSync(join(dir, html), 'utf8')
  if (!/<head>/i.test(page)) throw new Error(`${html}: no <head>`)
  writeFileSync(
    join(dir, html.replace(/\.html$/, '.frame.html')),
    page.replace(/<head>/i, `<head>${BOOT}`),
  )
}
writeFileSync(join(dir, 'entries.json'), `${JSON.stringify(out, null, 2)}\n`)
console.log(JSON.stringify(out, null, 2))
