import { ApiError } from '~/core/http/errors'
import { log } from '~/core/log/logger'
import {
  calendarExchange,
  calendarSpec,
  DEFAULT_CALENDARS,
  DEFAULT_TIMINGS,
  IST_OFFSET_MS,
  inSession,
  loadCalendars,
  timingOffsets,
  yearsAround,
} from './calendar'
import { HolidaysSchema, TimingsSchema } from './schemas'

const NOW = Date.UTC(2026, 10, 27, 5, 0) // Fri 2026-11-27 10:30 IST
const midnight = (d: string) => Date.parse(`${d}T00:00:00Z`) - IST_OFFSET_MS
const nseRow = (d: string, start = 33_300_000, end = 55_800_000, skew = 0) => ({
  exchange: 'NSE',
  start_time: midnight(d) + start + skew,
  end_time: midnight(d) + end + skew,
})
/** The server's ordinary rows for a day: every default, shifted by the server's own midnight. */
const serverRows = (d: string, skew = 0) =>
  DEFAULT_TIMINGS.map((r) => ({
    exchange: r.exchange,
    start_time: midnight(d) + r.start_offset + skew,
    end_time: midnight(d) + r.end_offset + skew,
  }))

type Reply = unknown | (() => unknown)
function fakeApi(timings: Record<string, Reply>, holidays: Record<number, Reply> = {}) {
  const calls: { id: string; body: Record<string, unknown> }[] = []
  const call = async (
    id: string,
    body: Record<string, unknown>,
    schema: { parse(v: unknown): unknown },
  ) => {
    calls.push({ id, body })
    const reply = id === 'market/timings' ? timings[String(body.date)] : holidays[Number(body.year)]
    const v = typeof reply === 'function' ? (reply as () => unknown)() : reply
    return schema.parse({ status: 'success', data: v ?? [] })
  }
  return { api: { call } as never, calls }
}
const timingsCalls = (c: { id: string; body: Record<string, unknown> }[]) =>
  c.filter((x) => x.id === 'market/timings')

describe('timingOffsets', () => {
  test('an IST server: offsets as sent', () => {
    const rows = TimingsSchema.parse({ status: 'success', data: serverRows('2026-11-27') })
    const out = timingOffsets(rows, '2026-11-27')
    expect(out).toEqual(DEFAULT_TIMINGS)
  })

  test('a UTC server: the 5:30 skew comes out of every exchange', () => {
    const rows = TimingsSchema.parse({
      status: 'success',
      data: serverRows('2026-11-27', 19_800_000),
    })
    // start_time + 19_800_000 everywhere
    expect(rows[0]?.start_time).toBe(midnight('2026-11-27') + 33_300_000 + 19_800_000)
    expect(timingOffsets(rows, '2026-11-27')).toEqual(DEFAULT_TIMINGS)
  })

  test('edited NSE hours with a skew: exchange defaults', () => {
    const rows = TimingsSchema.parse({
      status: 'success',
      data: [nseRow('2026-11-27', 33_300_000, 54_000_000, 19_800_000)],
    })
    const info = jest.spyOn(log, 'info').mockImplementation(() => {})
    expect(timingOffsets(rows, '2026-11-27')).toBeNull()
    expect(info).toHaveBeenCalledWith('chart', 'timings not in IST hours: defaults')
    info.mockRestore()
  })

  test('a skew that is not a multiple of 15 minutes, or beyond 14 hours, is refused', () => {
    const odd = [nseRow('2026-11-27', 33_300_000, 55_800_000, 1_000)]
    expect(
      timingOffsets(TimingsSchema.parse({ status: 'success', data: odd }), '2026-11-27'),
    ).toBeNull()
    const far = [nseRow('2026-11-27', 33_300_000, 55_800_000, 51_300_000)]
    expect(
      timingOffsets(TimingsSchema.parse({ status: 'success', data: far }), '2026-11-27'),
    ).toBeNull()
  })

  test('BSE anchors when NSE is absent; neither gives null', () => {
    const bse = [{ ...nseRow('2026-11-27'), exchange: 'BSE' }]
    expect(timingOffsets(bse, '2026-11-27')).toEqual([DEFAULT_TIMINGS[1]])
    expect(
      timingOffsets([{ exchange: 'MCX', start_time: 1, end_time: 2 }], '2026-11-27'),
    ).toBeNull()
  })

  test('a row outside the day takes its default', () => {
    const rows = [
      nseRow('2026-11-27'),
      {
        exchange: 'MCX',
        start_time: midnight('2026-11-27') + 40_000_000,
        end_time: midnight('2026-11-27') + 90_000_000,
      },
    ]
    expect(timingOffsets(rows, '2026-11-27')).toEqual([DEFAULT_TIMINGS[0], DEFAULT_TIMINGS[6]])
  })
})

