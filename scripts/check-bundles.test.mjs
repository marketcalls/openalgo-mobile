import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compare, measure } from './check-bundles.mjs'

const limits = { android: 4340000, ios: 4340000, chartDom: 2330000, toolDom: 1900000 }
const cfg = (baseline, extra = {}) => ({ growth: 0.05, limits, baseline, ...extra })
const base = { android: 1000, ios: 1000, chartDom: null, toolDom: null }

test('1050 against a baseline of 1000 passes', () => {
  const r = compare({ android: 1050, ios: 1000 }, cfg(base))
  assert.equal(r.ok, true)
})

test('1051 fails and names the growth', () => {
  const r = compare({ android: 1051, ios: 1000 }, cfg(base))
  assert.equal(r.ok, false)
  assert.match(r.lines.join('\n'), /android \+5\.1%/)
})

test('over the absolute limit fails', () => {
  const r = compare({ android: 4340001, ios: 1000 }, cfg({ ...base, android: 4340000 }))
  assert.equal(r.ok, false)
  assert.match(r.lines.join('\n'), /android/)
})

test('a missing platform fails', () => {
  const r = compare({ android: 1000 }, cfg(base))
  assert.equal(r.ok, false)
  assert.match(r.lines.join('\n'), /ios/)
})

test('a null baseline is skipped', () => {
  const r = compare({ android: 1000, ios: 1000 }, cfg(base))
  assert.equal(r.ok, true)
  assert.match(r.lines.join('\n'), /chartDom: not built \(skipped\)/)
  assert.match(r.lines.join('\n'), /toolDom: not built \(skipped\)/)
})

test('measure reads bundle sizes from metadata.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundles-'))
  mkdirSync(join(dir, '_expo/static/js/android'), { recursive: true })
  mkdirSync(join(dir, '_expo/static/js/ios'), { recursive: true })
  writeFileSync(join(dir, '_expo/static/js/android/a.hbc'), 'x'.repeat(10))
  writeFileSync(join(dir, '_expo/static/js/ios/i.hbc'), 'y'.repeat(20))
  writeFileSync(
    join(dir, 'metadata.json'),
    JSON.stringify({
      fileMetadata: {
        android: { bundle: '_expo/static/js/android/a.hbc' },
        ios: { bundle: '_expo/static/js/ios/i.hbc' },
      },
    }),
  )
  assert.deepEqual(measure(dir), { android: 10, ios: 20 })
})
