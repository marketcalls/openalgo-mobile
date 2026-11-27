// The symbol master on the phone (design 7.8): expo-sqlite's 'symbol-master.db', one file for every
// profile. Only the app shell imports this module, so tests and the default TradingProvider never
// load the native module. Writes go one at a time, each in an exclusive transaction (on its own
// connection, expo-sqlite); WAL lets reads run meanwhile.
import { openDatabaseAsync, type SQLiteDatabase, type SQLiteStatement } from 'expo-sqlite'
import { byCharCode, isTestUnderlying, type MasterDb, type MasterRow } from './db'

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS instruments (
  pid TEXT NOT NULL, exchange TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL,
  underlying TEXT, expiry TEXT NOT NULL, strike REAL NOT NULL, lotsize REAL NOT NULL,
  tick REAL NOT NULL, itype TEXT NOT NULL,
  PRIMARY KEY (pid, exchange, symbol)
);
CREATE INDEX IF NOT EXISTS instruments_underlying ON instruments (pid, exchange, underlying);
CREATE TABLE IF NOT EXISTS staging (
  pid TEXT NOT NULL, exchange TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL,
  underlying TEXT, expiry TEXT NOT NULL, strike REAL NOT NULL, lotsize REAL NOT NULL,
  tick REAL NOT NULL, itype TEXT NOT NULL,
  PRIMARY KEY (pid, exchange, symbol)
);
CREATE TABLE IF NOT EXISTS loads (
  pid TEXT NOT NULL, exchange TEXT NOT NULL, day TEXT NOT NULL, rows INTEGER NOT NULL,
  PRIMARY KEY (pid, exchange)
);
`

const COLUMNS = 'pid, exchange, symbol, name, underlying, expiry, strike, lotsize, tick, itype'
/** One row's placeholders. */
const TUPLE = `(${COLUMNS.split(', ')
  .map(() => '?')
  .join(', ')})`
/** Rows per INSERT: 1,000 bound values, far below SQLite's 32,766. */
const ROWS_PER_INSERT = 100
/** The server's options test (db.ts isOptionRow) in SQL. */
const IS_OPTION = "underlying IS NOT NULL AND substr(upper(symbol), -2) IN ('CE', 'PE')"

type Txn = Pick<SQLiteDatabase, 'runAsync' | 'prepareAsync'>

const valuesOf = (pid: string, r: MasterRow) => [
  pid,
  r.exchange,
  r.symbol,
  r.name,
  r.underlying,
  r.expiry,
  r.strike,
  r.lotsize,
  r.tick,
  r.itype,
]

/** Stages the rows of `exchange`: one prepared statement per insert size, finalized after. */
async function stage(txn: Txn, pid: string, exchange: string, rows: readonly MasterRow[]) {
  const mine = rows.filter((r) => r.exchange === exchange)
  const statements = new Map<number, SQLiteStatement>()
  try {
    for (let i = 0; i < mine.length; i += ROWS_PER_INSERT) {
      const chunk = mine.slice(i, i + ROWS_PER_INSERT)
      let st = statements.get(chunk.length)
      if (!st) {
        st = await txn.prepareAsync(
          `INSERT OR REPLACE INTO staging (${COLUMNS}) VALUES ${Array(chunk.length).fill(TUPLE).join(', ')}`,
        )
        statements.set(chunk.length, st)
      }
      await st.executeAsync(chunk.flatMap((r) => valuesOf(pid, r)))
    }
  } finally {
    for (const st of statements.values()) await st.finalizeAsync()
  }
}

function sqliteMasterDb(db: SQLiteDatabase): MasterDb {
  let tail: Promise<unknown> = Promise.resolve()
  /** Runs `task` in an exclusive transaction once every earlier write has settled. */
  const exclusive = (task: (txn: Txn) => Promise<void>): Promise<void> => {
    const run = tail.then(() => db.withExclusiveTransactionAsync(task))
    tail = run.catch(() => {})
    return run
  }
  const unstage = (pid: string, exchange: string) =>
    exclusive(async (txn) => {
      await txn.runAsync('DELETE FROM staging WHERE pid = ? AND exchange = ?', [pid, exchange])
    })

  return {
    async write(pid, exchange, day, fill) {
      // rows an interrupted write left behind
      await unstage(pid, exchange)
      let rows: number
      try {
        rows = await fill((batch) => exclusive((txn) => stage(txn, pid, exchange, batch)))
      } catch (e) {
        await unstage(pid, exchange)
        throw e
      }
      await exclusive(async (txn) => {
        const key = [pid, exchange]
        await txn.runAsync('DELETE FROM instruments WHERE pid = ? AND exchange = ?', key)
        await txn.runAsync(
          `INSERT INTO instruments (${COLUMNS}) SELECT ${COLUMNS} FROM staging WHERE pid = ? AND exchange = ?`,
          key,
        )
        await txn.runAsync('DELETE FROM staging WHERE pid = ? AND exchange = ?', key)
        await txn.runAsync(
          'INSERT OR REPLACE INTO loads (pid, exchange, day, rows) VALUES (?, ?, ?, ?)',
          [pid, exchange, day, rows],
        )
      })
    },

    async loaded(pid, exchange) {
      const r = await db.getFirstAsync<{ day: string; rows: number }>(
        'SELECT day, rows FROM loads WHERE pid = ? AND exchange = ?',
        [pid, exchange],
      )
      return r ? { day: r.day, rows: r.rows } : null
    },

    async optionUnderlyings(pid, exchange) {
      const rows = await db.getAllAsync<{ underlying: string }>(
        `SELECT DISTINCT underlying FROM instruments WHERE pid = ? AND exchange = ? AND ${IS_OPTION}`,
        [pid, exchange],
      )
      return rows
        .map((r) => r.underlying)
        .filter((u) => !isTestUnderlying(u))
        .sort(byCharCode)
    },

    async hasOptions(pid, exchange, underlying) {
      const r = await db.getFirstAsync(
        `SELECT 1 AS found FROM instruments WHERE pid = ? AND exchange = ? AND underlying = ? AND ${IS_OPTION} LIMIT 1`,
        [pid, exchange, underlying],
      )
      return r !== null
    },

    clear(pid) {
      return exclusive(async (txn) => {
        for (const table of ['instruments', 'staging', 'loads']) {
          await txn.runAsync(`DELETE FROM ${table} WHERE pid = ?`, [pid])
        }
      })
    },
  }
}

let opened: Promise<MasterDb> | null = null

/**
 * The master database, opened once for the app's life (every profile shares the file); an open
 * that fails is forgotten, so the next shell tries again.
 */
export function openMasterDb(): Promise<MasterDb> {
  opened ??= (async () => {
    const db = await openDatabaseAsync('symbol-master.db')
    await db.execAsync(SCHEMA)
    return sqliteMasterDb(db)
  })().catch((e: unknown) => {
    opened = null
    throw e
  })
  return opened
}
