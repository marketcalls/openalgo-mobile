import { isAnyMarketOpen, isExchangeOpen, istClock, istDate, istParts } from './marketHours'

// IST = UTC+5:30. 2026-11-23 is a Monday.
const ist = (day: number, h: number, m: number) =>
  new Date(Date.UTC(2026, 10, day, h, m) - 19_800_000)
const MON = 23
const SAT = 28
const SUN = 29

const cases = (): void => {
  test('NSE opens at 09:15 Monday', () => {
    expect(isExchangeOpen('NSE', ist(MON, 9, 14))).toBe(false)
    expect(isExchangeOpen('NSE', ist(MON, 9, 15))).toBe(true)
    expect(isExchangeOpen('NSE', ist(MON, 15, 29))).toBe(true)
    expect(isExchangeOpen('NSE', ist(MON, 15, 30))).toBe(false)
  })
  test('NFO runs to 15:40', () => {
    expect(isExchangeOpen('NFO', ist(MON, 15, 39))).toBe(true)
    expect(isExchangeOpen('NFO', ist(MON, 15, 40))).toBe(false)
  })
  test('MCX runs to 23:55', () => {
    expect(isExchangeOpen('MCX', ist(MON, 23, 54))).toBe(true)
    expect(isExchangeOpen('MCX', ist(MON, 23, 55))).toBe(false)
  })
  test('CDS 09:00-17:00', () => {
    expect(isExchangeOpen('CDS', ist(MON, 9, 0))).toBe(true)
    expect(isExchangeOpen('CDS', ist(MON, 17, 0))).toBe(false)
  })
  test('weekend closed, CRYPTO always open', () => {
    expect(isExchangeOpen('NSE', ist(SAT, 10, 0))).toBe(false)
    expect(isExchangeOpen('MCX', ist(SUN, 10, 0))).toBe(false)
    expect(isExchangeOpen('CRYPTO', ist(SUN, 3, 0))).toBe(true)
  })
  test('unknown exchange is closed; isAnyMarketOpen', () => {
    expect(isExchangeOpen('XYZ', ist(MON, 10, 0))).toBe(false)
    expect(isAnyMarketOpen(ist(MON, 10, 0))).toBe(true)
    expect(isAnyMarketOpen(ist(MON, 23, 56))).toBe(true) // CRYPTO
  })
  test('istParts', () => {
    expect(istParts(ist(MON, 9, 15))).toEqual({ day: 1, minutes: 9 * 60 + 15 })
    // 00:10 IST Tuesday is Monday 18:40 UTC
    expect(istParts(new Date(Date.UTC(2026, 10, 23, 18, 40)))).toEqual({ day: 2, minutes: 10 })
  })
}

describe.each(['America/New_York', 'Asia/Kolkata', 'Pacific/Auckland'])('TZ=%s (RF 5)', (tz) => {
  const prev = process.env.TZ
  beforeAll(() => {
    process.env.TZ = tz
  })
  afterAll(() => {
    process.env.TZ = prev
  })
  cases()
})

describe('IST date and clock', () => {
  test('istDate is the IST calendar date, whatever the device zone', () => {
    // 2026-11-23 20:00 UTC is already 01:30 on the 24th in IST
    expect(istDate(Date.UTC(2026, 10, 23, 20, 0))).toBe('2026-11-24')
    expect(istDate(new Date(Date.UTC(2026, 10, 23, 18, 29)))).toBe('2026-11-23')
    expect(istDate(Date.UTC(2026, 10, 23, 18, 30))).toBe('2026-11-24')
  })
  test('istClock is the IST wall clock', () => {
    expect(istClock(Date.UTC(2026, 10, 23, 3, 45, 9))).toEqual({ hh: 9, mm: 15, ss: 9 })
    expect(istClock(Date.UTC(2026, 10, 23, 18, 30))).toEqual({ hh: 0, mm: 0, ss: 0 })
  })
})
