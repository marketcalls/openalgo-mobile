export type Lane = 'read' | 'history' | 'order' | 'smart' | 'control'

export type EndpointDef = {
  /** Under `/api/v1`, as restx_api/__init__.py:66-116 registers it. */
  path: string
  method: 'GET' | 'POST'
  /** What a success looks like. JSON means JSON with a string `status` (S6). */
  expect: 'json' | 'csv' | 'html'
  timeoutMs: number
  lane: Lane
  /** The server checks only the key, not the broker session (S3). */
  keyOnly?: boolean
  /** Request fields an older server rejects as unknown (S7, S10). */
  optional?: readonly string[]
}

export const DEFAULT_TIMEOUT_MS = 15_000
const TOOL_TIMEOUT_MS = 120_000

type Spec = Partial<Omit<EndpointDef, 'path'>>

const SPECS = {
  // books
  funds: {},
  orderbook: {},
  tradebook: {},
  positionbook: {},
  holdings: {},
  orderstatus: {},
  margin: {},
  // orders
  placeorder: { lane: 'order' },
  placesmartorder: { lane: 'smart' },
  modifyorder: { lane: 'order' },
  cancelorder: { lane: 'order' },
  cancelallorder: { lane: 'order' },
  closeposition: { lane: 'order' },
  basketorder: { lane: 'order', timeoutMs: 30_000 },
  splitorder: { lane: 'order', timeoutMs: 45_000 },
  optionsorder: { lane: 'order' },
  optionsmultiorder: { lane: 'order' },
  // data
  ping: {},
  search: { keyOnly: true },
  symbol: {},
  expiry: {},
  quotes: {},
  multiquotes: {},
  depth: {},
  history: { lane: 'history', timeoutMs: 30_000, optional: ['source'] },
  intervals: {},
  'market/timings': {},
  'market/holidays': {},
  optionchain: { optional: ['with_greeks', 'interest_rate'] },
  multioptiongreeks: {},
  analyzer: {},
  'analyzer/toggle': { lane: 'control' },
  // tools
  'portfolio/backtest': {},
  'portfolio/holdings': {},
  'portfolio/tearsheet': { expect: 'html' },
  'sip/backtest': {},
  sectorrotation: {},
  // GET-only: their key goes in the query string, so M1 calls none of them
  instruments: { method: 'GET', expect: 'csv' },
  'portfolio/benchmarks': { method: 'GET' },
  'sip/frequencies': { method: 'GET' },
  'sectorrotation/options': { method: 'GET' },
} satisfies Record<string, Spec>

export type EndpointId = keyof typeof SPECS

const isTool = (id: string) => /^(portfolio\/|sip\/|sectorrotation)/.test(id)

export const ENDPOINTS = Object.fromEntries(
  Object.entries(SPECS).map(([id, spec]: [string, Spec]) => [
    id,
    {
      path: `/api/v1/${id}`,
      method: 'POST',
      expect: 'json',
      timeoutMs: isTool(id) ? TOOL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
      lane: 'read',
      ...spec,
    },
  ]),
) as Record<EndpointId, EndpointDef>
