// The tool POSTs' replies: the full report fixtures by default, the thin replies while the
// control `thinToolReplies` is set (ux-bar T15-02: the E-SH-8 fallback case).
import assert from 'node:assert/strict'
import test from 'node:test'
import { call, mock, post } from './test-helpers.mjs'

const BACKTEST = {
  holdings: [
    { symbol: 'RELIANCE', exchange: 'NSE', weight: 50 },
    { symbol: 'INFY', exchange: 'NSE', weight: 30 },
    { symbol: 'NIFTYBEES', exchange: 'NSE', weight: 20 },
  ],
  start_date: '2024-01-01',
  end_date: '2025-12-31',
}
const SIP = {
  symbol: 'NIFTYBEES',
  exchange: 'NSE',
  start_date: '2024-01-01',
  end_date: '2025-12-31',
  amount: 5000,
}
const patch = (m, body) => call(m, 'POST', '/__mock/control', body)

test('the backtest reply carries every report section, typed as frontend api/portfolio.ts', async (t) => {
  const m = await mock(t)
  const r = (await post(m, 'portfolio/backtest', BACKTEST)).json
  assert.equal(r.status, 'success')
  for (const k of [
    'meta',
    'equity',
    'benchmark_equity',
    'metrics',
    'items',
    'correlation',
    'diversification',
    'walk_forward',
    'monte_carlo',
    'rebalancing_sweep',
    'attribution',
    'asset_returns',
    'structure',
    'allocation',
    'crisis',
    'costs',
    'series',
    'health',
    'rebalancing',
  ])
    assert.ok(r[k] !== undefined, k)
  assert.ok(r.equity.length > 5)
  assert.deepEqual(r.meta.symbols, ['RELIANCE', 'INFY', 'NIFTYBEES'])
  assert.equal(r.items.length, 3)
  assert.equal(r.correlation.matrix.length, 3)
  assert.equal(typeof r.metrics.cagr, 'number')
  // the same request twice: the same report
  assert.deepEqual((await post(m, 'portfolio/backtest', BACKTEST)).json, r)
})

test('the SIP reply carries the report, and the holdings and rotation replies carry data', async (t) => {
  const m = await mock(t)
  const sip = (await post(m, 'sip/backtest', SIP)).json
  for (const k of [
    'headline',
    'underwater',
    'drawdown',
    'yearly',
    'monthly_heatmap',
    'lumpsum',
    'frequency_comparison',
    'curves',
    'installments',
    'charges',
    'crisis',
    'rolling_xirr',
    'start_date_heatmap',
    'sip_date_heatmap',
  ])
    assert.ok(sip[k] !== undefined, k)
  assert.equal(sip.request.amount, 5000)
  assert.ok(sip.curves.value.length > 5)
  const held = (await post(m, 'portfolio/holdings', {})).json
  assert.equal(held.summary.holdings.length, 3)
  assert.equal(held.analysis.status, 'success')
  const rot = (await post(m, 'sectorrotation', {})).json
  assert.equal(rot.data.instruments.length, 2)
  assert.equal(rot.data.instruments[0].tail.length, 3)
})

test('thinToolReplies serves the thin replies until it is cleared', async (t) => {
  const m = await mock(t)
  assert.equal((await call(m, 'GET', '/__mock/control')).json.thinToolReplies, false)
  assert.equal((await patch(m, { thinToolReplies: true })).json.thinToolReplies, true)
  const bt = (await post(m, 'portfolio/backtest', BACKTEST)).json
  assert.deepEqual([bt.equity, bt.benchmark_equity, bt.metrics], [[], [], {}])
  assert.equal(bt.items, undefined)
  const sip = (await post(m, 'sip/backtest', SIP)).json
  assert.deepEqual(sip.yearly, [])
  assert.equal(sip.headline, undefined)
  assert.equal((await post(m, 'portfolio/holdings', {})).json.summary.count, 0)
  assert.deepEqual((await post(m, 'sectorrotation', {})).json.data.instruments, [])
  assert.equal((await patch(m, { thinToolReplies: false })).json.thinToolReplies, false)
  assert.ok((await post(m, 'portfolio/backtest', BACKTEST)).json.equity.length > 5)
  // a reset clears it, and a non-boolean is refused
  await patch(m, { thinToolReplies: true })
  await call(m, 'POST', '/__mock/reset')
  assert.equal((await call(m, 'GET', '/__mock/control')).json.thinToolReplies, false)
  assert.equal((await patch(m, { thinToolReplies: 'yes' })).status, 400)
})
