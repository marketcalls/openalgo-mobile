import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const run = (args) =>
  spawnSync('npx', ['depcruise', ...args, '--config', '.dependency-cruiser.cjs'], {
    encoding: 'utf8',
  })

const ERROR_RULES = [
  'no-cross-feature',
  'core-no-features',
  'dom-content-no-secrets',
  'dom-content-no-secrets-reachable',
  'features-dom-bridge-only',
  'core-logic-pure',
  'market-no-features',
  'no-unresolvable',
]

test('the fixtures violate every error rule', () => {
  const r = run([
    'test/fixtures/boundaries/src',
    '--ts-config',
    'test/fixtures/boundaries/tsconfig.json',
    '--output-type',
    'err',
  ])
  const out = r.stdout + r.stderr
  assert.notEqual(r.status, 0)
  for (const rule of ERROR_RULES) assert.match(out, new RegExp(rule), `missing ${rule}`)
})

test('an aliased import is caught by dom-content-no-secrets', () => {
  const r = run([
    'test/fixtures/boundaries/src',
    '--ts-config',
    'test/fixtures/boundaries/tsconfig.json',
    '--output-type',
    'json',
  ])
  const violations = JSON.parse(r.stdout).summary.violations
  const hit = violations.filter(
    (v) => v.rule.name === 'dom-content-no-secrets' && v.from.endsWith('dom/chart/alias.ts'),
  )
  assert.equal(hit.length, 1)
})

test('WebView content cannot reach the key through another module (design 7.4)', () => {
  const r = run([
    'test/fixtures/boundaries/src',
    '--ts-config',
    'test/fixtures/boundaries/tsconfig.json',
    '--output-type',
    'json',
  ])
  const violations = JSON.parse(r.stdout).summary.violations
  const from = (rule, file) =>
    violations.filter((v) => v.rule.name === rule && v.from.endsWith(file))
  // dom/chart -> core/services -> core/credentials: no direct import, so only the chain rule
  const hits = from('dom-content-no-secrets-reachable', 'dom/chart/indirect.ts')
  assert.ok(hits.some((v) => v.to.endsWith('core/credentials/keyStore.ts')))
  assert.equal(from('dom-content-no-secrets', 'dom/chart/indirect.ts').length, 0)
  // pure logic that leads to none of them stays allowed
  assert.equal(
    violations.filter((v) => v.from.endsWith('dom/tools/pure.ts')).length,
    0,
    JSON.stringify(violations.map((v) => [v.rule.name, v.from, v.to])),
  )
})

test('the real src passes', () => {
  const r = run(['src'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
