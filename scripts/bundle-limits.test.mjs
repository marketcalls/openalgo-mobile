// The budgets themselves (design 17.6): the Hermes limit is 7,000,000 bytes on both platforms (raised before M4),
// the DOM budgets are unchanged and growth past 5% per PR still fails.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const cfg = JSON.parse(readFileSync(new URL('../bundle-baseline.json', import.meta.url), 'utf8'))

test('the Hermes limit is 7,000,000 bytes and the DOM limits stay', () => {
  assert.deepEqual(cfg.limits, {
    android: 7000000,
    ios: 7000000,
    chartDom: 2330000,
    toolDom: 1900000,
  })
})

test('growth above 5% per PR fails', () => {
  assert.equal(cfg.growth, 0.05)
})
