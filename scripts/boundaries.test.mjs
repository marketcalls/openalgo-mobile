import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const run = (args) =>
  spawnSync('npx', ['depcruise', ...args, '--config', '.dependency-cruiser.cjs'], {
    encoding: 'utf8',
  })

const runFixtures = (outputType) =>
  run([
    'test/fixtures/boundaries/src',
    '--ts-config',
    'test/fixtures/boundaries/tsconfig.json',
    '--output-type',
    outputType,
  ])

let fixtureViolations
const violations = () => {
  fixtureViolations ??= JSON.parse(runFixtures('json').stdout).summary.violations
  return fixtureViolations
}
// The distinct rules a fixture file breaks, sorted.
const rulesFrom = (file) =>
  [
    ...new Set(
      violations()
        .filter((v) => v.from.endsWith(file))
        .map((v) => v.rule.name),
    ),
  ].sort()
// What a fixture file's breaches of one rule point at (resolved paths).
const targets = (rule, file) =>
  violations()
    .filter((v) => v.rule.name === rule && v.from.endsWith(file))
    .map((v) => v.to)

const ERROR_RULES = [
  'no-cross-feature',
  'core-no-features',
  'dom-content-allowlist',
  'dom-content-no-native-packages',
  'dom-content-no-secrets',
  'dom-content-no-secrets-reachable',
  'dom-entries-only',
  'dom-no-dynamic-import',
  'dom-protocol-no-runtime-imports',
  'ui-tokens-no-runtime-imports',
  'features-dom-bridge-only',
  'core-logic-pure',
  'market-no-features',
  'frontend-runtime-in-dom-tools',
  'frontend-types-in-routes',
  'no-unresolvable',
]

test('the fixtures violate every error rule', () => {
  const r = runFixtures('err')
  const out = r.stdout + r.stderr
  assert.notEqual(r.status, 0)
  for (const rule of ERROR_RULES) assert.match(out, new RegExp(rule), `missing ${rule}`)
})

test('an aliased import is caught by dom-content-no-secrets', () => {
  const hit = violations().filter(
    (v) => v.rule.name === 'dom-content-no-secrets' && v.from.endsWith('dom/chart/alias.ts'),
  )
  assert.equal(hit.length, 1)
})

test('WebView content cannot reach the key through another module (design 7.4)', () => {
  const from = (rule, file) =>
    violations().filter((v) => v.rule.name === rule && v.from.endsWith(file))
  // dom/chart -> core/services -> core/credentials: no direct import, so only the chain rule
  const hits = from('dom-content-no-secrets-reachable', 'dom/chart/indirect.ts')
  assert.ok(hits.some((v) => v.to.endsWith('core/credentials/keyStore.ts')))
  assert.equal(from('dom-content-no-secrets', 'dom/chart/indirect.ts').length, 0)
  // core/realtime (the socket) and core/config (the server) are off limits too, dom/web included
  assert.deepEqual(rulesFrom('dom/tools/pure.ts'), [
    'dom-content-allowlist',
    'dom-content-no-secrets',
    'dom-content-no-secrets-reachable',
  ])
  assert.deepEqual(rulesFrom('dom/web/leak.ts'), [
    'dom-content-allowlist',
    'dom-content-no-secrets',
    'dom-content-no-secrets-reachable',
  ])
  // content that leads to none of them stays allowed
  assert.deepEqual(
    rulesFrom('dom/chart/ok.ts'),
    [],
    JSON.stringify(violations().map((v) => [v.rule.name, v.from, v.to])),
  )
})

test('a feature may render a DOM entry and use the gateway, nothing else under dom/', () => {
  assert.deepEqual(rulesFrom('features/b/uses-entry.ts'), [])
  assert.deepEqual(rulesFrom('features/a/dom.ts'), [])
  assert.deepEqual(rulesFrom('features/a/uses-dom-internal.ts'), [
    'dom-entries-only',
    'features-dom-bridge-only',
  ])
})

test('DOM content imports only its own folder, dom/web, the protocol and the tokens', () => {
  assert.deepEqual(rulesFrom('dom/chart/ok.ts'), [])
  assert.deepEqual(rulesFrom('dom/chart/ChartDom.tsx'), [])
  assert.deepEqual(rulesFrom('dom/web/env.ts'), [])
  assert.deepEqual(rulesFrom('dom/chart/uses-market.ts'), ['dom-content-allowlist'])
  assert.deepEqual(rulesFrom('dom/chart/uses-tools.ts'), ['dom-content-allowlist'])
  assert.deepEqual(rulesFrom('dom/web/bad-native.ts'), ['dom-content-no-native-packages'])
})

