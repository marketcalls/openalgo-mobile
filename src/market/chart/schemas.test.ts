import { HistorySchema, HolidaysSchema, IntervalsSchema, TimingsSchema } from './schemas'

const ok = (data: unknown) => ({ status: 'success', data })

describe('HistorySchema', () => {
  test('HistorySchema coerces string numbers and drops unreadable rows', () => {
    const { rows, dropped } = HistorySchema.parse(
      ok([
        { timestamp: 1764215100, open: 1500, high: 1505, low: 1498, close: 1503, volume: 1200 },
        {
          timestamp: '1764215400',
          open: '1503.5',
          high: '1506',
          low: '1502',
          close: '1504.25',
          volume: '900',
          oi: '12000',
        },
        // A row without a close, a fractional time, or an unreadable price cannot be drawn.
        { timestamp: 1764215700, open: 1504, high: 1507, low: 1503 },
        { timestamp: 1764215700.5, open: 1504, high: 1507, low: 1503, close: 1505 },
        { timestamp: 1764216000, open: 'n/a', high: 1507, low: 1503, close: 1505 },
        'junk',
        null,
        // An unreadable volume or oi is left unset; the bar is still drawn.
        { timestamp: 1764216300, open: 1505, high: 1509, low: 1504, close: 1508, volume: '' },
        { timestamp: 1764216600, open: 1508, high: 1510, low: 1506, close: 1507, oi: 'x' },
      ]),
    )
    // The five rows that cannot be drawn are counted, so the route can say so.
    expect(dropped).toBe(5)
    expect(rows).toEqual([
      { timestamp: 1764215100, open: 1500, high: 1505, low: 1498, close: 1503, volume: 1200 },
      {
        timestamp: 1764215400,
        open: 1503.5,
        high: 1506,
        low: 1502,
        close: 1504.25,
        volume: 900,
        oi: 12000,
      },
      { timestamp: 1764216300, open: 1505, high: 1509, low: 1504, close: 1508 },
      { timestamp: 1764216600, open: 1508, high: 1510, low: 1506, close: 1507 },
    ])
    for (const r of rows) {
      expect(r.volume === undefined || typeof r.volume === 'number').toBe(true)
      expect(r.oi === undefined || typeof r.oi === 'number').toBe(true)
    }
  })

  test('no data is no rows, and an error envelope is not a history', () => {
    expect(HistorySchema.parse(ok([]))).toEqual({ rows: [], dropped: 0 })
    expect(HistorySchema.parse(ok(null))).toEqual({ rows: [], dropped: 0 })
    expect(HistorySchema.safeParse({ status: 'error', message: 'No data' }).success).toBe(false)
  })
})

describe('the calendar and interval schemas', () => {
  test('IntervalsSchema reads the groups the server sends, any of them absent', () => {
    const all = {
      seconds: ['1s'],
      minutes: ['1m', '5m', '15m'],
      hours: ['1h'],
      days: ['D'],
      weeks: ['W'],
      months: ['M'],
    }
    expect(IntervalsSchema.parse(ok(all))).toEqual(all)
    expect(IntervalsSchema.parse(ok({ minutes: ['1m'], days: ['D'] }))).toEqual({
      minutes: ['1m'],
      days: ['D'],
    })
    expect(IntervalsSchema.safeParse(ok({ minutes: '1m' })).success).toBe(false)
  })

  test('TimingsSchema reads the epochs, numbers sent as strings included', () => {
    // docs/api/market-calendar/timings.md at c8b2896, trimmed.
    expect(
      TimingsSchema.parse(
        ok([
          { exchange: 'NSE', start_time: 1766115900000, end_time: 1766138400000 },
          { exchange: 'MCX', start_time: '1766115000000', end_time: '1766168700000' },
        ]),
      ),
    ).toEqual([
      { exchange: 'NSE', start_time: 1766115900000, end_time: 1766138400000 },
      { exchange: 'MCX', start_time: 1766115000000, end_time: 1766168700000 },
    ])
    expect(TimingsSchema.parse(ok([]))).toEqual([])
    expect(TimingsSchema.parse(ok(null))).toEqual([])
    expect(TimingsSchema.safeParse({ status: 'error', message: 'x' }).success).toBe(false)
  })

  test('TimingsSchema drops a row with null times and keeps the rest', () => {
    // A special session's open exchange stored without times (market_calendar_db.py:104-105,
    // returned as-is at :686-699): only that row goes, and its exchange takes its default.
    expect(
      TimingsSchema.parse(
        ok([
          { exchange: 'NSE', start_time: null, end_time: null },
          { exchange: 'BSE', start_time: 1762607700000, end_time: 1762611300000 },
          { exchange: 'MCX', start_time: '1762607700000', end_time: 'x' },
          { exchange: 'NFO' },
          null,
        ]),
      ),
    ).toEqual([{ exchange: 'BSE', start_time: 1762607700000, end_time: 1762611300000 }])
  })

  test('HolidaysSchema reads each holiday; unreadable exchange lists are empty', () => {
    // docs/api/market-calendar/holidays.md at c8b2896, trimmed, plus two broken lists.
    expect(
      HolidaysSchema.parse(
        ok([
          {
            date: '2026-03-10',
            description: 'Holi',
            holiday_type: 'TRADING_HOLIDAY',
            closed_exchanges: ['NSE', 'BSE'],
            open_exchanges: [
              { exchange: 'MCX', start_time: 1741624200000, end_time: 1741677900000 },
            ],
          },
          {
            date: '2026-11-08',
            holiday_type: 'SPECIAL_SESSION',
            closed_exchanges: null,
            open_exchanges: [{ exchange: 'NSE', start_time: null, end_time: null }],
          },
          { date: '2026-02-19', holiday_type: 'SETTLEMENT_HOLIDAY' },
        ]),
      ),
    ).toEqual([
      {
        date: '2026-03-10',
        holiday_type: 'TRADING_HOLIDAY',
        closed_exchanges: ['NSE', 'BSE'],
        open_exchanges: [{ exchange: 'MCX', start_time: 1741624200000, end_time: 1741677900000 }],
      },
      {
        date: '2026-11-08',
        holiday_type: 'SPECIAL_SESSION',
        closed_exchanges: [],
        open_exchanges: [],
      },
      {
        date: '2026-02-19',
        holiday_type: 'SETTLEMENT_HOLIDAY',
        closed_exchanges: [],
        open_exchanges: [],
      },
    ])
  })
})
