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

const ERROR_RULES = [
  'no-cross-feature',
  'core-no-features',
  'dom-content-allowlist',
  'dom-content-no-native-packages',
  'dom-content-no-secrets',
  'dom-content-no-secrets-reachable',
  'dom-entries-only',
  'dom-no-dynamic-import',
  'features-dom-bridge-only',
  'core-logic-pure',
  'market-no-features',
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

test('a dynamic import in DOM content fails', () => {
  assert.deepEqual(rulesFrom('dom/chart/lazy.ts'), ['dom-no-dynamic-import'])
})

test('native code imports only the DOM entry', () => {
  assert.deepEqual(rulesFrom('market/uses-dom-glue.ts'), ['dom-entries-only'])
})

test('the real src passes', () => {
  const r = run(['src'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