describe('calendarSpec', () => {
  const hol = (h: Partial<Parameters<typeof calendarSpec>[2][number]> & { date: string }) => ({
    holiday_type: 'TRADING_HOLIDAY',
    closed_exchanges: [],
    open_exchanges: [],
    ...h,
  })

  test('a holiday closes its exchanges; a special session is its window; a settlement holiday is ignored', () => {
    const special = {
      exchange: 'NSE',
      start_time: midnight('2026-11-08') + 64_800_000, // 18:00 IST
      end_time: midnight('2026-11-08') + 68_400_000,
    }
    const spec = calendarSpec('NSE', DEFAULT_TIMINGS, [
      hol({ date: '2026-12-25', closed_exchanges: ['NSE', 'BSE'] }),
      hol({ date: '2026-11-08', holiday_type: 'SPECIAL_SESSION', open_exchanges: [special] }),
      hol({ date: '2026-11-10', holiday_type: 'SETTLEMENT_HOLIDAY', closed_exchanges: ['NSE'] }),
      hol({ date: '2026-11-11', closed_exchanges: ['MCX'] }),
    ])
    expect(spec).toEqual({
      timezone: 'Asia/Kolkata',
      sessions: ['0915-1530:23456'],
      exceptions: { '2026-12-25': [], '2026-11-08': ['1800-1900'] },
      preMarketMinutes: 15,
    })
  })

  test('CRYPTO is round the clock in UTC and an index follows its exchange', () => {
    expect(
      calendarSpec('CRYPTO', DEFAULT_TIMINGS, [
        hol({ date: '2026-12-25', closed_exchanges: ['CRYPTO'] }),
      ]),
    ).toEqual({
      timezone: 'UTC',
      sessions: ['0000-0000'],
      exceptions: {},
    })
    expect(calendarExchange('NSE_INDEX')).toBe('NSE')
    expect(calendarSpec('NSE_INDEX', DEFAULT_TIMINGS, [])).toEqual(
      calendarSpec('NSE', DEFAULT_TIMINGS, []),
    )
    expect(calendarSpec('NCDEX', DEFAULT_TIMINGS, [])).toBeNull()
  })
})

