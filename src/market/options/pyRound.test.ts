import { pyRound, pySum } from './pyRound'

// The right column is what CPython 3.12 prints for round(x, nd).
test.each([
  [0.125, 2, 0.12],
  [0.375, 2, 0.38],
  [2.675, 2, 2.67],
  [-0.125, 2, -0.12],
  [2.5, 0, 2],
  [1e-7, 6, 0],
  [0.5, 0, 0],
  [1.5, 0, 2],
  [-2.5, 0, -2],
  [1234.5, 0, 1234],
  [0.0625, 3, 0.062],
  [12.345, 2, 12.35],
  [0.045, 2, 0.04],
  [1.0005, 3, 1],
  [5e-324, 2, 0],
  [1e22, 2, 1e22],
])('pyRound(%p, %p) is %p', (x, nd, want) => expect(pyRound(x, nd)).toBe(want))

test('pyRound keeps the sign of a negative value that rounds to zero, as Python does', () => {
  expect(Object.is(pyRound(-1e-9, 4), -0)).toBe(true)
  expect(Object.is(pyRound(-0, 2), -0)).toBe(true)
  expect(Object.is(pyRound(1e-9, 4), 0)).toBe(true)
})

test('pyRound passes NaN and the infinities through', () => {
  expect(pyRound(Number.NaN, 2)).toBeNaN()
  expect(pyRound(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY)
  expect(pyRound(Number.NEGATIVE_INFINITY, 4)).toBe(Number.NEGATIVE_INFINITY)
})

test('pySum matches CPython where naive addition differs', () => {
  expect(pySum([1e16, 1, -1e16])).toBe(1)
  expect(pySum([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1])).toBe(1)
  expect(pySum([0.1, 0.2, 0.3])).toBe(0.6)
  expect(pySum([1e100, 1, -1e100])).toBe(1)
})

test('pySum of nothing is 0, and of -0.0 is 0.0 (the start value is the int 0)', () => {
  expect(pySum([])).toBe(0)
  expect(Object.is(pySum([-0]), 0)).toBe(true)
})
