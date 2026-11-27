// The helpers plan F's series routes share (series.ts, reference.ts, intervals.ts), held to the
// server's own: strategy_chart_service.py's window and cap, option_symbol_service.py's ATM and
// symbol, strategy_builder_reference_service.py's reference and the tool blueprints' intervals.
import { QueryClient } from '@tanstack/react-query'
import type { Api } from '~/core/http/api'
import { type HistoryRow, IntervalsSchema } from '~/market/chart/schemas'
import type { MasterRow } from '~/market/master/db'
import { testRouteDeps } from '../../../test/helpers/routeDeps'
import { intervalsReply } from './intervals'
import { BSE_INDEX, NO_SPOT, NSE_INDEX, quoteExchange, resolveReference } from './reference'
import {
  capLastNDates,
  closesByTime,
  istDay,
  nearestStrike,
  optionSymbol,
  tradingWindow,
  tsSeconds,
} from './series'

/** Epoch seconds of an IST wall-clock time in November 2026. */
const ist = (day: number, hh: number, mm = 0) => Date.UTC(2026, 10, day, hh, mm) / 1000 - 19_800

const candle = (timestamp: number, close: number): HistoryRow => ({
  timestamp,
  open: close,
  high: close,
  low: close,
  close,
})

/** A fake Api that answers each endpoint with `replies[id]` and notes every call. */
function fakeApi(replies: Record<string, unknown>) {
  const calls: { id: string; body: unknown }[] = []
  const api: Pick<Api, 'call'> = {
    async call(id, body, schema) {
      calls.push({ id, body })
      if (!(id in replies)) throw new Error(`no reply for ${id}`)
      return schema.parse(replies[id])
    },
  }
  return { api, calls }
}

describe('series', () => {
  test('tsSeconds reads a time over 1e12 as ms; istDay is its IST date; closesByTime keys closes by second, ascending', () => {
    expect(tsSeconds(ist(27, 9, 15))).toBe(ist(27, 9, 15))
    expect(tsSeconds(ist(27, 9, 15) * 1000 + 999)).toBe(ist(27, 9, 15))
    // 23:59 IST is still that day; 00:00 IST is the next, though both are the same UTC date
    expect(istDay(ist(29, 23, 59))).toBe('2026-11-29')
    expect(istDay(ist(30, 0, 0))).toBe('2026-11-30')
    const t = ist(27, 9, 15)
    const closes = closesByTime([
      candle(t + 120, 3),
      candle((t + 60) * 1000, 2),
      candle(t, 1),
      // a repeated time: the later row, as the services' dict does
      candle(t + 120, 4),
    ])
    expect([...closes]).toEqual([
      [t, 1],
      [t + 60, 2],
      [t + 120, 4],
    ])
  })

  test('tradingWindow(3) at 02:16 IST on a Monday runs 11 days back to today', () => {
    const monday = ist(30, 2, 16) * 1000
    expect(tradingWindow(3, monday)).toEqual({ start_date: '2026-11-19', end_date: '2026-11-30' })
    // max(2, 3·days + 2) calendar days
    expect(tradingWindow(1, monday)).toEqual({ start_date: '2026-11-25', end_date: '2026-11-30' })
    expect(tradingWindow(0, monday)).toEqual({ start_date: '2026-11-28', end_date: '2026-11-30' })
    expect(tradingWindow(-4, monday)).toEqual({ start_date: '2026-11-28', end_date: '2026-11-30' })
    // the day before at 23:59 IST is still Sunday
    expect(tradingWindow(3, ist(29, 23, 59) * 1000).end_date).toBe('2026-11-29')
  })

  test('capLastNDates keeps the last N IST dates; a 24×7 crypto series keeps its weekend', () => {
    // Thu, Fri, then Mon; 00:10 IST Monday is still Sunday in UTC
    const week = [
      { time: ist(26, 9, 15), v: 1 },
      { time: ist(27, 15, 29), v: 2 },
      { time: ist(26, 15, 29), v: 3 },
      { time: ist(30, 0, 10), v: 4 },
      { time: ist(27, 9, 15), v: 5 },
      { time: ist(30, 9, 15), v: 6 },
    ]
    expect(capLastNDates(week, 2).map((r) => r.v)).toEqual([2, 4, 5, 6])
    expect(capLastNDates(week, 3)).toEqual(week)
    expect(capLastNDates(week, 9)).toEqual(week)
    expect(capLastNDates(week, 0)).toEqual(week)
    expect(capLastNDates([], 3)).toEqual([])

    const crypto = [27, 28, 29].flatMap((day) => [
      { time: ist(day, 3), day },
      { time: ist(day, 21), day },
    ])
    expect(capLastNDates(crypto, 2).map((r) => r.day)).toEqual([28, 28, 29, 29])
  })

  test('nearestStrike takes the first of two equal distances and refuses NaN', () => {
    expect(nearestStrike(24_031, [23_950, 24_000, 24_050, 24_100])).toBe(24_050)
    expect(nearestStrike(24_025, [23_950, 24_000, 24_050, 24_100])).toBe(24_000)
    expect(nearestStrike(24_025, [24_050, 24_000])).toBe(24_050)
    expect(nearestStrike(10, [24_000, 24_050])).toBe(24_000)
    // option_symbol_service.py _is_finite_number: no ATM from a price that is not one
    expect(nearestStrike(Number.NaN, [24_000])).toBeNull()
    expect(nearestStrike(Number.POSITIVE_INFINITY, [24_000])).toBeNull()
    expect(nearestStrike(24_000, [])).toBeNull()
  })

  test('optionSymbol: NIFTY28NOV2424000CE, USDINR28NOV2483.5CE', () => {
    expect(optionSymbol('NIFTY', '28NOV24', 24_000, 'CE')).toBe('NIFTY28NOV2424000CE')
    expect(optionSymbol('USDINR', '28NOV24', 83.5, 'CE')).toBe('USDINR28NOV2483.5CE')
    expect(optionSymbol('CRUDEOIL', '16DEC26', 6_750.25, 'PE')).toBe('CRUDEOIL16DEC266750.25PE')
    expect(optionSymbol('BTC', '28FEB25', 80_000, 'PE')).toBe('BTC28FEB2580000PE')
  })
})