describe('inSession', () => {
  /** An IST wall-clock time on a date, as epoch ms. */
  const ist = (d: string, hhmm: string) =>
    midnight(d) + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2))) * 60_000

  test('the weekly session on its weekdays, from its open up to its close', () => {
    const nse = DEFAULT_CALENDARS.NSE
    if (!nse) throw new Error('no NSE')
    // Friday 2026-11-27
    expect(inSession(nse, ist('2026-11-27', '0914'))).toBe(false)
    expect(inSession(nse, ist('2026-11-27', '0915'))).toBe(true)
    expect(inSession(nse, ist('2026-11-27', '1529'))).toBe(true)
    expect(inSession(nse, ist('2026-11-27', '1530'))).toBe(false)
    // Saturday and Sunday are not in 23456
    expect(inSession(nse, ist('2026-11-28', '1000'))).toBe(false)
    expect(inSession(nse, ist('2026-11-29', '1000'))).toBe(false)
  })

  test("a date's exceptions replace the week: a holiday closes it, a special session is its window", () => {
    const spec = calendarSpec('NSE', DEFAULT_TIMINGS, [
      {
        date: '2026-11-27',
        holiday_type: 'TRADING_HOLIDAY',
        closed_exchanges: ['NSE'],
        open_exchanges: [],
      },
      {
        date: '2026-11-29',
        holiday_type: 'SPECIAL_SESSION',
        closed_exchanges: [],
        open_exchanges: [
          {
            exchange: 'NSE',
            start_time: ist('2026-11-29', '1800'),
            end_time: ist('2026-11-29', '1900'),
          },
        ],
      },
    ])
    if (!spec) throw new Error('no spec')
    expect(inSession(spec, ist('2026-11-27', '1000'))).toBe(false)
    expect(inSession(spec, ist('2026-11-29', '1000'))).toBe(false)
    expect(inSession(spec, ist('2026-11-29', '1830'))).toBe(true)
  })

  test('CRYPTO is in session at any hour of any day', () => {
    const crypto = DEFAULT_CALENDARS.CRYPTO
    if (!crypto) throw new Error('no CRYPTO')
    expect(inSession(crypto, ist('2026-11-29', '0300'))).toBe(true)
    expect(inSession(crypto, ist('2026-11-27', '2359'))).toBe(true)
  })

  test("the defaults are every exchange's default hours, with no holidays", () => {
    expect(Object.keys(DEFAULT_CALENDARS).sort()).toEqual(
      DEFAULT_TIMINGS.map((r) => r.exchange).sort(),
    )
    expect(DEFAULT_CALENDARS.MCX).toEqual(calendarSpec('MCX', DEFAULT_TIMINGS, []))
  })
})

describe('yearsAround', () => {
  test('January asks the previous year too, December the next', () => {
    expect(yearsAround('2026-01-05')).toEqual([2025, 2026])
    expect(yearsAround('2026-12-31')).toEqual([2026, 2027])
    expect(yearsAround('2026-06-15')).toEqual([2026])
  })
})

