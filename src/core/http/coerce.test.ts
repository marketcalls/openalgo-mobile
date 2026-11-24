import { z } from 'zod'
import { bool, dmyHms, expiryIso, int, num, optNum, str } from './coerce'

const accepts = (s: z.ZodType, v: unknown) => s.safeParse(v)
const fails = (s: z.ZodType, v: unknown) => expect(accepts(s, v).success).toBe(false)

describe('num', () => {
  test.each([
    [1.5, 1.5],
    [0, 0],
    ['320.66', 320.66],
    ['-7.88', -7.88],
    ['0.00', 0],
    [' 42 ', 42],
    ['1e3', 1000],
    ['.5', 0.5],
  ])('%p → %p', (v, out) => expect(num.parse(v)).toBe(out))

  test.each([[''], ['  '], ['abc'], ['12abc'], ['1,234'], ['NaN'], ['1e999']])(
    'rejects the string %p',
    (v) => fails(num, v),
  )
  test.each([[null], [undefined], [Number.NaN], [Number.POSITIVE_INFINITY], [true], [{}]])(
    'rejects %p',
    (v) => fails(num, v),
  )
})

describe('optNum', () => {
  const o = z.object({ x: optNum })
  test('absent, empty and null give undefined', () => {
    expect(o.parse({})).toEqual({})
    expect(o.parse({ x: '' }).x).toBeUndefined()
    expect(o.parse({ x: null }).x).toBeUndefined()
  })
  test('numbers and numeric strings pass through num', () => {
    expect(o.parse({ x: '2.5' }).x).toBe(2.5)
    expect(o.parse({ x: 3 }).x).toBe(3)
  })
  test('rejects other strings', () => fails(o, { x: 'abc' }))
})

describe('int', () => {
  test.each([
    [5, 5],
    ['75', 75],
    ['10.0', 10],
  ])('%p → %p', (v, out) => expect(int.parse(v)).toBe(out))
  test.each([[1.5], ['1.5'], [''], [null]])('rejects %p', (v) => fails(int, v))
})

describe('str', () => {
  test.each([
    ['RELIANCE', 'RELIANCE'],
    ['', ''],
    [2885, '2885'],
  ])('%p → %p', (v, out) => expect(str.parse(v)).toBe(out))
  test.each([[null], [undefined], [true], [{}]])('rejects %p', (v) => fails(str, v))
})

describe('bool', () => {
  test.each([
    [true, true],
    [false, false],
    ['true', true],
    ['false', false],
    [1, true],
    [0, false],
  ])('%p → %p', (v, out) => expect(bool.parse(v)).toBe(out))
  test.each([['yes'], ['1'], ['TRUE'], [2], [''], [null]])('rejects %p', (v) => fails(bool, v))
})

describe('dmyHms (IST)', () => {
  test.each([
    ['08-Apr-2025 13:58:03', '2025-04-08T13:58:03+05:30'],
    ['8-apr-2025 09:15:00', '2025-04-08T09:15:00+05:30'],
    ['31-DEC-2025 23:59:59', '2025-12-31T23:59:59+05:30'],
    ['01-Jan-2026 00:00:00', '2026-01-01T00:00:00+05:30'],
  ])('%s → %s', (s, iso) => expect(dmyHms(s)).toBe(Date.parse(iso)))

  test.each([
    [''],
    ['2025-04-08 13:58:03'],
    ['08-Apr-2025'],
    ['31-Feb-2025 10:00:00'],
    ['08-Foo-2025 10:00:00'],
    ['08-Apr-2025 24:00:00'],
    ['08-Apr-2025 13:60:00'],
  ])('%p → null', (s) => expect(dmyHms(s)).toBeNull())
})

describe('expiryIso', () => {
  test.each([
    ['28-NOV-26', '2026-11-28'],
    ['28NOV26', '2026-11-28'],
    ['05-feb-27', '2027-02-05'],
    ['29FEB28', '2028-02-29'],
  ])('%s → %s', (s, iso) => expect(expiryIso(s)).toBe(iso))

  test.each([[''], ['28-NOV26'], ['28-NOV-2026'], ['29-FEB-27'], ['32JAN27'], ['28-XYZ-26']])(
    '%p → null',
    (s) => expect(expiryIso(s)).toBeNull(),
  )
})
