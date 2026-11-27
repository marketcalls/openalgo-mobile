// The DOM components `expo export` writes under `<dir>/www.bundle/`: one html page each, with
// its JS and CSS. The chart and the tool pages are told apart by a literal each page's JS holds.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const DOM_MARKERS = { chartDom: 'oa-dom:chart', toolDom: 'oa-dom:tool' }

const WWW = 'www.bundle'
const WEB_CHUNK = '_expo/static/js/web/'

const assets = (html, re) => [...html.matchAll(re)].map((m) => m[1])
const SCRIPT_SRC = /<script\b[^>]*\bsrc="([^"]+)"/g
const STYLE_HREF = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g

function sized(base, ref) {
  const file = ref.replace(/^\.\//, '')
  const path = join(base, file)
  return { file, bytes: existsSync(path) ? statSync(path).size : 0 }
}

function markerOf(base, scripts) {
  for (const s of scripts) {
    const path = join(base, s.file)
    if (!existsSync(path)) continue
    const js = readFileSync(path, 'utf8')
    for (const [name, literal] of Object.entries(DOM_MARKERS)) {
      if (js.includes(literal)) return name
    }
  }
  return null
}

const ENTRY = /oa-entry:src\/dom\/tools\/([A-Za-z0-9_]+)\.tsx/

/** The tool entry a page holds (`oa-entry:src/dom/tools/<Entry>.tsx`), by its component name. */
function entryOf(base, scripts) {
  for (const s of scripts) {
    const path = join(base, s.file)
    if (!existsSync(path)) continue
    const m = ENTRY.exec(readFileSync(path, 'utf8'))
    if (m) return m[1]
  }
  return null
}

/** Every *.html page under `<dir>/www.bundle`: its scripts and styles (file, bytes), its marker and its tool entry name. */
export function domPages(dir) {
  const base = join(dir, WWW)
  if (!existsSync(base)) return []
  return readdirSync(base)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((name) => {
      const html = readFileSync(join(base, name), 'utf8')
      const scripts = assets(html, SCRIPT_SRC).map((r) => sized(base, r))
      const styles = assets(html, STYLE_HREF).map((r) => sized(base, r))
      return {
        name,
        html,
        scripts,
        styles,
        marker: markerOf(base, scripts),
        entry: entryOf(base, scripts),
      }
    })
}

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
}

/** Problems that would break a DOM page on the device: it loads from file://, so it must be one
 *  self-contained script. `__loadBundleAsync` is not one: every DOM bundle sets it. */
export function checkDomExport(dir) {
  const problems = []
  const base = join(dir, WWW)
  for (const p of domPages(dir)) {
    if (p.scripts.length !== 1) {
      problems.push(`${p.name}: ${p.scripts.length} scripts, expected exactly 1`)
    }
    for (const s of p.scripts) {
      const path = join(base, s.file)
      if (existsSync(path) && readFileSync(path, 'utf8').includes(WEB_CHUNK)) {
        problems.push(
          `${p.name}: ${s.file} names a ${WEB_CHUNK} chunk, which a file:// page cannot load`,
        )
      }
    }
  }
  for (const f of walk(base)) {
    if (f.split('/').pop().includes('__common')) {
      problems.push(`${f.slice(base.length + 1)}: a __common chunk in the DOM export`)
    }
  }
  return problems
}
