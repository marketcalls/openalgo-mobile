// Every key starts with ['p', profileId]. The API key never appears in a key.

export type ProfileKey = readonly ['p', string]

const root = (pid: string): ProfileKey => ['p', pid]

export const qk = {
  root,
  caps: (pid: string) => [...root(pid), 'caps'] as const,
  analyzer: (pid: string) => [...root(pid), 'analyzer'] as const,
  funds: (pid: string) => [...root(pid), 'funds'] as const,
  ping: (pid: string) => [...root(pid), 'ping'] as const,
  multiquotes: (pid: string, keys: readonly string[]) =>
    [...root(pid), 'multiquotes', keys] as const,
  quotes: (pid: string, ex: string, sym: string) => [...root(pid), 'quotes', ex, sym] as const,
  depth: (pid: string, ex: string, sym: string) => [...root(pid), 'depth', ex, sym] as const,
  symbol: (pid: string, ex: string, sym: string) => [...root(pid), 'symbol', ex, sym] as const,
  search: (pid: string, q: string, ex?: string) => [...root(pid), 'search', q, ex ?? null] as const,
  orderbook: (pid: string) => [...root(pid), 'orderbook'] as const,
  tradebook: (pid: string) => [...root(pid), 'tradebook'] as const,
  positionbook: (pid: string) => [...root(pid), 'positionbook'] as const,
  holdings: (pid: string) => [...root(pid), 'holdings'] as const,
  orderstatus: (pid: string, id: string) => [...root(pid), 'orderstatus', id] as const,
  intervals: (pid: string) => [...root(pid), 'intervals'] as const,
  calendar: (pid: string, istDay: string) => [...root(pid), 'calendar', istDay] as const,
  gttbook: (pid: string) => [...root(pid), 'gttbook'] as const,
  /** An underlying's expiries of one kind, read once per IST day (OptionsData.expiries). */
  expiry: (pid: string, ex: string, u: string, type: 'options' | 'futures') =>
    [...root(pid), 'expiry', ex, u, type] as const,
  /** One chain read; a chain with Greeks is not the same entry as one without (preflight 19). */
  optionchain: (
    pid: string,
    ex: string,
    u: string,
    expiry: string,
    count: number,
    withGreeks: boolean,
  ) => [...root(pid), 'optionchain', ex, u, expiry, count, withGreeks] as const,
  /**
   * The one GTT support read for a server, broker and mode, until a probe (`probedAt`) resets
   * what was seen. Not a book: pokes and mode flips leave it alone.
   */
  gttdetect: (
    pid: string,
    host: string | null,
    broker: string | null,
    mode: string,
    probedAt: number | null,
  ) => [...root(pid), 'gttdetect', host, broker, mode, probedAt] as const,
}
