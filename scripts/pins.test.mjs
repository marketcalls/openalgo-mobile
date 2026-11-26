import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { OPENALGO_CHARTS } from './lib/pins.mjs'

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
const pkg = read('package.json')
const lock = read('package-lock.json')

test('openalgo-charts is pinned exactly to the frontend version', () => {
  assert.equal(OPENALGO_CHARTS, '2.7.3')
  assert.equal(pkg.dependencies['openalgo-charts'], OPENALGO_CHARTS)
  assert.equal(lock.packages['node_modules/openalgo-charts'].version, OPENALGO_CHARTS)
})
