// Pure helpers that turn the web app's CSS variables into hex colour tokens.
import { formatHex, formatHex8, parse, toGamut } from 'culori'
import postcss from 'postcss'

const toRgb = toGamut('rgb')

// Accepts any CSS colour, or a shadcn "H S% L%" triplet. Returns #rrggbb(aa), or null.
export function toHex(value) {
  const v = value.trim()
  const css = /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(v) ? `hsl(${v})` : v
  const color = parse(css)
  if (!color) return null
  const rgb = toRgb(color)
  return (rgb.alpha ?? 1) < 1 ? formatHex8(rgb) : formatHex(rgb)
}

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
const SELECTORS = { ':root': 'root', '.dark': 'dark', '.analyzer': 'analyzer' }

function inLayer(node) {
  for (let p = node.parent; p; p = p.parent)
    if (p.type === 'atrule' && p.name === 'layer') return true
  return false
}

// Reads :root, .dark and .analyzer. Unlayered rules beat @layer rules; within a tier the later
// rule wins. Other selectors (e.g. [data-theme=...]) are ignored.
export function extractVars(css) {
  const tiers = { layered: {}, unlayered: {} }
  for (const k of Object.keys(tiers)) for (const g of Object.values(SELECTORS)) tiers[k][g] = {}
  postcss.parse(css).walkRules((rule) => {
    if (rule.selectors.length !== 1) return
    const group = SELECTORS[rule.selector.trim()]
    if (!group) return
    const tier = tiers[inLayer(rule) ? 'layered' : 'unlayered'][group]
    rule.walkDecls(/^--/, (d) => {
      tier[camel(d.prop.slice(2))] = d.value.trim()
    })
  })
  const out = {}
  for (const g of Object.values(SELECTORS)) out[g] = { ...tiers.layered[g], ...tiers.unlayered[g] }
  return out
}

export function tailwindColor(themeCss, name) {
  let found
  postcss.parse(themeCss).walkDecls(`--color-${name}`, (d) => {
    found = d.value.trim()
  })
  if (!found) throw new Error(`tailwind colour ${name} not found in theme.css`)
  return found
}

const PALETTE_KEYS = [
  'background',
  'foreground',
  'card',
  'cardForeground',
  'popover',
  'popoverForeground',
  'primary',
  'primaryForeground',
  'secondary',
  'secondaryForeground',
  'muted',
  'mutedForeground',
  'accent',
  'accentForeground',
  'destructive',
  'border',
  'input',
  'ring',
]

// Web trading colours are Tailwind classes, not CSS variables:
//   BUY  bg-green-600  frontend/src/components/trading/PlaceOrderDialog.tsx:425,634
//   SELL bg-red-600    frontend/src/components/trading/PlaceOrderDialog.tsx:433,635
//   P&L  text green-600 / red-600 in light mode, 400 shades in dark mode
const TRADE_MAP = {
  light: { profit: 'green-600', loss: 'red-600', buy: 'green-600', sell: 'red-600' },
  dark: { profit: 'green-400', loss: 'red-400', buy: 'green-600', sell: 'red-600' },
}

function palette(vars) {
  const p = {}
  for (const k of PALETTE_KEYS) {
    const raw = vars[k]
    const hex = raw === undefined ? null : toHex(raw)
    if (!hex) throw new Error(`cannot resolve colour --${k}: ${raw}`)
    p[k] = hex
  }
  return p
}

export function buildTokens({ indexCss, themeCss }) {
  const v = extractVars(indexCss)
  const dark = { ...v.root, ...v.dark }
  const trade = (map) => {
    const out = {}
    for (const [k, name] of Object.entries(map)) out[k] = toHex(tailwindColor(themeCss, name))
    return { ...out, onBuy: '#ffffff', onSell: '#ffffff' }
  }
  return {
    light: palette(v.root),
    dark: palette(dark),
    analyzer: palette({ ...dark, ...v.analyzer }),
    trade: { light: trade(TRADE_MAP.light), dark: trade(TRADE_MAP.dark) },
  }
}

export function renderTokensTs(tokens, ref) {
  const body = JSON.stringify(tokens, null, 2)
    .replace(/"([A-Za-z]+)":/g, '$1:')
    .replace(/"/g, "'")
  return `// GENERATED from openalgo ${ref} (frontend/src/index.css) by scripts/gen-tokens.mjs. Do not edit.
export const tokens = ${body} as const

export type Palette = typeof tokens.light
export type TradePalette = typeof tokens.trade.light
`
}
