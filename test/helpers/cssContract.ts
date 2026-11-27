// The phone stylesheets' selector contract (ux-bar T15-01, G19): every rule's `@pages` tag, and
// whether a selector matches anything on the page in the document. The rules are read from the
// files as written (comments carry the tags), so a rule can never lose its tag unseen.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TOOLS_DIR = join(__dirname, '../../src/dom/tools')
/** Every stylesheet an entry brings after tool.css (phone.css, then its family's own). */
export const ENTRY_CSS = {
  OptionToolsDom: ['phone.css', 'options.phone.css'],
  PortfolioToolsDom: ['phone.css', 'portfolio.phone.css'],
  SectorRotationDom: ['phone.css', 'rotation.phone.css'],
} as const
export type EntryName = keyof typeof ENTRY_CSS

export type ContractRule = {
  file: string
  /** The page ids of the tag, or ['none'] */
  pages: string[]
  /** The selector list, split at top-level commas. */
  selectors: string[]
}

export function splitList(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out.filter((s) => s !== '')
}

/** The style rules of a file in source order, each with the page tag written before it. */
export function contractRules(file: string): ContractRule[] {
  const css = readFileSync(join(TOOLS_DIR, file), 'utf8').replace(
    /\/\*(?!\s*@pages)[\s\S]*?\*\//g,
    '',
  )
  const out: ContractRule[] = []
  for (const m of css.matchAll(/(?:^|[{}])([^{}]*)\{/g)) {
    const prelude = m[1] ?? ''
    const bare = prelude.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (bare.startsWith('@')) continue
    const tag = /\/\*\s*@pages ([^*]+?)\s*\*\//.exec(prelude)
    out.push({
      file,
      pages: (tag?.[1] ?? '').split(/\s+/).filter(Boolean),
      selectors: splitList(bare),
    })
  }
  return out
}

/** Pseudo-elements and the states a still page never has style nothing to find. */
const toElement = (sel: string) => sel.replace(/::[a-z-]+/g, '')

/** The arguments of each `:has(...)` of a selector, for the part-by-part fallback. */
function hasArgs(sel: string): string[] {
  const out: string[] = []
  for (let at = sel.indexOf(':has('); at >= 0; at = sel.indexOf(':has(', at + 1)) {
    let depth = 0
    for (let i = at + 4; i < sel.length; i++) {
      if (sel[i] === '(') depth++
      if (sel[i] === ')' && --depth === 0) {
        out.push(sel.slice(at + 5, i))
        break
      }
    }
  }
  return out
}

/**
 * Whether the selector matches at least one element of `doc`. The engine (nwsapi) answers the whole
 * selector; one it cannot parse is checked part by part, each `:has` argument relative to the document
 * (a `>` leads: the child combinator is applied to whatever holds the rest).
 */
export function matches(doc: Document, selector: string): boolean {
  const sel = toElement(selector)
  try {
    return doc.querySelector(sel) !== null
  } catch {
    for (const arg of hasArgs(sel)) {
      const plain = arg.replace(/^\s*>\s*/, '')
      try {
        if (doc.querySelector(plain) === null) return false
      } catch {
        return false
      }
    }
    return hasArgs(sel).length > 0
  }
}

/** The rules of the entry's stylesheets that name `page`, in source order. */
export function rulesFor(entry: EntryName, page: string): ContractRule[] {
  return ENTRY_CSS[entry].flatMap(contractRules).filter((r) => r.pages.includes(page))
}

/** The stylesheets' text, to inject. */
export const cssText = (entry: EntryName) =>
  ENTRY_CSS[entry].map((f) => readFileSync(join(TOOLS_DIR, f), 'utf8')).join('\n')
