import type { KeyedApi } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import { DEFAULT_UNDERLYINGS } from '~/market/tools/registry'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { parseInstrumentsCsv } from './csv'
import type { MasterDb, MasterRow } from './db'
import { createSymbolMaster, MASTER_EXCHANGES, MIN_OPTION_ROWS, RETRY_AFTER_MS } from './master'
import { createMemoryMasterDb } from './memoryDb'
import { openMasterDb } from './sqlite'
import { extractUnderlying } from './underlying'

// expo-sqlite over node:sqlite (one in-memory database), so sqlite.ts's own SQL runs here. A
// transaction shares the connection: sqlite.ts runs one writer at a time.
jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = require('node:sqlite')
  const raw = new DatabaseSync(':memory:')
  const opened: string[] = []
  const list = (params?: unknown[]) => params ?? []
  const plain = (row: unknown) => (row ? { ...(row as object) } : null)
  const conn = {
    async execAsync(sql: string) {
      raw.exec(sql)
    },
    async runAsync(sql: string, params?: unknown[]) {
      const r = raw.prepare(sql).run(...list(params))
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }
    },
    async getAllAsync(sql: string, params?: unknown[]) {
      return raw
        .prepare(sql)
        .all(...list(params))
        .map(plain)
    },
    async getFirstAsync(sql: string, params?: unknown[]) {
      return plain(raw.prepare(sql).get(...list(params)))
    },
    async prepareAsync(sql: string) {
      const st = raw.prepare(sql)
      return {
        async executeAsync(params?: unknown[]) {
          st.run(...list(params))
          return {}
        },
        async finalizeAsync() {},
      }
    },
  }
  return {
    __raw: raw,
    __opened: opened,
    async openDatabaseAsync(name: string) {
      opened.push(name)
      return {
        ...conn,
        async withExclusiveTransactionAsync(task: (txn: typeof conn) => Promise<void>) {
          raw.exec('BEGIN')
          try {
            await task(conn)
            raw.exec('COMMIT')
          } catch (e) {
            raw.exec('ROLLBACK')
            throw e
          }
        },
      }
    },
  }
})

type RawDb = { prepare(sql: string): { all(...p: unknown[]): unknown[]; get(): unknown } }
const sqliteMock = () => jest.requireMock('expo-sqlite') as { __raw: RawDb; __opened: string[] }

const PID = 'p1'
// 10:30 IST on 2026-11-24, and the same time the next day
const DAY1 = Date.UTC(2026, 10, 24, 5, 0)
const DAY2 = DAY1 + 86_400_000

beforeEach(() => keepExpectedLogs())
afterEach(() => jest.restoreAllMocks())

// --- the CSV, as services/instruments_service.py writes it with csv.DictWriter -----------------

const COLUMNS = [
  'symbol',
  'brsymbol',
  'name',
  'exchange',
  'brexchange',
  'token',
  'expiry',
  'strike',
  'lotsize',
  'instrumenttype',
  'tick_size',
] as const
type CsvRow = Partial<Record<(typeof COLUMNS)[number], string | number>>

const cell = (v: string | number | undefined) => {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}
const csvOf = (rows: readonly CsvRow[], cols: readonly string[] = COLUMNS) =>
  `${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c as keyof CsvRow])).join(','))].join('\r\n')}\r\n`

/** `n` option rows of `u` (alternating CE and PE) on `exchange`. */
function options(u: string, n: number, exchange = 'NFO'): CsvRow[] {
  return Array.from({ length: n }, (_, i) => {
    const type = i % 2 ? 'PE' : 'CE'
    const strike = 1000 + 10 * Math.floor(i / 2)
    return {
      symbol: `${u}30DEC26${strike}${type}`,
      name: u,
      exchange,
      expiry: '30-DEC-26',
      strike: `${strike}.0`,
      lotsize: 50,
      instrumenttype: type,
      tick_size: 0.05,
    }
  })
}
const future = (u: string, exchange = 'NFO'): CsvRow => ({
  symbol: `${u}30DEC26FUT`,
  name: u,
  exchange,
  expiry: '30-DEC-26',
  strike: '0.0',
  lotsize: 50,
  instrumenttype: 'FUT',
  tick_size: 0.1,
})

