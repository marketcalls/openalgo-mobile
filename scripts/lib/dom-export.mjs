// The DOM components `expo export` writes under `<dir>/www.bundle/`: one html page each, with
// its JS and CSS. The chart and the tool pages are told apart by a literal each page's JS holds.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** What the prelude puts in every page (design 7.7), read from the app's own source: the release
 *  policy (src/dom/web/csp.ts DOM_CSP) and the prelude's literal (src/dom/web/prelude.ts). */
export function preludeNeedles(root = APP_ROOT) {
  const csp = readFileSync(join(root, 'src/dom/web/csp.ts'), 'utf8')
  const decl = /export const DOM_CSP =([\s\S]*?)\n\n/.exec(csp)
  if (!decl) throw new Error('src/dom/web/csp.ts: no DOM_CSP declaration')
  const policy = [...decl[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('')
  const prelude = /export const PRELUDE = '([^']+)'/.exec(
    readFileSync(join(root, 'src/dom/web/prelude.ts'), 'utf8'),
  )
  if (!prelude) throw new Error('src/dom/web/prelude.ts: no PRELUDE literal')
  return { policy, prelude: prelude[1] }
}

/** The import.meta.env seed (src/dom/web/env.ts VITE_ENV): the frontend's api/client reads
 *  `import.meta.env.VITE_API_URL` while it first evaluates, so a page without it throws at load. */
const ENV_SEED = /VITE_API_URL:\s*(?:''|"")/

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
 *  self-contained script. `__loadBundleAsync` is not one: every DOM bundle sets it. The bytes that
 *  ship must also hold what the prelude does: the release CSP, the env seed and the prelude's own
 *  literal (a tree-shaken export once dropped the prelude from every page; prelude.ts). */
export function checkDomExport(dir, needles = preludeNeedles()) {
  const problems = []
  const base = join(dir, WWW)
  for (const p of domPages(dir)) {
    if (p.scripts.length !== 1) {
      problems.push(`${p.name}: ${p.scripts.length} scripts, expected exactly 1`)
    }
    let js = ''
    for (const s of p.scripts) {
      const path = join(base, s.file)
      if (!existsSync(path)) continue
      const text = readFileSync(path, 'utf8')
      js += text
      if (text.includes(WEB_CHUNK)) {
        problems.push(
          `${p.name}: ${s.file} names a ${WEB_CHUNK} chunk, which a file:// page cannot load`,
        )
      }
    }
    if (p.scripts.length === 0) continue
    if (!js.includes(needles.policy)) {
      problems.push(`${p.name}: its JS holds no release Content-Security-Policy (DOM_CSP)`)
    }
    if (!ENV_SEED.test(js)) {
      problems.push(`${p.name}: its JS holds no import.meta.env seed (VITE_ENV)`)
    }
    if (!js.includes(needles.prelude)) {
      problems.push(`${p.name}: its JS holds no prelude (${needles.prelude})`)
    }
  }
  for (const f of walk(base)) {
    if (f.split('/').pop().includes('__common')) {
      problems.push(`${f.slice(base.length + 1)}: a __common chunk in the DOM export`)
    }
  }
  return problems
}
