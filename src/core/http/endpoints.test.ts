import { ENDPOINTS, type EndpointId } from './endpoints'

const BOOKS = [
  'funds',
  'orderbook',
  'tradebook',
  'positionbook',
  'holdings',
  'orderstatus',
  'margin',
]
const ORDERS = [
  'placeorder',
  'placesmartorder',
  'modifyorder',
  'cancelorder',
  'cancelallorder',
  'closeposition',
  'basketorder',
  'splitorder',
  'optionsorder',
  'optionsmultiorder',
]
const DATA = [
  'ping',
  'search',
  'symbol',
  'expiry',
  'quotes',
  'multiquotes',
  'depth',
  'history',
  'intervals',
  'market/timings',
  'market/holidays',
  'optionchain',
  'multioptiongreeks',
  'analyzer',
  'analyzer/toggle',
]
const GTT = ['placegttorder', 'modifygttorder', 'cancelgttorder', 'gttorderbook']
const TOOLS = [
  'portfolio/backtest',
  'portfolio/holdings',
  'portfolio/tearsheet',
  'sip/backtest',
  'sectorrotation',
]
const GET_ONLY = [
  'instruments',
  'portfolio/benchmarks',
  'sip/frequencies',
  'sectorrotation/options',
]

const ids = Object.keys(ENDPOINTS) as EndpointId[]

test('lists exactly the plan ids, each at /api/v1/<id>', () => {
  expect([...ids].sort()).toEqual(
    [...BOOKS, ...ORDERS, ...DATA, ...GTT, ...TOOLS, ...GET_ONLY].sort(),
  )
  for (const id of ids) expect(ENDPOINTS[id].path).toBe(`/api/v1/${id}`)
})

test('POST and JSON unless marked', () => {
  for (const id of ids) {
    expect([id, ENDPOINTS[id].method]).toEqual([id, GET_ONLY.includes(id) ? 'GET' : 'POST'])
  }
  const marked = ids.filter((id) => ENDPOINTS[id].expect !== 'json')
  expect(Object.fromEntries(marked.map((id) => [id, ENDPOINTS[id].expect]))).toEqual({
    instruments: 'csv',
    'portfolio/tearsheet': 'html',
  })
})

test('timeouts: 15 s default, history and basketorder 30 s, splitorder 45 s, tools 120 s', () => {
  const special: Record<string, number> = {
    history: 30_000,
    basketorder: 30_000,
    splitorder: 45_000,
    'portfolio/backtest': 120_000,
    'portfolio/holdings': 120_000,
    'portfolio/tearsheet': 120_000,
    'portfolio/benchmarks': 120_000,
    'sip/backtest': 120_000,
    'sip/frequencies': 120_000,
    sectorrotation: 120_000,
    'sectorrotation/options': 120_000,
  }
  for (const id of ids) expect([id, ENDPOINTS[id].timeoutMs]).toEqual([id, special[id] ?? 15_000])
})

test('lanes: order, smart, control and history as listed; everything else reads', () => {
  const lanes: Record<string, string> = {
    placegttorder: 'order',
    modifygttorder: 'order',
    cancelgttorder: 'order',
    placeorder: 'order',
    modifyorder: 'order',
    cancelorder: 'order',
    cancelallorder: 'order',
    closeposition: 'order',
    basketorder: 'order',
    splitorder: 'order',
    optionsorder: 'order',
    optionsmultiorder: 'order',
    placesmartorder: 'smart',
    'analyzer/toggle': 'control',
    history: 'history',
  }
  for (const id of ids) expect([id, ENDPOINTS[id].lane]).toEqual([id, lanes[id] ?? 'read'])
})

test('flags: search is keyOnly; history, optionchain and gttorderbook list their optional fields', () => {
  expect(ids.filter((id) => ENDPOINTS[id].keyOnly)).toEqual(['search'])
  const optional = ids.filter((id) => ENDPOINTS[id].optional)
  expect(Object.fromEntries(optional.map((id) => [id, ENDPOINTS[id].optional]))).toEqual({
    history: ['source'],
    optionchain: ['with_greeks', 'interest_rate'],
    gttorderbook: ['status'],
  })
})