describe('reference', () => {
  test("the index lists and the no-spot venues are the services' own", () => {
    expect(NSE_INDEX).toEqual([
      'NIFTY',
      'BANKNIFTY',
      'FINNIFTY',
      'MIDCPNIFTY',
      'NIFTYNXT50',
      'NIFTYIT',
      'NIFTYPHARMA',
      'NIFTYBANK',
    ])
    expect(BSE_INDEX).toEqual(['SENSEX', 'BANKEX', 'SENSEX50'])
    expect(NO_SPOT).toEqual(['MCX', 'CDS', 'BCD', 'NCDEX', 'NCO'])
  })

  test('quoteExchange: NIFTYIT → NSE_INDEX; RELIANCE on NFO → NSE; SENSEX → BSE_INDEX', () => {
    expect(quoteExchange('NIFTYIT', 'NFO')).toBe('NSE_INDEX')
    expect(quoteExchange('RELIANCE', 'NFO')).toBe('NSE')
    expect(quoteExchange('SENSEX', 'BFO')).toBe('BSE_INDEX')
    expect(quoteExchange('RELIANCE', 'bfo')).toBe('BSE')
    expect(quoteExchange('NIFTY', 'NSE_INDEX')).toBe('NSE_INDEX')
    expect(quoteExchange('CRUDEOIL', 'mcx')).toBe('MCX')
    expect(quoteExchange('BTC', 'CRYPTO')).toBe('CRYPTO')
  })

  test('resolveReference: the chain pair wins; CRUDEOIL on MCX → its near FUT; BTC → BTCUSDFUT; no futures → null (RF 4)', async () => {
    const expiries = jest.fn(async (exchange: string, underlying: string, type: string) =>
      exchange === 'MCX' && underlying === 'CRUDEOIL' && type === 'futures'
        ? ['19-DEC-26', '19-JAN-27']
        : [],
    )
    const d = testRouteDeps({ options: { expiries } })

    // a 2.0.2.0 chain names its underlying: it wins, trimmed and upper-cased
    expect(
      await resolveReference('NIFTY', 'NFO', d, { symbol: ' nifty ', exchange: 'nse_index' }),
    ).toEqual({ symbol: 'NIFTY', exchange: 'NSE_INDEX' })
    expect(
      await resolveReference('CRUDEOIL', 'MCX', d, {
        symbol: 'CRUDEOIL19DEC26FUT',
        exchange: 'MCX',
      }),
    ).toEqual({ symbol: 'CRUDEOIL19DEC26FUT', exchange: 'MCX' })
    expect(expiries).not.toHaveBeenCalled()

    // 2.0.0.0: the index map, the stock's own exchange, or the near-month future
    expect(await resolveReference('NIFTY', 'NFO', d, { symbol: 'NIFTY' })).toEqual({
      symbol: 'NIFTY',
      exchange: 'NSE_INDEX',
    })
    expect(await resolveReference(' reliance ', 'nfo', d)).toEqual({
      symbol: 'RELIANCE',
      exchange: 'NSE',
    })
    expect(await resolveReference('SENSEX', 'BFO', d)).toEqual({
      symbol: 'SENSEX',
      exchange: 'BSE_INDEX',
    })
    expect(await resolveReference('crudeoil', 'MCX', d)).toEqual({
      symbol: 'CRUDEOIL19DEC26FUT',
      exchange: 'MCX',
    })
    expect(expiries).toHaveBeenLastCalledWith('MCX', 'CRUDEOIL', 'futures')
    expect(await resolveReference('GOLD', 'MCX', d)).toBeNull()
    expect(await resolveReference('USDINR', 'CDS', d)).toBeNull()

    // CRYPTO: the perpetual, as fno_search_symbols finds `${base}USDFUT` (PERPFUT only)
    const perp = (symbol: string, itype = 'PERPFUT'): MasterRow => ({
      symbol,
      name: symbol.replace(/FUT$/, ''),
      exchange: 'CRYPTO',
      expiry: '',
      strike: 0,
      lotsize: 1,
      tick: 0.5,
      itype,
      underlying: symbol,
    })
    const futures = jest.fn(async () => [
      perp('ETHUSDFUT'),
      perp('BTC28FEB25FUT', 'FUT'),
      perp('BTCUSDFUT'),
    ])
    const crypto = testRouteDeps({ master: { futures } })
    expect(await resolveReference('btc', 'crypto', crypto)).toEqual({
      symbol: 'BTCUSDFUT',
      exchange: 'CRYPTO',
    })
    expect(futures).toHaveBeenCalledWith('CRYPTO')
    expect(await resolveReference('SOL', 'CRYPTO', crypto)).toBeNull()

    // no master stored: the server's search
    const search = fakeApi({
      search: {
        status: 'success',
        data: [
          { symbol: 'BTC28FEB25FUT', exchange: 'CRYPTO', instrumenttype: 'FUT' },
          { symbol: 'BTCUSDFUT', name: 'BTCUSD', exchange: 'CRYPTO', instrumenttype: 'PERPFUT' },
        ],
      },
    })
    expect(await resolveReference('BTC', 'CRYPTO', testRouteDeps({ api: search.api }))).toEqual({
      symbol: 'BTCUSDFUT',
      exchange: 'CRYPTO',
    })
    expect(search.calls).toEqual([
      { id: 'search', body: { query: 'BTCUSDFUT', exchange: 'CRYPTO' } },
    ])
  })
})

