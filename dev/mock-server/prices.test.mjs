import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPriceBook, step, tickData } from './prices.mjs'

/** A book on a hand-moved clock. */
function book() {
  const clock = { t: 1_000_000 }
  return { clock, prices: createPriceBook({ now: () => clock.t }) }
}

test('the first read is the seed, so a multiquotes seed agrees with the first tick', () => {
  const { prices } = book()
  const seeded = prices.get('RELIANCE', 'NSE').ltp
  assert.equal(prices.read('RELIANCE', 'NSE').ltp, seeded)
})

test('REST reads walk the price at most once a second, so polling sees it move with no socket', () => {
  const { clock, prices } = book()
  const st = prices.read('RELIANCE', 'NSE')
  const vol = st.volume
  clock.t += 999
  prices.read('RELIANCE', 'NSE')
  assert.equal(st.volume, vol, 'no step within the second')
  const seen = new Set()
  for (let i = 0; i < 20; i++) {
    clock.t += 1000
    seen.add(prices.read('RELIANCE', 'NSE').ltp)
  }
  assert.ok(st.volume > vol)
  assert.ok(seen.size > 1, 'the price moved')
})

test('a WS tick counts as the step, so REST reads do not walk a symbol that is streaming', () => {
  const { clock, prices } = book()
  const st = prices.read('RELIANCE', 'NSE')
  clock.t += 5000
  step(st, clock.t) // the feed's ticker
  const after = st.volume
  clock.t += 500
  prices.read('RELIANCE', 'NSE')
  assert.equal(st.volume, after)
})

test('quote and depth ticks carry the quantity the last step traded; ltt stays epoch seconds', () => {
  const { clock, prices } = book()
  const st = prices.get('RELIANCE', 'NSE')
  const before = st.volume
  clock.t += 1000
  step(st, clock.t)
  const traded = st.volume - before
  assert.ok(traded >= 1)
  for (const mode of [2, 3]) {
    const data = tickData(st, mode, 5)
    assert.equal(data.last_quantity, traded, `mode ${mode}`)
    assert.ok(Number.isInteger(data.ltt) && data.ltt < 1e12, `mode ${mode}: ltt in seconds`)
  }
  assert.deepEqual(Object.keys(tickData(st, 1, 0)).sort(), ['ltp', 'ltt'])
})
