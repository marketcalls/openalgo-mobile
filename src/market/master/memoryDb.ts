// The symbol master in memory: the fallback when SQLite does not open (it lasts the session), and
// the database tests and the default TradingProvider use.
import { byCharCode, isOptionRow, isTestUnderlying, type MasterDb, type MasterRow } from './db'

type Stored = { day: string; count: number; rows: readonly MasterRow[] }

export function createMemoryMasterDb(): MasterDb {
  /** pid → exchange → master. */
  const masters = new Map<string, Map<string, Stored>>()
  const get = (pid: string, exchange: string) => masters.get(pid)?.get(exchange)

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
      for (const r of get(pid, exchange)?.rows ?? []) {
        if (isOptionRow(r) && r.underlying && !isTestUnderlying(r.underlying))
          names.add(r.underlying)
      }
      return [...names].sort(byCharCode)
    },

    async hasOptions(pid, exchange, underlying) {
      return (get(pid, exchange)?.rows ?? []).some(
        (r) => r.underlying === underlying && isOptionRow(r),
      )
    },

    async clear(pid) {
      masters.delete(pid)
    },
  }
}