test('DOM content refuses React Native and Expo packages whatever their name, expo/dom aside', () => {
  const refused = {
    'dom/web/bad-native.ts': 'node_modules/react-native/',
    'dom/web/uses-rn-library.ts': 'node_modules/react-native-safe-area-context/',
    'dom/chart/uses-expo-scoped.ts': 'node_modules/@expo/metro-runtime/',
    // named for neither: refused because its package.json needs react-native
    'dom/tools/uses-flash-list.ts': 'node_modules/@shopify/flash-list/',
    'dom/chart/uses-expo-root.ts': 'node_modules/expo/',
  }
  for (const [file, pkg] of Object.entries(refused)) {
    assert.deepEqual(rulesFrom(file), ['dom-content-no-native-packages'], file)
    const to = targets('dom-content-no-native-packages', file)
    assert.equal(to.length, 1, `${file}: ${to}`)
    assert.ok(to[0].includes(pkg), `${file} -> ${to[0]}`)
  }
  // the DOM page's own API stays allowed: ok.ts imports expo/dom and expo/dom/global
  assert.deepEqual(rulesFrom('dom/chart/ok.ts'), [])
})

test('the protocol and the tokens import nothing at run time, so they carry nothing into a page', () => {
  // ok.ts imports both and stays clean: the DOM rules check only a page file's own imports
  assert.deepEqual(rulesFrom('dom/chart/ok.ts'), [])
  assert.deepEqual(rulesFrom('dom/bridge/protocol.ts'), ['dom-protocol-no-runtime-imports'])
  const fromProtocol = targets('dom-protocol-no-runtime-imports', 'dom/bridge/protocol.ts')
  assert.equal(fromProtocol.length, 2, String(fromProtocol))
  assert.ok(fromProtocol.some((to) => to.includes('node_modules/zod/')))
  assert.ok(fromProtocol.some((to) => to.endsWith('src/market/x.ts')))
  // its import type of expo/dom is erased by the compiler, so it is not refused
  assert.ok(!fromProtocol.some((to) => to.includes('node_modules/expo/')))
  assert.deepEqual(rulesFrom('ui/tokens.ts'), ['ui-tokens-no-runtime-imports'])
  const fromTokens = targets('ui-tokens-no-runtime-imports', 'ui/tokens.ts')
  assert.equal(fromTokens.length, 1, String(fromTokens))
  assert.ok(fromTokens[0].includes('node_modules/react-native/'))
})

test('a dynamic import in DOM content fails', () => {
  assert.deepEqual(rulesFrom('dom/chart/lazy.ts'), ['dom-no-dynamic-import'])
})

test('native code imports only the DOM entry', () => {
  assert.deepEqual(rulesFrom('market/uses-dom-glue.ts'), ['dom-entries-only'])
})

test('only dom/tools imports frontend runtime code; market/options may import lib/optionGreeks', () => {
  assert.deepEqual(rulesFrom('market/uses-page.ts'), ['frontend-runtime-in-dom-tools'])
  assert.deepEqual(rulesFrom('features/z/uses-page.ts'), ['frontend-runtime-in-dom-tools'])
  assert.deepEqual(rulesFrom('market/options/uses-page.ts'), ['frontend-runtime-in-dom-tools'])
  // @/ resolves into the fixture frontend, and a tool page may run it
  assert.deepEqual(targets('frontend-runtime-in-dom-tools', 'market/uses-page.ts'), [
    'test/fixtures/boundaries/openalgo/frontend/src/pages/X.tsx',
  ])
  assert.deepEqual(rulesFrom('dom/tools/uses-page.ts'), [])
  assert.deepEqual(rulesFrom('market/options/uses-greeks.ts'), [])
})

test('dom/routes imports frontend types only', () => {
  assert.deepEqual(rulesFrom('dom/routes/types-only.ts'), [])
  // a runtime import is frontend runtime code outside dom/tools as well
  assert.deepEqual(rulesFrom('dom/routes/runtime-api.ts'), [
    'frontend-runtime-in-dom-tools',
    'frontend-types-in-routes',
  ])
})

test('the real src passes', () => {
  const r = run(['src'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