describe('intervals', () => {
  test('one /intervals read serves the oiprofile, intraday and raw replies', async () => {
    const data = {
      seconds: ['5s', '10s'],
      minutes: ['1m', '3m', '5m', '10m', '15m', '30m'],
      hours: ['1h'],
      days: ['D'],
      weeks: ['W'],
      months: ['M'],
    }
    const { api, calls } = fakeApi({ intervals: { status: 'success', data } })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // as the tool screen reads it: one query, as plan D's intervals query keeps it
    const d = testRouteDeps({
      api,
      intervals: () =>
        queryClient.fetchQuery({
          queryKey: ['intervals'],
          queryFn: () => api.call('intervals', {}, IntervalsSchema),
          staleTime: Number.POSITIVE_INFINITY,
          gcTime: Number.POSITIVE_INFINITY,
        }),
    })
    expect(await intervalsReply('oiprofile', d)).toEqual({
      status: 'success',
      data: { intervals: ['1m', '5m', '15m'] },
    })
    expect(await intervalsReply('intraday', d)).toEqual({
      status: 'success',
      data: { seconds: ['5s', '10s'], minutes: data.minutes, hours: ['1h'] },
    })
    expect(await intervalsReply('raw', d)).toEqual({ status: 'success', data })
    expect(calls.map((c) => c.id)).toEqual(['intervals'])

    // a broker with minutes only: the intraday groups it lacks are empty, its own order kept
    const few = testRouteDeps({ intervals: async () => ({ minutes: ['15m', '1m', '2m'] }) })
    expect(await intervalsReply('intraday', few)).toEqual({
      status: 'success',
      data: { seconds: [], minutes: ['15m', '1m', '2m'], hours: [] },
    })
    expect(await intervalsReply('oiprofile', few)).toEqual({
      status: 'success',
      data: { intervals: ['15m', '1m'] },
    })
  })
})
