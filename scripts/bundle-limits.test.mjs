// The budgets themselves (design 17.6): the Hermes limit is 7,000,000 bytes on both platforms (raised before M4),
// the DOM budgets are unchanged and growth past 5% per PR still fails.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const cfg = JSON.parse(readFileSync(new URL('../bundle-baseline.json', import.meta.url), 'utf8'))

test('the Hermes limit is 7,000,000 bytes and the DOM limits stay and the Option tools page has its own', () => {
  assert.deepEqual(cfg.limits, {
    android: 7000000,
    ios: 7000000,
    chartDom: 2330000,
    toolDom: 1900000,
    toolDomPages: { OptionToolsDom: 2200000 },
  })
})

test('growth above 5% per PR fails', () => {
  assert.equal(cfg.growth, 0.05)
})

test('export and every CI build carry the tree-shaking flags, and export clears the cache', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const exp = pkg.scripts.export
  assert.match(exp, /EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1/)
  assert.match(exp, /EXPO_UNSTABLE_TREE_SHAKING=1/)
  assert.match(exp, /node scripts\/export\.mjs/)
  // the script exports one platform at a time (two at once fail under tree shaking), cold first
  const script = readFileSync(new URL('./export.mjs', import.meta.url), 'utf8')
  assert.match(script, /expoExport\('android', out, \['--clear'\]\)/)
  assert.match(script, /expoExport\('ios', ios\)/)
  // workflow-level env reaches the Android and iOS build steps (composite actions included)
  const top = ci.split(/^jobs:/m)[0]
  assert.match(top, /^ {2}EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH: "1"$/m)
  assert.match(top, /^ {2}EXPO_UNSTABLE_TREE_SHAKING: "1"$/m)
  // the preview's DOM pages are the shipped ones: the same flags, cold, then the DOM export check
  const preview = readFileSync(new URL('../dev/preview/preview.sh', import.meta.url), 'utf8')
  const android = /^.*--platform android.*$/m.exec(preview.replace(/\\\n\s*/g, ' '))?.[0] ?? ''
  assert.match(android, /EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 EXPO_UNSTABLE_TREE_SHAKING=1/)
  assert.match(android, /expo export --clear --platform android/)
  assert.match(preview, /node scripts\/check-dom-export\.mjs "\$OUT\/android"/)
  // and CI checks the bytes it ships, after the export
  assert.match(
    ci,
    /run: npm run export\n[\s\S]*?run: node scripts\/check-dom-export\.mjs dist-export/,
  )
})
