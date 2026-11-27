// The symbol master in memory: the fallback when SQLite does not open (it lasts the session), and
// the database tests and the default TradingProvider use. Rows keep the CSV's order, as SQLite's
// rowid does.
import { toDashed } from '~/market/options/expiry'
import { byCharCode, isOptionRow, isTestUnderlying, type MasterDb, type MasterRow } from './db'

type Stored = { day: string; count: number; rows: readonly MasterRow[] }

/** SQL's `LIKE prefix%` (SQLite's default): case-blind, `%` any run, `_` any one character. */
function likePrefix(prefix: string): RegExp {
  const body = [...prefix]
    .map((c) => {
      if (c === '%') return '[\\s\\S]*'
      if (c === '_') return '[\\s\\S]'
      return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${body}`, 'i')
}

export function createMemoryMasterDb(): MasterDb {
  /** pid → exchange → master. */
  const masters = new Map<string, Map<string, Stored>>()
  const get = (pid: string, exchange: string) => masters.get(pid)?.get(exchange)
  const rowsOf = (pid: string, exchange: string) => get(pid, exchange)?.rows ?? []

  return {
    async write(pid, exchange, day, fill) {
      const staged: MasterRow[] = []
      const count = await fill(async (batch) => {
        for (const r of batch) if (r.exchange === exchange) staged.push(r)
      })
      const byPid = masters.get(pid) ?? new Map<string, Stored>()
      byPid.set(exchange, { day, count, rows: staged })
      masters.set(pid, byPid)
    },

    async loaded(pid, exchange) {
      const m = get(pid, exchange)
      return m ? { day: m.day, rows: m.count } : null
    },

    async optionUnderlyings(pid, exchange) {
      const names = new Set<string>()
      for (const r of rowsOf(pid, exchange)) {
        if (isOptionRow(r) && r.underlying && !isTestUnderlying(r.underlying))
          names.add(r.underlying)
      }
      return [...names].sort(byCharCode)
    },

    async hasOptions(pid, exchange, underlying) {
      return rowsOf(pid, exchange).some((r) => r.underlying === underlying && isOptionRow(r))
    },

    async strikes(pid, exchange, underlying, ddmmmyy, type) {
      const expiry = toDashed(ddmmmyy)
      const found = new Set<number>()
      for (const r of rowsOf(pid, exchange)) {
        if (
          r.underlying === underlying &&
          r.expiry === expiry &&
          r.symbol.toUpperCase().endsWith(type)
        )
          found.add(r.strike)
      }
      return [...found].sort((a, b) => a - b)
    },

    async futures(pid, exchange) {
      return rowsOf(pid, exchange).filter((r) => r.symbol.toUpperCase().endsWith('FUT'))
    },

    async lotSizeLike(pid, exchange, prefix) {
      const like = likePrefix(prefix)
      return (
        rowsOf(pid, exchange).find((r) => like.test(r.symbol) && r.lotsize > 0)?.lotsize ?? null
      )
    },

    async clear(pid) {
      masters.delete(pid)
    },
  }
}
