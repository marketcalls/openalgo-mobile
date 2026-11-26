import { chartIntervals, FALLBACK_INTERVALS } from './intervals'

const data = {
  seconds: ['1s', '5s'],
  minutes: ['1m', '5m', '15m'],
  hours: ['1h'],
  days: ['D'],
  weeks: ['W'],
  months: ['M'],
}

describe('chartIntervals', () => {
  test('intervals flatten in order; polling drops seconds; a failed read gives the fallback', () => {
    expect(chartIntervals(data, false)).toEqual([
      '1s',
      '5s',
      '1m',
      '5m',
      '15m',
      '1h',
      'D',
      'W',
      'M',
    ])
    expect(chartIntervals(data, true)).toEqual(['1m', '5m', '15m', '1h', 'D', 'W', 'M'])
    expect(chartIntervals(null, false)).toEqual(FALLBACK_INTERVALS)
    expect(FALLBACK_INTERVALS).toEqual(['1m', '5m', '15m', '1h', 'D'])
  })

  test('missing groups and repeats are tolerated, an empty list gives the fallback', () => {
    expect(chartIntervals({ minutes: ['1m', '1m'], days: ['D'] }, false)).toEqual(['1m', 'D'])
    expect(chartIntervals({}, false)).toEqual(FALLBACK_INTERVALS)
  })

  test("Zerodha's pre-2.0.2.2 aliases that history refuses are dropped", () => {
    const zerodha = {
      minutes: ['1m', '3m', '5m', '10m', '15m', '30m', '60m'],
      hours: ['1h'],
      days: ['D'],
    }
    expect(chartIntervals(zerodha, false)).toEqual([
      '1m',
      '3m',
      '5m',
      '10m',
      '15m',
      '30m',
      '1h',
      'D',
    ])
  })
})

test('the fallback list is frozen, so no caller can change it for every chart', () => {
  expect(Object.isFrozen(FALLBACK_INTERVALS)).toBe(true)
  expect(() => (FALLBACK_INTERVALS as string[]).push('2m')).toThrow()
  expect(chartIntervals(null, false)).toBe(FALLBACK_INTERVALS)
})
