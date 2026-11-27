// Pure helpers that turn the pinned web's tool list, supported-exchanges hook and broker plugins
// into the generated registries. Parsing is by pattern, so a layout change fails loudly.
import { tailwindColor, toHex } from './css-tokens.mjs'

const STR = String.raw`(['"])((?:\\.|(?!\1)[^\\\n])*)\1`
const unquote = (s) => s.replace(/\\(.)/g, '$1')

function stringsOf(src, key) {
  return [...src.matchAll(new RegExp(String.raw`\b${key}:\s*${STR}`, 'g'))].map((m) =>
    unquote(m[2]),
  )
}

// The tool objects of lib/tools.ts. The `href: string` field of the interface is no value, so
// only string-literal values count (the 20 tools).
export function parseTools(src, themeCss) {
  const hrefs = stringsOf(src, 'href')
  if (hrefs.length === 0) throw new Error('tools.ts: no tools found')
  const cols = {}
  for (const key of ['title', 'description', 'color']) {
    cols[key] = stringsOf(src, key)
    if (cols[key].length !== hrefs.length) {
      throw new Error(
        `tools.ts: ${cols[key].length} ${key} values for ${hrefs.length} href values: the layout changed`,
      )
    }
  }
  const ids = hrefs.map((h) => h.replace(/^\//, '').replace(/\//g, '-'))
  if (new Set(ids).size !== ids.length) throw new Error('tools.ts: duplicate tool ids')
  return hrefs.map((_, i) => {
    const m = /^bg-([a-z]+-\d+)$/.exec(cols.color[i])
    if (!m) throw new Error(`tools.ts: colour "${cols.color[i]}" is not bg-<colour>-<shade>`)
    const color = toHex(tailwindColor(themeCss, m[1]))
    if (!color) throw new Error(`tools.ts: cannot resolve ${cols.color[i]}`)
    const title = cols.title[i]
    // as Tools.tsx draws the tile: the first character of each space-separated word
    const initials = title
      .split(' ')
      .map((w) => w[0])
      .join('')
    return { id: ids[i], title, description: cols.description[i], color, initials }
  })
}

const listOf = (body) => [...body.matchAll(new RegExp(STR, 'g'))].map((m) => unquote(m[2]))

// hooks/useSupportedExchanges.ts: the default underlyings per F&O exchange and the fallback list.
export function parseExchanges(src) {
  const u = /\bUNDERLYINGS\b[^=]*=\s*\{([^}]*)\}/.exec(src)
  if (!u) throw new Error('useSupportedExchanges.ts: UNDERLYINGS not found')
  const underlyings = {}
  for (const m of u[1].matchAll(/([A-Z_]+):\s*\[([^\]]*)\]/g)) underlyings[m[1]] = listOf(m[2])
  if (Object.keys(underlyings).length === 0) {
    throw new Error('useSupportedExchanges.ts: UNDERLYINGS has no entries')
  }
  const f = /\bFALLBACK_EXCHANGES\b[^=]*=\s*\[([^\]]*)\]/.exec(src)
  if (!f) throw new Error('useSupportedExchanges.ts: FALLBACK_EXCHANGES not found')
  const fallback = listOf(f[1])
  if (fallback.length === 0)
    throw new Error('useSupportedExchanges.ts: FALLBACK_EXCHANGES is empty')
  return { underlyings, fallback }
}

// broker/<name>/plugin.json for each broker folder (python package files, __pycache__ and dot folders are skipped; underscores are kept: dhan_sandbox).
export function parseBrokers(names, readPlugin) {
  const out = {}
  for (const name of names.filter((n) => /^[a-z][a-z0-9_]*$/.test(n))) {
    const j = JSON.parse(readPlugin(name))
    if (!Array.isArray(j.supported_exchanges) || j.supported_exchanges.length === 0) {
      throw new Error(`broker/${name}/plugin.json: supported_exchanges is missing`)
    }
    if (j.broker_type !== 'IN_stock' && j.broker_type !== 'crypto') {
      throw new Error(`broker/${name}/plugin.json: broker_type "${j.broker_type}" is unknown`)
    }
    out[name] = {
      type: j.broker_type,
      exchanges: j.supported_exchanges,
      leverage: j.leverage_config === true,
    }
  }
  return out
}

const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const arr = (a) => `[${a.map(q).join(', ')}]`

export function renderToolsRegistry({ tools, underlyings, fallback, ref }) {
  const rows = tools
    .map(
      (t) =>
        `  {\n    id: ${q(t.id)},\n    title: ${q(t.title)},\n    description: ${q(t.description)},\n    color: ${q(t.color)},\n    initials: ${q(t.initials)},\n  },`,
    )
    .join('\n')
  const unders = Object.entries(underlyings)
    .map(([k, v]) => `  ${k}: ${arr(v)},`)
    .join('\n')
  return `// GENERATED from openalgo ${ref} (frontend/src/lib/tools.ts and hooks/useSupportedExchanges.ts) by scripts/gen-frontend.mjs. Do not edit.
export type ToolEntry = {
  id: string
  title: string
  description: string
  color: string
  initials: string
}

export const TOOLS: readonly ToolEntry[] = [
${rows}
]

export const DEFAULT_UNDERLYINGS: Readonly<Record<string, readonly string[]>> = {
${unders}
}

export const FALLBACK_EXCHANGES: readonly string[] = ${arr(fallback)}
`
}

export function renderBrokersRegistry({ brokers, ref }) {
  const rows = Object.entries(brokers)
    .map(
      ([n, b]) =>
        `  ${n}: {\n    type: ${q(b.type)},\n    exchanges: ${arr(b.exchanges)},\n    leverage: ${b.leverage},\n  },`,
    )
    .join('\n')
  return `// GENERATED from openalgo ${ref} (broker/*/plugin.json) by scripts/gen-frontend.mjs. Do not edit.
export const BROKERS: Readonly<
  Record<string, { type: 'IN_stock' | 'crypto'; exchanges: readonly string[]; leverage: boolean }>
> = {
${rows}
}
`
}
