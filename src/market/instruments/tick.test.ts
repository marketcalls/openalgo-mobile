import { fmtTick, resolveTick, snapTick, tickDecimals, tickSize } from './tick'

describe('tick rules (format.ts:11-42, terminal.ts:920-923)', () => {
  test('resolveTick pins indices and keeps real fine ticks', () => {
    expect(resolveTick('NSE_INDEX', 0.0005)).toBe(0.05)
    expect(resolveTick('MCX_INDEX', 0.0001)).toBe(0.05)
    expect(resolveTick('CDS', 0.0025)).toBe(0.0025)
    expect(resolveTick('NSE', 0)).toBe(0.05)
    expect(resolveTick('NSE', '')).toBe(0.05)
    expect(resolveTick('NSE', undefined)).toBe(0.05)
  })

  test('tickSize guards a tick over 1% of the price or not positive', () => {
    expect(tickSize(1, 23)).toBe(0.05)
    expect(tickSize(0.05, 1424)).toBe(0.05)
    expect(tickSize(0, 100)).toBe(0.05)
    expect(tickSize(undefined, 100)).toBe(0.05)
    expect(tickSize(5, 0)).toBe(5) // no reference price: no guard
  })

  test('tickDecimals', () => {
    expect(tickDecimals(0.05, 1424)).toBe(2)
    expect(tickDecimals(0.1, 24117)).toBe(1)
    expect(tickDecimals(1, 500)).toBe(0)
    expect(tickDecimals(0.0025, 83)).toBe(4)
  })

  test('snapTick', () => {
    expect(snapTick(1424.03, 0.05, 1424)).toBe(1424.05)
    expect(snapTick(24117.27, 0.1, 24117)).toBe(24117.3)
    expect(snapTick(83.1234, 0.0025, 83)).toBe(83.1225)
    expect(snapTick(10.02, 1, 23)).toBe(10) // guard falls back to 0.05
  })

  test('fmtTick groups the Indian way at the tick decimals, never fewer than two', () => {
    expect(fmtTick(1234567.5, 0.05, 1234567)).toBe('12,34,567.50')
    expect(fmtTick(83.1225, 0.0025, 83)).toBe('83.1225')
    expect(fmtTick(-2500, 0.1, 100000)).toBe('-2,500.00')
    expect(fmtTick(5, 1, 500)).toBe('5.00')
  })
})
