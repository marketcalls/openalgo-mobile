import { expectLog, keepExpectedLogs } from '../../test/helpers/consoleLogs'
import { INDEX_OPTION_UNDERLYINGS, optionChainTarget, stockHasOptions } from './optionChain'

beforeEach(() => keepExpectedLogs())
afterEach(() => jest.restoreAllMocks())

const target = (exchange: string, symbol: string, name = symbol) =>
  optionChainTarget({ exchange, symbol, name })

describe('optionChainTarget', () => {
  test.each([
    ['NSE_INDEX', 'NIFTY'],
    ['NSE_INDEX', 'BANKNIFTY'],
    ['NSE_INDEX', 'FINNIFTY'],
    ['NSE_INDEX', 'MIDCPNIFTY'],
    ['NSE_INDEX', 'NIFTYNXT50'],
    ['BSE_INDEX', 'SENSEX'],
    ['BSE_INDEX', 'BANKEX'],
    ['BSE_INDEX', 'SENSEX50'],
  ])('a listed index (%s %s) opens its own chain', (exchange, symbol) => {
    expect(target(exchange, symbol, `${symbol} index`)).toEqual({ exchange, symbol })
  })

  test('an index without options, or listed on the other exchange, has none', () => {
    expect(target('NSE_INDEX', 'INDIAVIX')).toBeNull()
    expect(target('NSE_INDEX', 'SENSEX')).toBeNull()
    expect(target('BSE_INDEX', 'NIFTY')).toBeNull()
  })

  test('an NSE stock has none until the symbol master can tell which have options', () => {
    expect(target('NSE', 'RELIANCE', 'RELIANCE INDUSTRIES')).toBeNull()
  })

  test("an NFO contract opens its underlying's chain: an index's, else the stock's", () => {
    expect(target('NFO', 'NIFTY30DEC26FUT', 'NIFTY')).toEqual({
      exchange: 'NSE_INDEX',
      symbol: 'NIFTY',
    })
    expect(target('NFO', 'BANKNIFTY30DEC2652000CE', 'BANKNIFTY')).toEqual({
      exchange: 'NSE_INDEX',
      symbol: 'BANKNIFTY',
    })
    expect(target('NFO', 'RELIANCE30DEC26FUT', 'RELIANCE')).toEqual({
      exchange: 'NSE',
      symbol: 'RELIANCE',
    })
  })

  test('a BFO contract opens a BSE index chain, and nothing else', () => {
    expect(target('BFO', 'SENSEX30DEC26FUT', 'SENSEX')).toEqual({
      exchange: 'BSE_INDEX',
      symbol: 'SENSEX',
    })
    expect(target('BFO', 'RELIANCE30DEC26FUT', 'RELIANCE')).toBeNull()
  })

  test.each([
    ['MCX', 'CRUDEOIL19DEC26FUT', 'CRUDEOIL'],
    ['CDS', 'USDINR26DEC26FUT', 'USDINR'],
    ['CRYPTO', 'BTCUSDFUT', 'BTCUSD'],
  ])('%s opens the chain of its own underlying', (exchange, symbol, name) => {
    expect(target(exchange, symbol, name)).toEqual({ exchange, symbol: name })
  })

  test.each([
    ['BSE', 'RELIANCE'],
    ['BCD', 'USDINR26DEC26FUT'],
    ['NCDEX', 'GUARSEED26DECFUT'],
    ['NCO', 'NATGAS26DECFUT'],
    ['MCX_INDEX', 'MCXCOMDEX'],
    ['GLOBAL_INDEX', 'DJI'],
  ])('%s has none', (exchange, symbol) => {
    expect(target(exchange, symbol, 'X')).toBeNull()
  })

  test('a derivative without a name has none', () => {
    expect(target('NFO', 'X30DEC26FUT', '')).toBeNull()
    expect(target('MCX', 'X19DEC26FUT', '')).toBeNull()
  })

  test('the index underlyings are the listed ones', () => {
    expect(INDEX_OPTION_UNDERLYINGS).toEqual({
      NSE_INDEX: ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'],
      BSE_INDEX: ['SENSEX', 'BANKEX', 'SENSEX50'],
    })
  })
})

describe('stockHasOptions (useOptionChainTarget for an NSE stock)', () => {
  const deps = (listed: boolean | null, expiries: () => Promise<string[]>) => ({
    master: { hasOptions: jest.fn(async () => listed) },
    options: { expiries: jest.fn(expiries) },
  })

  test('the symbol master answers when it is stored, with no read', async () => {
    const yes = deps(true, async () => [])
    expect(await stockHasOptions(yes, 'RELIANCE')).toBe(true)
    expect(yes.master.hasOptions).toHaveBeenCalledWith('NFO', 'RELIANCE')
    const no = deps(false, async () => ['30-DEC-26'])
    expect(await stockHasOptions(no, 'IDEA')).toBe(false)
    expect(yes.options.expiries).not.toHaveBeenCalled()
    expect(no.options.expiries).not.toHaveBeenCalled()
  })

  test("without a master, the day's expiry read decides: listed expiries mean options", async () => {
    const listed = deps(null, async () => ['30-DEC-26'])
    expect(await stockHasOptions(listed, 'RELIANCE')).toBe(true)
    expect(listed.options.expiries).toHaveBeenCalledWith('NFO', 'RELIANCE', 'options')
    expect(
      await stockHasOptions(
        deps(null, async () => []),
        'IDEA',
      ),
    ).toBe(false)
  })

  test('a failed read offers no chain', async () => {
    const warned = expectLog('warn', /option chain check for RELIANCE failed/)
    const failing = deps(null, async () => {
      throw new Error('down')
    })
    expect(await stockHasOptions(failing, 'RELIANCE')).toBe(false)
    expect(warned).toHaveLength(1)
  })
})
