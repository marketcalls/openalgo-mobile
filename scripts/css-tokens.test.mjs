import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildTokens, extractVars, tailwindColor, toHex } from './lib/css-tokens.mjs'

const themeCss = readFileSync('node_modules/tailwindcss/theme.css', 'utf8')

test('toHex converts oklch, hsl triplets and rejects lengths', () => {
  assert.equal(toHex('oklch(0.145 0 0)'), '#0a0a0a')
  assert.equal(toHex('oklch(1 0 0 / 10%)'), '#ffffff1a')
  assert.equal(toHex('oklch(0.7 0.2 280)'), '#8b8cff')
  assert.equal(toHex('217 91% 60%'), '#3c83f6')
  assert.equal(toHex('0.625rem'), null)
})

test('extractVars: unlayered beats @layer base, layered-only survives, data-theme ignored', () => {
  const css = `
    @layer base { :root { --background: 0 0% 100%; --buy: 217 91% 60%; } }
    :root { --background: oklch(0.5 0 0); }
    [data-theme="green"]:not(.analyzer) { --primary: red; }
    .dark { --background: oklch(0.1 0 0); }
    .analyzer { --ring: oklch(0.7 0.2 280); }
  `
  const v = extractVars(css)
  assert.equal(v.root.background, 'oklch(0.5 0 0)')
  assert.equal(v.root.buy, '217 91% 60%')
  assert.equal(v.root.primary, undefined)
  assert.equal(v.dark.background, 'oklch(0.1 0 0)')
  assert.equal(v.analyzer.ring, 'oklch(0.7 0.2 280)')
})

test('tailwindColor reads --color-<name> from the theme', () => {
  assert.match(tailwindColor(themeCss, 'green-600'), /^oklch\(/)
  assert.throws(() => tailwindColor(themeCss, 'nope-1'))
})

test('buildTokens', () => {
  const names = [
    'background',
    'foreground',
    'card',
    'card-foreground',
    'popover',
    'popover-foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'secondary-foreground',
    'muted',
    'muted-foreground',
    'accent',
    'accent-foreground',
    'destructive',
    'border',
    'input',
    'ring',
  ]
  const decls = (o = {}) => names.map((n) => `--${n}: ${o[n] ?? 'oklch(0.5 0 0)'};`).join(' ')
  const indexCss = `:root { ${decls({ background: 'oklch(1 0 0)' })} }
    .dark { ${decls({ background: 'oklch(0.145 0 0)', border: 'oklch(1 0 0 / 10%)' })} }
    .analyzer { ${decls()} }`
  const t = buildTokens({ indexCss, themeCss })
  assert.equal(t.dark.background, '#0a0a0a')
  assert.equal(t.dark.border, '#ffffff1a')
  assert.deepEqual(t.trade.light, {
    profit: '#00a63e',
    loss: '#e7000b',
    buy: '#00a63e',
    sell: '#e7000b',
    onBuy: '#ffffff',
    onSell: '#ffffff',
  })
  assert.deepEqual(t.trade.dark, {
    profit: '#05df72',
    loss: '#ff6467',
    buy: '#00a63e',
    sell: '#e7000b',
    onBuy: '#ffffff',
    onSell: '#ffffff',
  })
  assert.deepEqual(t.status, {
    light: { warning: '#fd9a00', onWarning: '#7b3306' },
    dark: { warning: '#7b3306', onWarning: '#fee685' },
  })
})