/** One option row of `u` at `expiry` (DD-MMM-YY). */
const option = (
  u: string,
  expiry: string,
  strike: number,
  type: 'CE' | 'PE',
  lotsize: number,
  exchange = 'NFO',
): CsvRow => ({
  symbol: `${u}${expiry.replaceAll('-', '')}${strike}${type}`,
  name: u,
  exchange,
  expiry,
  strike: `${strike}.0`,
  lotsize,
  instrumenttype: type,
  tick_size: 0.05,
})

/** A full master: NIFTY and RELIANCE options, TCS futures only. */
const FULL = csvOf([...options('NIFTY', 40), ...options('RELIANCE', 20), future('TCS')])

// --- a fake instruments GET ----------------------------------------------------------------------

type Reply = string | Error | Promise<string>

function setup(o: { db?: Promise<MasterDb> } = {}) {
  let t = DAY1
  const calls: { id: string; query: Record<string, string>; withKey?: boolean }[] = []
  const signals: (AbortSignal | undefined)[] = []
  const replies = new Map<string, Reply[]>()
  const api: Pick<KeyedApi, 'get'> = {
    async get(id, query, schema, opts) {
      calls.push({ id, query, withKey: opts?.withKey })
      signals.push(opts?.signal)
      const next = replies.get(query.exchange ?? '')?.shift()
      if (next === undefined) throw new Error(`no instruments reply queued for ${query.exchange}`)
      if (next instanceof Error) throw next
      return schema.parse(await next)
    },
  }
  const db = createMemoryMasterDb()
  const master = createSymbolMaster({
    api,
    db: o.db ?? Promise.resolve(db),
    pid: PID,
    now: () => t,
  })
  return {
    master,
    db,
    calls,
    signals,
    reply: (exchange: string, ...r: Reply[]) =>
      replies.set(exchange, [...(replies.get(exchange) ?? []), ...r]),
    setNow: (n: number) => {
      t = n
    },
    now: () => t,
  }
}

/** Lets every promise chain already started run to its next real wait. */
const settle = () => new Promise((r) => setTimeout(r, 0))

