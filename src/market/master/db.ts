// Where the symbol master lives (design 7.8): the instruments CSV of each F&O exchange, per
// profile, with the IST day it was downloaded. sqlite.ts keeps it on the phone; memoryDb.ts is the
// fallback when SQLite does not open, and what tests use.

/** One instrument of the CSV (services/instruments_service.py:12-24), as the app keeps it. */
export type MasterRow = {
  symbol: string
  name: string
  exchange: string
  /** DD-MMM-YY, as the server's database holds it; '' when the instrument has none. */
  expiry: string
  strike: number
  lotsize: number
  tick: number
  /** `instrumenttype`: FUT, CE, PE, EQ, INDEX… */
  itype: string
  /** `extractUnderlying(symbol, exchange)`. */
  underlying: string | null
}

export interface MasterDb {
  /**
   * Replaces the master of (pid, exchange) with the rows `fill` adds (those of that exchange), all
   * at once: the rows are staged, and swapped in only when `fill` resolves (its value is the row
   * count). A `fill` that throws leaves the stored master as it was, and the write rejects with its
   * error. One write per (pid, exchange) at a time, and none during a `clear` of its pid.
   */
  write(
    pid: string,
    exchange: string,
    day: string,
    fill: (add: (rows: MasterRow[]) => Promise<void>) => Promise<number>,
  ): Promise<void>
  /** The IST day and row count of the stored master, or null when none is stored. */
  loaded(pid: string, exchange: string): Promise<{ day: string; rows: number } | null>
  /** The distinct underlyings that have options, sorted, without the exchanges' test symbols. */
  optionUnderlyings(pid: string, exchange: string): Promise<string[]>
  hasOptions(pid: string, exchange: string, underlying: string): Promise<boolean>
  /**
   * The distinct strikes of `underlying`'s `type` options at `ddmmmyy` (rows whose expiry is its
   * DD-MMM-YY form and whose symbol ends in `type`), ascending.
   */
  strikes(
    pid: string,
    exchange: string,
    underlying: string,
    ddmmmyy: string,
    type: 'CE' | 'PE',
  ): Promise<number[]>
  /** Every row whose symbol ends FUT, in the CSV's order (rowid), expired ones included. */
  futures(pid: string, exchange: string): Promise<MasterRow[]>
  /**
   * The lot size of the first row in the CSV's order whose symbol is LIKE `prefix%` (SQL's LIKE:
   * case-blind, `_` any one character) and whose lot size is above 0; null when none is.
   */
  lotSizeLike(pid: string, exchange: string, prefix: string): Promise<number | null>
  /** Forgets every master of the profile. */
  clear(pid: string): Promise<void>
}

/**
 * The server's options test (database/token_db_enhanced.py:310-314): a symbol with an underlying
 * that ends CE or PE. Futures-only names are dead ends in an option picker.
 */
export const isOptionRow = (r: Pick<MasterRow, 'symbol' | 'underlying'>): boolean =>
  r.underlying !== null && /(CE|PE)$/.test(r.symbol.toUpperCase())

/** blueprints/search.py:270-271: the exchanges' test symbols (011NSETEST, 021BSETEST) are not offered. */
export const isTestUnderlying = (u: string): boolean =>
  u.includes('NSETEST') || u.includes('BSETEST')

/** As Python's sorted() and SQLite's ORDER BY order these ASCII names: by character code, not by locale. */
export const byCharCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