describe('loadCalendars', () => {
  test('an IST server today: server source, one timings call, nine exchanges', async () => {
    const { api, calls } = fakeApi({ '2026-11-27': serverRows('2026-11-27') })
    const r = await loadCalendars(api, NOW)
    expect(r.source).toBe('server')
    expect(Object.keys(r.calendars)).toEqual([
      'NSE',
      'BSE',
      'NFO',
      'BFO',
      'CDS',
      'BCD',
      'MCX',
      'NCO',
      'CRYPTO',
    ])
    expect(timingsCalls(calls)).toHaveLength(1)
    expect(calls.filter((c) => c.id === 'market/holidays').map((c) => c.body)).toEqual([
      { year: 2026 },
    ])
  })

  test('a UTC server: every exchange comes out at its IST hours', async () => {
    const { api } = fakeApi({ '2026-11-27': serverRows('2026-11-27', 19_800_000) })
    const r = await loadCalendars(api, NOW)
    expect(r.source).toBe('server')
    expect(r.calendars.NSE?.sessions).toEqual(['0915-1530:23456'])
    expect(r.calendars.MCX?.sessions).toEqual(['0900-2355:23456'])
  })

  test('a Saturday walks back to Friday; at most 3 timings calls', async () => {
    const sat = Date.UTC(2026, 10, 28, 5, 0)
    const { api, calls } = fakeApi({ '2026-11-27': serverRows('2026-11-27') })
    expect((await loadCalendars(api, sat)).source).toBe('server')
    expect(timingsCalls(calls).map((c) => c.body.date)).toEqual(['2026-11-27'])

    // a weekday whose replies hold no NSE or BSE row: stop after three calls
    const empty = fakeApi({
      '2026-11-27': [],
      '2026-11-26': [],
      '2026-11-25': [],
      '2026-11-24': serverRows('2026-11-24'),
    })
    expect((await loadCalendars(empty.api, NOW)).source).toBe('defaults')
    expect(timingsCalls(empty.calls).map((c) => c.body.date)).toEqual([
      '2026-11-27',
      '2026-11-26',
      '2026-11-25',
    ])
  })

  test('the walk-back skips a holiday and a special session without a call', async () => {
    const { api, calls } = fakeApi(
      { '2026-11-25': serverRows('2026-11-25') },
      {
        2026: [
          {
            date: '2026-11-27',
            holiday_type: 'TRADING_HOLIDAY',
            closed_exchanges: ['NSE'],
            open_exchanges: [],
          },
          {
            date: '2026-11-26',
            holiday_type: 'SPECIAL_SESSION',
            closed_exchanges: [],
            open_exchanges: [],
          },
        ],
      },
    )
    const r = await loadCalendars(api, NOW)
    expect(r.source).toBe('server')
    expect(timingsCalls(calls).map((c) => c.body.date)).toEqual(['2026-11-25'])
    expect(r.calendars.NSE?.exceptions).toEqual({ '2026-11-27': [], '2026-11-26': [] })
  })

  test('timings Unsupported or failing: defaults', async () => {
    const unsupported = fakeApi({
      '2026-11-27': () => {
        throw new ApiError({ kind: 'Unsupported', status: 404, endpoint: 'market/timings' })
      },
    })
    const a = await loadCalendars(unsupported.api, NOW)
    expect(a.source).toBe('defaults')
    expect(a.calendars.NFO?.sessions).toEqual(['0915-1540:23456'])
    const network = fakeApi({
      '2026-11-27': () => {
        throw new ApiError({ kind: 'Network', status: 0, endpoint: 'market/timings' })
      },
    })
    expect((await loadCalendars(network.api, NOW)).source).toBe('defaults')
  })

  test('holidays failing: defaults', async () => {
    const { api } = fakeApi(
      { '2026-11-27': serverRows('2026-11-27') },
      {
        2026: () => {
          throw new ApiError({ kind: 'Server', status: 500, endpoint: 'market/holidays' })
        },
      },
    )
    expect((await loadCalendars(api, NOW)).source).toBe('defaults')
  })

  test('edited NSE hours on a skewed server: defaults', async () => {
    const { api } = fakeApi({
      '2026-11-27': [nseRow('2026-11-27', 33_300_000, 54_000_000, 19_800_000)],
    })
    expect((await loadCalendars(api, NOW)).source).toBe('defaults')
  })

  test('an exchange missing from the reply takes its default row', async () => {
    const { api } = fakeApi({
      '2026-11-27': serverRows('2026-11-27').filter(
        (r) => r.exchange !== 'CRYPTO' && r.exchange !== 'NCO',
      ),
    })
    const r = await loadCalendars(api, NOW)
    expect(r.source).toBe('server')
    expect(r.calendars.CRYPTO?.timezone).toBe('UTC')
    expect(r.calendars.NCO?.sessions).toEqual(['0900-2355:23456'])
  })

  test('a row with null times takes its default; the other rows stay as the server sent them', async () => {
    // Before the timings rows were lenient, this one row failed the whole read: every exchange
    // fell to the defaults, CDS's edited 10:00-15:00 among them.
    const rows = serverRows('2026-11-27').map((r) =>
      r.exchange === 'MCX'
        ? { exchange: 'MCX', start_time: null, end_time: null }
        : r.exchange === 'CDS'
          ? { ...nseRow('2026-11-27', 36_000_000, 54_000_000), exchange: 'CDS' }
          : r,
    )
    const { api } = fakeApi({ '2026-11-27': rows })
    const r = await loadCalendars(api, NOW)
    expect(r.source).toBe('server')
    expect(r.calendars.MCX?.sessions).toEqual(['0900-2355:23456'])
    expect(r.calendars.CDS?.sessions).toEqual(['1000-1500:23456'])
    expect(r.calendars.NSE?.sessions).toEqual(['0915-1530:23456'])
  })

  test('January asks the previous year too', async () => {
    const jan = Date.UTC(2027, 0, 5, 5, 0)
    const { api, calls } = fakeApi({ '2027-01-05': serverRows('2027-01-05') })
    await loadCalendars(api, jan)
    expect(calls.filter((c) => c.id === 'market/holidays').map((c) => c.body.year)).toEqual([
      2026, 2027,
    ])
  })

  test('the replies parse through the schemas', () => {
    expect(HolidaysSchema.parse({ status: 'success', data: [] })).toEqual([])
  })
})
