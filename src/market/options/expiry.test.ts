import { goldenCases } from '../../../test/helpers/golden'
import { spotGreeks, withGreeksChain } from './black76'
import {
  EXPIRY_CUTOFF_IST,
  expiryInstantMs,
  optionsExchangeOf,
  parseOptionSymbol,
  serverYears,
  toDashed,
  toDdmmmyy,
} from './expiry'

const MIN = 60_000
const pad = (n: number) => String(n).padStart(2, '0')
/** An IST wall-clock time as epoch ms, parsed from an ISO time at +05:30. */
const ist = (y: number, mo: number, d: number, h: number, mi: number) =>
  Date.parse(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00+05:30`)

test('cut-offs: NFO 15:30, CDS 12:30, MCX 23:30 IST', () => {
  expect(EXPIRY_CUTOFF_IST).toEqual({ MCX: [23, 30], CDS: [12, 30] })
  expect(expiryInstantMs('28NOV25', 'NFO')).toBe(Date.parse('2025-11-28T10:00:00Z'))
  expect(expiryInstantMs('28NOV25', 'NFO')).toBe(ist(2025, 11, 28, 15, 30))
  expect(expiryInstantMs('28NOV25', 'BFO')).toBe(ist(2025, 11, 28, 15, 30))
  expect(expiryInstantMs('28NOV25', 'CDS')).toBe(ist(2025, 11, 28, 12, 30))
  expect(expiryInstantMs('28NOV25', 'MCX')).toBe(ist(2025, 11, 28, 23, 30))
  // Any other exchange follows the equity-derivatives session, as get_exchange_expiry_time does.
  expect(expiryInstantMs('28NOV25', 'CRYPTO')).toBe(ist(2025, 11, 28, 15, 30))
  expect(expiryInstantMs('28NOV25', 'constructor')).toBe(ist(2025, 11, 28, 15, 30))
  expect(expiryInstantMs('28-NOV-25', 'NFO')).toBe(ist(2025, 11, 28, 15, 30))
})

test('an expiry that is not a calendar date has no instant', () => {
  expect(expiryInstantMs('31NOV25', 'NFO')).toBeNull()
  expect(expiryInstantMs('00DEC25', 'NFO')).toBeNull()
  expect(expiryInstantMs('29FEB25', 'NFO')).toBeNull()
  expect(expiryInstantMs('29FEB28', 'NFO')).toBe(ist(2028, 2, 29, 15, 30))
  expect(expiryInstantMs('28XYZ25', 'NFO')).toBeNull()
  expect(expiryInstantMs('2025-11-28', 'NFO')).toBeNull()
})

test('expiries convert between DD-MMM-YY and DDMMMYY', () => {
  expect(toDdmmmyy('28-NOV-25')).toBe('28NOV25')
  expect(toDdmmmyy('28NOV25')).toBe('28NOV25')
  expect(toDdmmmyy(' 28-nov-25 ')).toBe('28NOV25')
  expect(toDashed('28NOV25')).toBe('28-NOV-25')
  expect(toDashed('28-NOV-25')).toBe('28-NOV-25')
  for (const bad of [
    '',
    '28-NOV-2025',
    '2NOV25',
    '28NOV5',
    '28-XYZ-25',
    '28/NOV/25',
    '28NOV25FUT',
  ]) {
    expect(toDdmmmyy(bad)).toBeNull()
    expect(toDashed(bad)).toBeNull()
  }
})

test('symbols parse: NIFTY28NOV2424000CE, USDINR28NOV2483.50CE, M&M28NOV241500PE, BAJAJ-AUTO…', () => {
  expect(parseOptionSymbol('NIFTY28NOV2424000CE')).toEqual({
    underlying: 'NIFTY',
    expiry: '28NOV24',
    strike: 24000,
    type: 'CE',
  })
  expect(parseOptionSymbol('USDINR28NOV2483.50CE')).toEqual({
    underlying: 'USDINR',
    expiry: '28NOV24',
    strike: 83.5,
    type: 'CE',
  })
  expect(parseOptionSymbol('M&M28NOV241500PE')).toMatchObject({ underlying: 'M&M', strike: 1500 })
  expect(parseOptionSymbol('BAJAJ-AUTO28NOV249000PE')).toEqual({
    underlying: 'BAJAJ-AUTO',
    expiry: '28NOV24',
    strike: 9000,
    type: 'PE',
  })
  expect(parseOptionSymbol('NIFTYNXT5028NOV2470000CE')).toMatchObject({
    underlying: 'NIFTYNXT50',
    strike: 70000,
  })
  expect(parseOptionSymbol('SENSEX24DEC2680000CE')).toMatchObject({ underlying: 'SENSEX' })
  // parse_option_symbol upper-cases the symbol first.
  expect(parseOptionSymbol('nifty28nov2424000ce')).toMatchObject({ underlying: 'NIFTY' })
})

test('what parse_option_symbol refuses does not parse', () => {
  for (const bad of [
    'NIFTY24000CE',
    'NIFTY28XYZ2424000CE',
    'NIFTY28NOV2424000CEX',
    'NIFTY28NOV2424000XE',
    'NIFTY28NOV241.2.3CE',
    'NIFTY28NOV24.CE',
    'NIFTY31NOV2424000CE',
    'NIFTY28NOV24FUT',
    '',
  ]) {
    expect(parseOptionSymbol(bad)).toBeNull()
  }
})

test('the options exchange of an underlying, as the services derive it', () => {
  expect(optionsExchangeOf('NSE')).toBe('NFO')
  expect(optionsExchangeOf('NSE_INDEX')).toBe('NFO')
  expect(optionsExchangeOf('BSE')).toBe('BFO')
  expect(optionsExchangeOf('BSE_INDEX')).toBe('BFO')
  expect(optionsExchangeOf('nse_index')).toBe('NFO')
  for (const same of ['NFO', 'BFO', 'MCX', 'CDS', 'CRYPTO'])
    expect(optionsExchangeOf(same)).toBe(same)
})

test('serverYears floors at 1e-4 before the cut-off and is 0 after it', () => {
  const cutoff = ist(2026, 12, 29, 15, 30)
  // calculate_time_to_expiry: days = seconds / 86400, years = days / 365.
  expect(serverYears(cutoff, cutoff - 7 * 24 * 60 * MIN)).toEqual({ years: 7 / 365, days: 7 })
  const twoHours = serverYears(cutoff, cutoff - 120 * MIN)
  expect(twoHours).toEqual({ years: 7200 / 86400 / 365, days: 7200 / 86400 })
  // Under about 53 minutes the server uses its 1e-4 floor, days included.
  expect(serverYears(cutoff, cutoff - 30 * MIN)).toEqual({ years: 1e-4, days: 1e-4 * 365 })
  // At the cut-off itself the option has not yet expired (expiry < now is false).
  expect(serverYears(cutoff, cutoff)).toEqual({ years: 1e-4, days: 1e-4 * 365 })
  expect(serverYears(cutoff, cutoff + 1)).toEqual({ years: 0, days: 0 })
  expect(serverYears(cutoff, cutoff + 60 * MIN)).toEqual({ years: 0, days: 0 })
})

test('expiry day after the cut-off: every spot leg is null and withGreeksChain is all null (RF 1)', () => {
  const [golden] = goldenCases()
  if (!golden) throw new Error('no golden case recorded')
  const { input, expected } = golden
  const exchange = optionsExchangeOf(input.exchange)
  const cutoff = expiryInstantMs(input.expiry, exchange)
  if (cutoff === null) throw new Error(`bad golden expiry ${input.expiry}`)
  const nowMs = cutoff + MIN
  expect(expected.legs.length).toBeGreaterThan(0)
  for (const leg of expected.legs) {
    expect(spotGreeks({ ...leg, nowMs })).toBeNull()
    // A minute before the cut-off the same leg still prices (from the 1e-4 floor).
    expect(spotGreeks({ ...leg, nowMs: cutoff - MIN })).not.toBeNull()
  }
  const { years } = serverYears(cutoff, nowMs)
  expect(years).toBe(0)
  const rows = expected.withGreeks.rows.map((r) => ({
    strike: r.strike,
    ce: { ltp: 100 },
    pe: { ltp: 100 },
  }))
  const out = withGreeksChain(rows, { forward: expected.withGreeks.forward, years })
  expect(out).toEqual(rows.map(() => ({ ce: null, pe: null })))
})
