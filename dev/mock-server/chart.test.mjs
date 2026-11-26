import assert from 'node:assert/strict'
import test from 'node:test'
import { historySeries, MOCK_HOLIDAYS, MOCK_INTERVALS, timingsFor } from './chart.mjs'
import { control, mock, post } from './test-helpers.mjs'

const IST = 19_800_000
const istMs = (iso) => Date.parse(`${iso}+05:30`)
const NOW = istMs('2026-11-12T10:00:00')
const FIVE = {
  symbol: 'RELIANCE',
  exchange: 'NSE',
  interval: '5m',
  startDate: '2026-11-09',
  endDate: '2026-11-10',
  lastClose: 1234.5,
  nowMs: NOW,
}
const istClock = (seconds) => new Date(seconds * 1000 + IST).toISOString().slice(11, 16)

test('intervals answers the mock set', async (t) => {
  const m = await mock(t)
  const r = await post(m, 'intervals')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { status: 'success', data: MOCK_INTERVALS })
  assert.deepEqual(r.json.data.minutes, ['1m', '3m', '5m', '10m', '15m', '30m'])
})

test('5m history over two weekdays is 150 session bars, ascending, ending at the price', () => {
  const rows = historySeries(FIVE)
  assert.equal(rows.length, 150)
  for (const r of rows) {
    const c = istClock(r.timestamp)
    assert.ok(c >= '09:15' && c <= '15:25', c)
    assert.ok(r.high >= Math.max(r.open, r.close) && r.low <= Math.min(r.open, r.close))
  }
  assert.ok(rows.every((r, i) => i === 0 || r.timestamp > rows[i - 1].timestamp))
  assert.equal(rows.at(-1).close, 1234.5)
  assert.deepEqual(historySeries(FIVE), rows)
  assert.ok(rows.every((r) => r.oi === 0))
})

test('history stops at now, keeps the newest 2,000 bars, and carries oi on F&O', () => {
  const cut = historySeries({ ...FIVE, nowMs: istMs('2026-11-10T09:30:00') })
  assert.equal(istClock(cut.at(-1).timestamp), '09:30')
  const many = historySeries({
    ...FIVE,
    exchange: 'CRYPTO',
    interval: '1m',
    startDate: '2026-01-01',
    endDate: '2026-11-10',
  })
  assert.equal(many.length, 2000)
  assert.equal(many.at(-1).timestamp * 1000, istMs('2026-11-10T23:59:00'))
  assert.ok(historySeries({ ...FIVE, exchange: 'NFO' }).every((r) => r.oi > 0))
})

test('D, W and M give daily, weekly and monthly bars', () => {
  const range = { ...FIVE, startDate: '2026-10-01', endDate: '2026-11-12' }
  const day = historySeries({ ...range, interval: 'D' })
  assert.equal(day.length, 32) // 31 weekdays and the Sunday special session
  const week = historySeries({ ...range, interval: 'W' })
  assert.deepEqual(
    week.map((r) => new Date(r.timestamp * 1000 + IST).toISOString().slice(0, 10)),
    [
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
      '2026-11-02',
      '2026-11-09',
    ],
  )
  const month = historySeries({ ...range, interval: 'M' })
  assert.deepEqual(
    month.map((r) => new Date(r.timestamp * 1000 + IST).toISOString().slice(0, 10)),
    ['2026-10-01', '2026-11-01'],
  )
})

test('an interval outside the OneOf is a 400 dict; one the broker lacks is a 500', async (t) => {
  const m = await mock(t)
  const body = {
    symbol: 'RELIANCE',
    exchange: 'NSE',
    start_date: '2026-11-09',
    end_date: '2026-11-10',
  }
  const bad = await post(m, 'history', { ...body, interval: '7m' })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.status, 'error')
  assert.match(bad.json.message.interval[0], /^Must be one of: 1s, 5s/)
  const lacks = await post(m, 'history', { ...body, interval: '2m' })
  assert.equal(lacks.status, 500)
  assert.deepEqual(lacks.json, { status: 'error', message: 'Unsupported timeframe: 2m' })
  const ok = await post(m, 'history', { ...body, interval: '5m' })
  assert.equal(ok.status, 200)
  assert.ok(ok.json.data.length > 0)
})

test('a weekday lists NSE 09:15–15:30 IST; a Saturday lists CRYPTO only', async (t) => {
  const m = await mock(t)
  const mon = (await post(m, 'market/timings', { date: '2026-11-09' })).json.data
  const nse = mon.find((r) => r.exchange === 'NSE')
  assert.equal(nse.start_time, istMs('2026-11-09T09:15:00'))
  assert.equal(nse.end_time, istMs('2026-11-09T15:30:00'))
  assert.equal(mon.find((r) => r.exchange === 'NFO').end_time, istMs('2026-11-09T15:40:00'))
  assert.deepEqual(
    mon.map((r) => r.exchange),
    ['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'BCD', 'MCX', 'NCO', 'CRYPTO'],
  )
  const sat = (await post(m, 'market/timings', { date: '2026-11-07' })).json.data
  assert.deepEqual(
    sat.map((r) => r.exchange),
    ['CRYPTO'],
  )
})

test('timingsSkewMs shifts every default-built epoch, and no holiday row', async (t) => {
  const m = await mock(t)
  const at = async (date) => (await post(m, 'market/timings', { date })).json.data
  const before = await at('2026-11-09')
  const sessionBefore = await at('2026-11-08')
  await control(m, { timingsSkewMs: IST })
  const after = await at('2026-11-09')
  assert.deepEqual(
    after.map((r) => [r.start_time - IST, r.end_time - IST]),
    before.map((r) => [r.start_time, r.end_time]),
  )
  assert.deepEqual(await at('2026-11-08'), sessionBefore)
  assert.deepEqual(timingsFor('2026-11-09', IST), after)
  assert.equal((await post(m, 'market/timings', { date: 'x' })).status, 400)
})

test('holiday dates answer with their open rows only', () => {
  assert.deepEqual(timingsFor('2026-01-26'), [])
  const special = timingsFor('2026-11-08', IST)
  assert.deepEqual(
    special.map((r) => [r.exchange, r.start_time, r.end_time]),
    [
      ['NSE', istMs('2026-11-08T18:00:00'), istMs('2026-11-08T19:00:00')],
      ['BSE', istMs('2026-11-08T18:00:00'), istMs('2026-11-08T19:00:00')],
    ],
  )
})

test('holidays answers the fixture year', async (t) => {
  const m = await mock(t)
  const r = await post(m, 'market/holidays', { year: 2026 })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.data, MOCK_HOLIDAYS)
  assert.deepEqual(
    r.json.data.map((h) => h.holiday_type),
    ['TRADING_HOLIDAY', 'SPECIAL_SESSION'],
  )
  assert.deepEqual((await post(m, 'market/holidays', { year: 2025 })).json.data, [])
  assert.equal((await post(m, 'market/holidays', { year: 'x' })).status, 400)
})

test('a holiday has no history bars, a special session its own window', () => {
  const nse = { ...FIVE, startDate: '2026-01-26', endDate: '2026-01-26' }
  assert.equal(historySeries(nse).length, 0)
  const special = historySeries({ ...FIVE, startDate: '2026-11-08', endDate: '2026-11-08' })
  assert.equal(special.length, 12)
  assert.equal(istClock(special[0].timestamp), '18:00')
})
