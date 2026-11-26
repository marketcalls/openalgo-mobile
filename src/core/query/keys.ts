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
}
