import { numberOf, qtyOf } from './OrderFields'

describe('numberOf (a price or trigger field)', () => {
  test('a plain number, a point decimal, blank and junk', () => {
    expect(numberOf('1424.05')).toBe(1424.05)
    expect(numberOf(' 17 ')).toBe(17)
    expect(numberOf('')).toBeUndefined()
    expect(numberOf('  ')).toBeUndefined()
    expect(numberOf('abc')).toBeUndefined()
    expect(numberOf('1.2.3')).toBeUndefined()
  })

  test("a decimal comma (iOS decimal-pad in de, fr, es: no '.' key) is the decimal point", () => {
    expect(numberOf('1424,05')).toBe(1424.05)
    expect(numberOf('1430,5')).toBe(1430.5)
    expect(numberOf('0,5')).toBe(0.5)
    expect(numberOf(',5')).toBe(0.5)
    // mid-typing
    expect(numberOf('1424,')).toBe(1424)
  })

  test('commas that group thousands before a point, or in several groups, are dropped', () => {
    expect(numberOf('1,424.05')).toBe(1424.05)
    expect(numberOf('1,42,405.50')).toBe(142405.5)
    expect(numberOf('1,42,405')).toBe(142405)
    expect(numberOf('142,405')).toBeUndefined()
  })

  test('anything that reads two ways is no number, so the ticket refuses it', () => {
    // a thousands group or three decimals
    expect(numberOf('1,424')).toBeUndefined()
    // a decimal comma after a grouping point
    expect(numberOf('1.424,05')).toBeUndefined()
    // commas that are no grouping
    expect(numberOf('1,2,3')).toBeUndefined()
    expect(numberOf('14,24,05')).toBeUndefined()
  })
})

describe('qtyOf (a quantity field)', () => {
  test('whole numbers, and commas only as thousands groups', () => {
    expect(qtyOf('10')).toBe(10)
    expect(qtyOf('1,000')).toBe(1000)
    expect(qtyOf('1,00,000')).toBe(100000)
    expect(qtyOf('')).toBeNaN()
    // a decimal comma is not read as a group: "10,5" is not 105
    expect(qtyOf('10,5')).toBeNaN()
  })
})
