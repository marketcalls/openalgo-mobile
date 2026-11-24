import { fmtPct, fmtPrice, fmtQty, fmtSigned, signOf } from './format'

test('prices use Indian grouping and two decimals', () => {
  expect(fmtPrice(1569.9)).toBe('1,569.90')
  expect(fmtPrice(123456.5)).toBe('1,23,456.50')
  expect(fmtPrice(5, 0)).toBe('5')
})

test('a missing or non-finite price is --', () => {
  expect(fmtPrice(undefined)).toBe('--')
  expect(fmtPrice(Number.NaN)).toBe('--')
})

test('signed values, percents and quantities', () => {
  expect(fmtPct(-0.456)).toBe('-0.46%')
  expect(fmtPct(0.456)).toBe('+0.46%')
  expect(fmtSigned(1.2)).toBe('+1.20')
  expect(fmtSigned(-1234.5)).toBe('-1,234.50')
  expect(fmtSigned(0)).toBe('0.00')
  expect(fmtSigned(-0.001)).toBe('0.00')
  expect(fmtQty(1234567)).toBe('12,34,567')
  expect(signOf(-2)).toBe(-1)
  expect(signOf(3)).toBe(1)
  expect(signOf(undefined)).toBe(0)
})
