import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const run = (args) =>
  spawnSync('npx', ['depcruise', ...args, '--config', '.dependency-cruiser.cjs'], {
    encoding: 'utf8',
  })

const SIX = [
  'no-cross-feature',
  'core-no-features',
  'dom-content-no-secrets',
  'features-dom-bridge-only',
  'core-logic-pure',
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
  for (const rule of SIX) assert.match(out, new RegExp(rule), `missing ${rule}`)
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

test('the real src passes', () => {
  const r = run(['src'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