function deferred<T>() {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('parseInstrumentsCsv', () => {
  test('the CSV parses in batches and skips bad rows', async () => {
    // columns found by name, in any order; quoted cells with commas, quotes and a line break
    const cols = [
      'exchange',
      'tick_size',
      'symbol',
      'lotsize',
      'name',
      'strike',
      'expiry',
      'instrumenttype',
      'token',
    ]
    const text = csvOf(
      [
        {
          symbol: 'M&M30DEC261500CE',
          name: 'MAHINDRA, "M&M"',
          exchange: 'NFO',
          expiry: '30-DEC-26',
          strike: '1500.0',
          lotsize: 350,
          instrumenttype: 'CE',
          tick_size: 0.05,
        },
        { symbol: '', name: 'no symbol', exchange: 'NFO' },
        {
          symbol: 'BAJAJ-AUTO30DEC269000PE',
          name: 'BAJAJ\nAUTO',
          exchange: 'NFO',
          expiry: '30-DEC-26',
          strike: '9000.0',
          lotsize: 75,
          instrumenttype: 'PE',
          tick_size: 0.05,
        },
        { symbol: 'NOEXCHANGE30DEC26FUT', exchange: '' },
        {
          symbol: 'RELIANCE',
          name: 'RELIANCE INDUSTRIES',
          exchange: 'NSE',
          strike: '-1.0',
          lotsize: 1,
          instrumenttype: 'EQ',
          tick_size: 0.05,
        },
      ],
      cols,
    )
    const batches: MasterRow[][] = []
    const n = await parseInstrumentsCsv(text, async (rows) => void batches.push(rows), { batch: 2 })
    expect(n).toBe(3)
    expect(batches.map((b) => b.length)).toEqual([2, 1])
    expect(batches.flat()).toEqual([
      {
        symbol: 'M&M30DEC261500CE',
        name: 'MAHINDRA, "M&M"',
        exchange: 'NFO',
        expiry: '30-DEC-26',
        strike: 1500,
        lotsize: 350,
        tick: 0.05,
        itype: 'CE',
        underlying: 'M&M',
      },
      {
        symbol: 'BAJAJ-AUTO30DEC269000PE',
        name: 'BAJAJ\nAUTO',
        exchange: 'NFO',
        expiry: '30-DEC-26',
        strike: 9000,
        lotsize: 75,
        tick: 0.05,
        itype: 'PE',
        underlying: 'BAJAJ-AUTO',
      },
      {
        symbol: 'RELIANCE',
        name: 'RELIANCE INDUSTRIES',
        exchange: 'NSE',
        expiry: '',
        strike: -1,
        lotsize: 1,
        tick: 0.05,
        itype: 'EQ',
        underlying: null,
      },
    ])
  })

  test('2,000 rows go per batch, each batch awaited before the next is read', async () => {
    const text = csvOf(options('NIFTY', 4500))
    const sizes: number[] = []
    let open = 0
    const n = await parseInstrumentsCsv(text, async (rows) => {
      expect(open).toBe(0)
      open++
      await Promise.resolve()
      sizes.push(rows.length)
      open--
    })
    expect(n).toBe(4500)
    expect(sizes).toEqual([2000, 2000, 500])
  })

  test("a body that is not the CSV (the server's empty-table JSON) gives no rows", async () => {
    const onBatch = jest.fn(async () => {})
    const json = '{"data":[],"message":"No instruments found","status":"success"}\n'
    expect(await parseInstrumentsCsv(json, onBatch)).toBe(0)
    expect(await parseInstrumentsCsv('', onBatch)).toBe(0)
    expect(onBatch).not.toHaveBeenCalled()
  })
})

describe('extractUnderlying', () => {
  test.each([
    ['NIFTY28MAR2420800CE', 'NFO', 'NIFTY'],
    ['BANKNIFTY24APR24FUT', 'NFO', 'BANKNIFTY'],
    ['M&M30DEC261500CE', 'NFO', 'M&M'],
    ['BAJAJ-AUTO30DEC26FUT', 'NFO', 'BAJAJ-AUTO'],
    ['CRUDEOIL17APR246750.5CE', 'MCX', 'CRUDEOIL'],
    ['usdinr26dec2684pe', 'CDS', 'USDINR'],
    ['SENSEX08DEC2679000CE', 'BFO', 'SENSEX'],
    // no expiry in the symbol, or not an F&O exchange
    ['NIFTY', 'NFO', null],
    ['RELIANCE30DEC261500CE', 'NSE', null],
    ['', 'NFO', null],
    // CRYPTO: the run before DDMMMYY, else a perpetual's quote currency stripped
    ['BTC28FEB2580000CE', 'CRYPTO', 'BTC'],
    ['1INCH28FEB25FUT', 'CRYPTO', '1INCH'],
    ['BTCUSD.P', 'CRYPTO', 'BTC'],
    ['BTC_INR.P', 'CRYPTO', 'BTC'],
    ['ethusdt', 'CRYPTO', 'ETH'],
    ['USDT', 'CRYPTO', 'USDT'],
  ])('%s on %s → %s', (symbol, exchange, want) => {
    expect(extractUnderlying(symbol, exchange)).toBe(want)
  })
})

// --- the two databases, held to one contract -----------------------------------------------------

const rowsOf = async (text: string) => {
  const out: MasterRow[] = []
  await parseInstrumentsCsv(text, async (rows) => void out.push(...rows))
  return out
}

/** Stores `text` as the master of (pid, exchange) on `day`. */
const store = (db: MasterDb, pid: string, exchange: string, day: string, text: string) =>
  db.write(pid, exchange, day, (add) => parseInstrumentsCsv(text, add))

describe.each([
  ['memory', async () => createMemoryMasterDb()],
  ['sqlite', () => openMasterDb()],
])('%s MasterDb', (_name, open) => {
  let db: MasterDb
  beforeEach(async () => {
    db = await open()
  })
  afterEach(async () => {
    for (const pid of [PID, 'p2']) await db.clear(pid)
  })

  test('underlyings come from the symbol, options-bearing, sorted, free of test symbols; M&M and BAJAJ-AUTO are listed', async () => {
    const text = csvOf([
      ...options('NIFTY', 4),
      ...options('M&M', 2),
      ...options('BAJAJ-AUTO', 2),
      // the name column is not the underlying: the symbol is
      { ...options('BANKNIFTY', 1)[0], name: 'NIFTY BANK' },
      ...options('011NSETEST', 2),
      ...options('021BSETEST', 2),
      // futures only, an equity row and a lower-case option symbol
      future('TCS'),
      { symbol: 'RELIANCE', name: 'RELIANCE', exchange: 'NFO', instrumenttype: 'EQ' },
      { symbol: 'abb30dec265000ce', name: 'ABB', exchange: 'NFO', instrumenttype: 'CE' },
    ])
    await store(db, PID, 'NFO', '2026-11-24', text)
    expect(await db.optionUnderlyings(PID, 'NFO')).toEqual([
      'ABB',
      'BAJAJ-AUTO',
      'BANKNIFTY',
      'M&M',
      'NIFTY',
    ])
    expect(await db.loaded(PID, 'NFO')).toEqual({ day: '2026-11-24', rows: 16 })
    expect(await db.hasOptions(PID, 'NFO', 'M&M')).toBe(true)
    expect(await db.hasOptions(PID, 'NFO', 'TCS')).toBe(false)
    // per profile and exchange
    expect(await db.loaded(PID, 'BFO')).toBeNull()
    expect(await db.optionUnderlyings('p2', 'NFO')).toEqual([])
  })

  test('a write replaces the stored master at once; a failed fill keeps it whole', async () => {
    await store(db, PID, 'NFO', '2026-11-24', csvOf([...options('NIFTY', 2), ...options('ITC', 2)]))
    await store(db, PID, 'NFO', '2026-11-25', csvOf(options('NIFTY', 2)))
    expect(await db.optionUnderlyings(PID, 'NFO')).toEqual(['NIFTY'])
    expect(await db.loaded(PID, 'NFO')).toEqual({ day: '2026-11-25', rows: 2 })

    const failing = db.write(PID, 'NFO', '2026-11-26', async (add) => {
      await add(await rowsOf(csvOf(options('SBIN', 2))))
      throw new Error('short master')
    })
    await expect(failing).rejects.toThrow('short master')
    expect(await db.optionUnderlyings(PID, 'NFO')).toEqual(['NIFTY'])
    expect(await db.loaded(PID, 'NFO')).toEqual({ day: '2026-11-25', rows: 2 })
  })

  test('strikes of one expiry and type, distinct and ascending; FUT rows in file order; the first lot size LIKE a prefix', async () => {
    // file order is not symbol order, so the copy out of staging has to keep it
    const text = csvOf([
      option('NIFTY', '30-DEC-26', 24100, 'CE', 0),
      option('NIFTY', '30-DEC-26', 24000, 'PE', 75),
      option('NIFTY', '30-DEC-26', 24000, 'CE', 75),
      { ...option('NIFTY', '30-DEC-26', 24000, 'CE', 75), symbol: 'nifty30dec2624000ce' },
      option('NIFTY', '30-DEC-26', 23950, 'CE', 75),
      option('NIFTY', '06-JAN-27', 25000, 'CE', 75),
      option('BANKNIFTY', '30-DEC-26', 52000, 'CE', 30),
      { ...future('TCS'), lotsize: 175 },
      { ...future('NIFTY'), lotsize: 75 },
      { ...future('M&M'), lotsize: 350 },
      { ...future('INFY'), symbol: 'infy30dec26fut' },
    ])
    await store(db, PID, 'NFO', '2026-11-24', text)

    expect(await db.strikes(PID, 'NFO', 'NIFTY', '30DEC26', 'CE')).toEqual([23950, 24000, 24100])
    expect(await db.strikes(PID, 'NFO', 'NIFTY', '30DEC26', 'PE')).toEqual([24000])
    expect(await db.strikes(PID, 'NFO', 'NIFTY', '06JAN27', 'CE')).toEqual([25000])
    expect(await db.strikes(PID, 'NFO', 'BANKNIFTY', '30DEC26', 'CE')).toEqual([52000])
    expect(await db.strikes(PID, 'NFO', 'NIFTY', '30DEC2', 'CE')).toEqual([])
    expect(await db.strikes(PID, 'BFO', 'NIFTY', '30DEC26', 'CE')).toEqual([])

    const futures = await db.futures(PID, 'NFO')
    expect(futures.map((r) => r.symbol)).toEqual([
      'TCS30DEC26FUT',
      'NIFTY30DEC26FUT',
      'M&M30DEC26FUT',
      'infy30dec26fut',
    ])
    expect(futures[1]).toEqual({
      symbol: 'NIFTY30DEC26FUT',
      name: 'NIFTY',
      exchange: 'NFO',
      expiry: '30-DEC-26',
      strike: 0,
      lotsize: 75,
      tick: 0.1,
      itype: 'FUT',
      underlying: 'NIFTY',
    })
    expect(await db.futures('p2', 'NFO')).toEqual([])

    // custom_straddle.py:96-104: SQL's LIKE, so case-blind, `_` any one character, lotsize > 0
    expect(await db.lotSizeLike(PID, 'NFO', 'NIFTY')).toBe(75)
    expect(await db.lotSizeLike(PID, 'NFO', 'nifty')).toBe(75)
    expect(await db.lotSizeLike(PID, 'NFO', 'TCS')).toBe(175)
    expect(await db.lotSizeLike(PID, 'NFO', 'M_M')).toBe(350)
    expect(await db.lotSizeLike(PID, 'NFO', 'SBIN')).toBeNull()
    expect(await db.lotSizeLike(PID, 'MCX', 'NIFTY')).toBeNull()
  })

  test('clear forgets one profile only', async () => {
    await store(db, PID, 'NFO', '2026-11-24', csvOf(options('NIFTY', 2)))
    await store(db, PID, 'MCX', '2026-11-24', csvOf(options('CRUDEOIL', 2, 'MCX')))
    await store(db, 'p2', 'NFO', '2026-11-24', csvOf(options('NIFTY', 2)))
    await db.clear(PID)
    expect(await db.loaded(PID, 'NFO')).toBeNull()
    expect(await db.loaded(PID, 'MCX')).toBeNull()
    expect(await db.hasOptions(PID, 'NFO', 'NIFTY')).toBe(false)
    expect(await db.loaded('p2', 'NFO')).toEqual({ day: '2026-11-24', rows: 2 })
  })
})

describe('openMasterDb', () => {
  test('opens symbol-master.db once, with the underlying index, and leaves no staged rows', async () => {
    const first = openMasterDb()
    expect(openMasterDb()).toBe(first)
    const db = await first
    await store(db, PID, 'NFO', '2026-11-24', csvOf(options('NIFTY', 2)))
    await db
      .write(PID, 'NFO', '2026-11-25', async (add) => {
        await add(await rowsOf(csvOf(options('SBIN', 2))))
        throw new Error('short master')
      })
      .catch(() => {})
    const { __raw, __opened } = sqliteMock()
    expect(__opened).toEqual(['symbol-master.db'])
    const indexes = __raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'instruments'")
      .all()
    expect(JSON.stringify(indexes)).toContain('underlying')
    expect(__raw.prepare('SELECT count(*) AS n FROM staging').get()).toEqual({ n: 0 })
    await db.clear(PID)
  })
})

// --- the symbol master -----------------------------------------------------------------------------

describe('SymbolMaster', () => {
  test('MASTER_EXCHANGES are the F&O exchanges the tools pick from', () => {
    expect(MASTER_EXCHANGES).toEqual(['NFO', 'BFO', 'MCX', 'CDS', 'CRYPTO'])
    expect(MIN_OPTION_ROWS).toBe(50)
    expect(RETRY_AFTER_MS).toBe(900_000)
  })

  test('one download per exchange per IST day; the next day downloads again', async () => {
    const h = setup()
    h.reply('NFO', FULL, FULL)
    h.reply('BFO', csvOf(options('SENSEX', 60, 'BFO')))
    await expect(Promise.all([h.master.ensure('NFO'), h.master.ensure('NFO')])).resolves.toEqual([
      'today',
      'today',
    ])
    expect(await h.master.ensure('NFO')).toBe('today')
    expect(h.calls).toEqual([
      { id: 'instruments', query: { exchange: 'NFO', format: 'csv' }, withKey: true },
    ])
    expect(await h.master.ensure('BFO')).toBe('today')
    expect(h.calls).toHaveLength(2)

    // 00:00 IST is a new day: the old master answers until the new one is in
    h.setNow(DAY2)
    expect(await h.master.underlyingsNow('NFO')).toEqual({
      list: ['NIFTY', 'RELIANCE'],
      source: 'earlier',
    })
    expect(await h.master.ensure('NFO')).toBe('today')
    expect(h.calls).toHaveLength(3)
    expect(await h.db.loaded(PID, 'NFO')).toEqual({ day: '2026-11-25', rows: 61 })
  })

  test('a reload-time CSV (0 or 40 option rows, or a text 403) is not stored; the earlier master answers; a retry after 15 min (RF 2)', async () => {
    const h = setup()
    h.reply('NFO', FULL)
    expect(await h.master.ensure('NFO')).toBe('today')

    // the first broker login of the next day: the server is filling its symbol table again
    h.setNow(DAY2 - 90 * 60_000)
    const empty = '{"data":[],"message":"No instruments found","status":"success"}\n'
    h.reply('NFO', empty, csvOf([...options('NIFTY', 40), future('NIFTY')]))
    h.reply(
      'NFO',
      new ApiError({ kind: 'Server', status: 403, endpoint: 'instruments' }),
      FULL.replaceAll('RELIANCE', 'ITC'),
    )
    const warned = expectLog('warn', /\[master\] NFO/)

    expect(await h.master.ensure('NFO')).toBe('earlier')
    expect(await h.master.underlyingsNow('NFO')).toEqual({
      list: ['NIFTY', 'RELIANCE'],
      source: 'earlier',
    })
    expect(await h.db.loaded(PID, 'NFO')).toEqual({ day: '2026-11-24', rows: 61 })
    expect(h.calls).toHaveLength(2)

    // no retry for 15 minutes, however often it is asked
    h.setNow(h.now() + RETRY_AFTER_MS - 1)
    expect(await h.master.ensure('NFO')).toBe('earlier')
    expect(h.calls).toHaveLength(2)
    h.setNow(h.now() + 1)
    expect(await h.master.ensure('NFO')).toBe('earlier')
    expect(h.calls).toHaveLength(3)
    expect(MIN_OPTION_ROWS).toBeGreaterThan(40)

    h.setNow(h.now() + RETRY_AFTER_MS)
    expect(await h.master.ensure('NFO')).toBe('earlier')
    h.setNow(h.now() + RETRY_AFTER_MS)
    expect(await h.master.ensure('NFO')).toBe('today')
    expect(await h.master.underlyingsNow('NFO')).toEqual({
      list: ['ITC', 'NIFTY'],
      source: 'today',
    })
    expect(h.calls).toHaveLength(5)
    expect(warned).toHaveLength(3)
    expect(warned.join('\n')).toMatch(/0 option rows/)
    expect(warned.join('\n')).toMatch(/40 option rows/)
    expect(warned.join('\n')).toMatch(/Server \(403\)/)
    expect(warned.join('\n')).not.toMatch(/apikey|https?:/)
  })

  test('underlyingsNow answers defaults at once on a fresh install and starts one download', async () => {
    const h = setup()
    const csv = deferred<string>()
    h.reply('NFO', csv.promise)
    const defaults = { list: [...(DEFAULT_UNDERLYINGS.NFO ?? [])], source: 'defaults' }
    expect(await h.master.underlyingsNow('NFO')).toEqual(defaults)
    expect(await h.master.underlyingsNow('NFO')).toEqual(defaults)
    await settle()
    expect(h.calls).toHaveLength(1)

    csv.resolve(FULL)
    expect(await h.master.ensure('NFO')).toBe('today')
    expect(await h.master.underlyingsNow('NFO')).toEqual({
      list: ['NIFTY', 'RELIANCE'],
      source: 'today',
    })
    expect(h.calls).toHaveLength(1)

    // an exchange the master does not cover answers its defaults (none) and downloads nothing
    expect(await h.master.underlyingsNow('NSE')).toEqual({ list: [], source: 'defaults' })
    expect(await h.master.ensure('NSE')).toBe('none')
    expect(h.calls).toHaveLength(1)
  })

  test('a failed download on a fresh install leaves the defaults', async () => {
    const h = setup()
    h.reply('MCX', new ApiError({ kind: 'Network', status: 0, endpoint: 'instruments' }))
    expectLog('warn', /\[master\] MCX/)
    expect(await h.master.ensure('MCX')).toBe('none')
    expect(await h.master.underlyingsNow('MCX')).toEqual({
      list: [...(DEFAULT_UNDERLYINGS.MCX ?? [])],
      source: 'defaults',
    })
    expect(h.calls).toHaveLength(1)
  })

  test('hasOptions is null without a master and true for RELIANCE on NFO with one', async () => {
    const h = setup()
    expect(await h.master.hasOptions('NFO', 'RELIANCE')).toBeNull()
    // asking never downloads a master
    await settle()
    expect(h.calls).toHaveLength(0)
    h.reply('NFO', FULL)
    await h.master.ensure('NFO')
    expect(await h.master.hasOptions('NFO', 'RELIANCE')).toBe(true)
    expect(await h.master.hasOptions('NFO', 'TCS')).toBe(false)
    expect(await h.master.hasOptions('BFO', 'RELIANCE')).toBeNull()
  })

  test('strikes, futures and lotSizeLike answer from the master; with none: null, null, undefined', async () => {
    const h = setup()
    expect(await h.master.strikes('NFO', 'NIFTY', '30DEC26', 'CE')).toBeNull()
    expect(await h.master.futures('NFO')).toBeNull()
    expect(await h.master.lotSizeLike('NFO', 'NIFTY')).toBeUndefined()
    // asking never downloads a master
    await settle()
    expect(h.calls).toHaveLength(0)

    h.reply('NFO', FULL)
    await h.master.ensure('NFO')
    const strikes = Array.from({ length: 20 }, (_, i) => 1000 + 10 * i)
    expect(await h.master.strikes('NFO', 'NIFTY', '30DEC26', 'CE')).toEqual(strikes)
    expect(await h.master.strikes('NFO', 'RELIANCE', '30DEC26', 'PE')).toEqual(strikes.slice(0, 10))
    expect(await h.master.strikes('NFO', 'NIFTY', '06JAN27', 'CE')).toEqual([])
    expect((await h.master.futures('NFO'))?.map((r) => r.symbol)).toEqual(['TCS30DEC26FUT'])
    expect(await h.master.lotSizeLike('NFO', 'RELIANCE')).toBe(50)
    expect(await h.master.lotSizeLike('NFO', 'SBIN')).toBeNull()
    // another exchange's master is not stored
    expect(await h.master.strikes('BFO', 'SENSEX', '30DEC26', 'CE')).toBeNull()
    expect(await h.master.futures('BFO')).toBeNull()
    expect(await h.master.lotSizeLike('BFO', 'SENSEX')).toBeUndefined()
    expect(h.calls).toHaveLength(1)
  })

  test("an earlier master's FUT that expired yesterday is not listed", async () => {
    const h = setup()
    const near = { ...future('NIFTY'), symbol: 'NIFTY24NOV26FUT', expiry: '24-NOV-26' }
    h.reply('NFO', csvOf([...options('NIFTY', 60), near, future('NIFTY')]))
    await h.master.ensure('NFO')
    const listed = async () => (await h.master.futures('NFO'))?.map((r) => r.symbol)
    // 10:30 IST on its expiry day: listed until NFO's 15:30 IST cut-off
    expect(await listed()).toEqual(['NIFTY24NOV26FUT', 'NIFTY30DEC26FUT'])
    h.setNow(DAY1 + 5 * 3_600_000 - 60_000)
    expect(await listed()).toEqual(['NIFTY24NOV26FUT', 'NIFTY30DEC26FUT'])
    h.setNow(DAY1 + 5 * 3_600_000 + 60_000)
    expect(await listed()).toEqual(['NIFTY30DEC26FUT'])
    // the next day, before today's master is in
    h.setNow(DAY2)
    expect(await h.db.loaded(PID, 'NFO')).toEqual({ day: '2026-11-24', rows: 62 })
    expect(await listed()).toEqual(['NIFTY30DEC26FUT'])
  })

  test('a database that does not open falls back to memory, with a warning', async () => {
    const warned = expectLog('warn', /\[master\] .*memory/)
    const h = setup({ db: Promise.reject(new Error('disk I/O error')) })
    h.reply('NFO', FULL)
    expect(await h.master.ensure('NFO')).toBe('today')
    expect(await h.master.hasOptions('NFO', 'NIFTY')).toBe(true)
    expect(warned).toHaveLength(1)
  })

  test('clear forgets the stored master and stops a download in flight from storing', async () => {
    const h = setup()
    h.reply('NFO', FULL)
    await h.master.ensure('NFO')
    const csv = deferred<string>()
    h.setNow(DAY2)
    h.reply('NFO', csv.promise)
    const running = h.master.ensure('NFO')
    await settle()
    expect(h.calls).toHaveLength(2)
    const cleared = h.master.clear()
    // the request is aborted; a reply that comes anyway is not stored
    expect(h.signals[1]?.aborted).toBe(true)
    // asked for while the clear runs, a master is downloaded after it, never under it
    h.reply('BFO', csvOf(options('SENSEX', 60, 'BFO')))
    const after = h.master.ensure('BFO')
    await settle()
    expect(h.calls).toHaveLength(2)
    csv.resolve(FULL)
    await cleared
    expect(await running).toBe('none')
    expect(await h.db.loaded(PID, 'NFO')).toBeNull()
    expect(await h.master.hasOptions('NFO', 'NIFTY')).toBeNull()
    expect(await after).toBe('today')
    expect(await h.master.hasOptions('BFO', 'SENSEX')).toBe(true)
  })
})
