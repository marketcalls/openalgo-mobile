import { ApiError } from '~/core/http/errors'
import positionbook from '../../../test/fixtures/openalgo-docs/positionbook.json'
import { type Orderbook, OrderbookSchema, PositionbookSchema } from '../books/schemas'
import {
  RECONCILE_DELAYS_MS,
  reconcileClose,
  reconcilePlacement,
  reconcileRow,
  reconcileSplit,
} from './reconcile'
import type { OrderSpec } from './schemas'

// 25-Nov-2026 09:30:00 IST
const SENT_AT = Date.UTC(2026, 10, 25, 4, 0, 0)
const SPEC: OrderSpec = {
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'BUY',
  quantity: 10,
  pricetype: 'LIMIT',
  product: 'MIS',
  price: 1420,
  trigger_price: 0,
}

/** One orderbook row as the server sends it (C6); a matching order placed at 09:30:01 IST. */
const raw = (o: Record<string, unknown> = {}) => ({
  action: 'BUY',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  orderid: 'NEW1',
  product: 'MIS',
  quantity: '10',
  price: 1420,
  pricetype: 'LIMIT',
  order_status: 'open',
  trigger_price: 0,
  timestamp: '25-Nov-2026 09:30:01',
  ...o,
})

/** Parsed the way the app reads it, so placedAt comes from the real timestamp parse. */
const book = (...rows: object[]): Orderbook =>
  OrderbookSchema.parse({ status: 'success', data: { orders: rows, statistics: {} } })

/** fetchOrders answering each call with the next book (the last one repeats); an Error rejects. */
function fetches(...books: (Orderbook | Error)[]) {
  let i = 0
  return jest.fn(async () => {
    const b = books[Math.min(i++, books.length - 1)]
    if (b === undefined || b instanceof Error) throw b ?? new Error('no book')
    return b
  })
}

const sleep = jest.fn(async (_ms: number) => {})
const NONE: ReadonlySet<string> = new Set()
const network = () => new ApiError({ kind: 'Network', status: 0, endpoint: 'orderbook' })

beforeEach(() => sleep.mockClear())

describe('reconcilePlacement', () => {
  test('waits 2, 5 and 10 s by default', () => {
    expect(RECONCILE_DELAYS_MS).toEqual([2000, 5000, 10000])
  })

  test('an order that appears on the 2nd fetch is found after 2 fetches', async () => {
    const fetchOrders = fetches(book(), book(raw()))
    const out = await reconcilePlacement({
      fetchOrders,
      spec: SPEC,
      sentAt: SENT_AT,
      knownIds: NONE,
      sleep,
    })
    expect(out).toEqual({ found: expect.objectContaining({ orderid: 'NEW1' }), checked: true })
    expect(fetchOrders).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 5000])
  })

  test('an order that never appears gives null after 3 fetches', async () => {
    const fetchOrders = fetches(book(raw({ symbol: 'SBIN' })))
    const out = await reconcilePlacement({
      fetchOrders,
      spec: SPEC,
      sentAt: SENT_AT,
      knownIds: NONE,
      sleep,
    })
    expect(out).toEqual({ found: null, checked: true })
    expect(fetchOrders).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 5000, 10000])
  })

  test('an identical order already in the book at submit time is not matched', async () => {
    const known = raw({ orderid: 'OLD1' })
    const fetchOrders = fetches(book(known))
    const knownIds = new Set(['OLD1'])
    const args = { spec: SPEC, sentAt: SENT_AT, knownIds, sleep }
    expect(await reconcilePlacement({ fetchOrders, ...args })).toEqual({
      found: null,
      checked: true,
    })
    const both = fetches(book(known, raw({ orderid: 'NEW1' })))
    expect((await reconcilePlacement({ fetchOrders: both, ...args })).found?.orderid).toBe('NEW1')
  })

  test.each([
    ['symbol', { symbol: 'SBIN' }],
    ['exchange', { exchange: 'BSE' }],
    ['action', { action: 'SELL' }],
    ['product', { product: 'CNC' }],
    ['quantity', { quantity: '11' }],
  ])('a row with another %s is not ours', async (_field, change) => {
    const fetchOrders = fetches(book(raw(change)))
    const out = await reconcilePlacement({
      fetchOrders,
      spec: SPEC,
      sentAt: SENT_AT,
      knownIds: NONE,
      sleep,
      delaysMs: [0],
    })
    expect(out.found).toBeNull()
  })

  test('a row placed more than 120 s before the send is not ours; one without a time is', async () => {
    const run = (row: object) =>
      reconcilePlacement({
        fetchOrders: fetches(book(row)),
        spec: SPEC,
        sentAt: SENT_AT,
        knownIds: NONE,
        sleep,
        delaysMs: [0],
      })
    // 120 s before 09:30:00 is 09:28:00
    expect((await run(raw({ timestamp: '25-Nov-2026 09:28:00' }))).found).not.toBeNull()
    expect((await run(raw({ timestamp: '25-Nov-2026 09:27:59' }))).found).toBeNull()
    // the sandbox's "%Y-%m-%d %H:%M:%S" does not parse, so it cannot be ruled out by time
    expect((await run(raw({ timestamp: '2026-11-25 09:00:00' }))).found).not.toBeNull()
  })

  test('two candidates: the newest by time, wherever it sits in the list', async () => {
    const fetchOrders = fetches(
      book(
        raw({ orderid: 'A', timestamp: '25-Nov-2026 09:30:05' }),
        raw({ orderid: 'B', timestamp: '25-Nov-2026 09:30:09' }),
        raw({ orderid: 'C', timestamp: '25-Nov-2026 09:30:02' }),
      ),
    )
    const out = await reconcilePlacement({
      fetchOrders,
      spec: SPEC,
      sentAt: SENT_AT,
      knownIds: NONE,
      sleep,
    })
    expect(out.found?.orderid).toBe('B')
  })

  test('no time parses (the sandbox, which lists newest first): the first candidate', async () => {
    const fetchOrders = fetches(
      book(
        raw({ orderid: 'S3', timestamp: '2026-11-25 09:30:09' }),
        raw({ orderid: 'S2', timestamp: '2026-11-25 09:30:05' }),
        raw({ orderid: 'S1', timestamp: '2026-11-25 09:29:00' }),
      ),
    )
    const out = await reconcilePlacement({
      fetchOrders,
      spec: SPEC,
      sentAt: SENT_AT,
      knownIds: new Set(['S1']),
      sleep,
    })
    expect(out.found?.orderid).toBe('S3')
  })

  test('a failed fetch is skipped; when none succeeds, checked is false', async () => {
    const later = fetches(network(), book(raw()))
    const args = { spec: SPEC, sentAt: SENT_AT, knownIds: NONE, sleep }
    expect(await reconcilePlacement({ fetchOrders: later, ...args })).toMatchObject({
      found: { orderid: 'NEW1' },
      checked: true,
    })
    const never = fetches(network())
    expect(await reconcilePlacement({ fetchOrders: never, ...args })).toEqual({
      found: null,
      checked: false,
    })
    expect(never).toHaveBeenCalledTimes(3)
  })

  describe.each(['America/New_York', 'Asia/Kolkata', 'Pacific/Auckland'])('TZ=%s', (tz) => {
    const prev = process.env.TZ
    beforeAll(() => {
      process.env.TZ = tz
    })
    afterAll(() => {
      process.env.TZ = prev
    })

    test('gives the same match at the edge of the 120 s window', async () => {
      const fetchOrders = fetches(
        book(
          raw({ orderid: 'EDGE', timestamp: '25-Nov-2026 09:28:00' }),
          raw({ orderid: 'OUT', timestamp: '25-Nov-2026 09:27:59' }),
        ),
      )
      const out = await reconcilePlacement({
        fetchOrders,
        spec: SPEC,
        sentAt: SENT_AT,
        knownIds: NONE,
        sleep,
        delaysMs: [0],
      })
      expect(out.found?.orderid).toBe('EDGE')
      expect(out.found?.placedAt).toBe(SENT_AT - 120_000)
    })
  })
})

describe('reconcileSplit', () => {
  // 28 lots of 65 is 1,820 units; a freeze of 1,800 splits it into 1,755 + 65
  const SPLIT: OrderSpec = { ...SPEC, exchange: 'NFO', symbol: 'NIFTY30DEC26FUT', quantity: 1820 }
  const child = (o: Record<string, unknown>) =>
    raw({ exchange: 'NFO', symbol: 'NIFTY30DEC26FUT', ...o })

  test('children [1755, 65] in the book: both are found, on the first fetch', async () => {
    const fetchOrders = fetches(
      book(
        child({ orderid: 'C2', quantity: '65', timestamp: '25-Nov-2026 09:30:02' }),
        child({ orderid: 'C1', quantity: '1755', timestamp: '25-Nov-2026 09:30:01' }),
      ),
    )
    const out = await reconcileSplit({
      fetchOrders,
      spec: SPLIT,
      children: [1755, 65],
      sentAt: SENT_AT,
      knownIds: NONE,
      sleep,
    })
    expect(out.found.map((r) => r.orderid).sort()).toEqual(['C1', 'C2'])
    expect(out.checked).toBe(true)
    expect(fetchOrders).toHaveBeenCalledTimes(1)
  })

  test('a 1,820 row is not a child: one of two found, after every fetch', async () => {
    const fetchOrders = fetches(
      book(
        child({ orderid: 'WHOLE', quantity: '1820' }),
        child({ orderid: 'C1', quantity: '1755' }),
      ),
    )
    const out = await reconcileSplit({
      fetchOrders,
      spec: SPLIT,
      children: [1755, 65],
      sentAt: SENT_AT,
      knownIds: NONE,
      sleep,
    })
    expect(out.found.map((r) => r.orderid)).toEqual(['C1'])
    expect(fetchOrders).toHaveBeenCalledTimes(3)
  })

  test('each child takes one row: never more rows of a size than children of it', async () => {
    const fetchOrders = fetches(
      book(
        child({ orderid: 'X20', quantity: '20', timestamp: '25-Nov-2026 09:30:01' }),
        child({ orderid: 'B20', quantity: '20', timestamp: '25-Nov-2026 09:30:03' }),
        child({ orderid: 'A20', quantity: '20', timestamp: '25-Nov-2026 09:30:04' }),
        child({ orderid: 'K5', quantity: '5', timestamp: '25-Nov-2026 09:30:05' }),
        child({ orderid: 'A5', quantity: '5', timestamp: '25-Nov-2026 09:30:04' }),
      ),
    )
    const out = await reconcileSplit({
      fetchOrders,
      spec: SPLIT,
      children: [20, 20, 5],
      sentAt: SENT_AT,
      knownIds: new Set(['K5']),
      sleep,
    })
    expect(out.found.map((r) => r.orderid).sort()).toEqual(['A20', 'A5', 'B20'])
  })

  test('the children found by the last fetch that worked; none worked: checked false', async () => {
    const two = book(
      child({ orderid: 'C1', quantity: '1755' }),
      child({ orderid: 'C2', quantity: '65' }),
    )
    const args = { spec: SPLIT, children: [1755, 65], sentAt: SENT_AT, knownIds: NONE, sleep }
    const partial = fetches(book(child({ orderid: 'C1', quantity: '1755' })), network())
    expect(await reconcileSplit({ fetchOrders: partial, ...args })).toMatchObject({
      found: [{ orderid: 'C1' }],
      checked: true,
    })
    const late = fetches(network(), network(), two)
    expect((await reconcileSplit({ fetchOrders: late, ...args })).found).toHaveLength(2)
    expect(await reconcileSplit({ fetchOrders: fetches(network()), ...args })).toEqual({
      found: [],
      checked: false,
    })
  })
})

describe('reconcileClose', () => {
  const positions = PositionbookSchema.parse(positionbook)
  const fetchPositions = async () => positions

  test('quantity 0 is closed', async () => {
    const row = { symbol: 'RELIANCE', exchange: 'NSE', product: 'MIS', quantity: 5 }
    expect(await reconcileClose({ fetchPositions, row })).toBe('closed')
  })

  test('a row gone from the book is closed; another product of the symbol does not count', async () => {
    const gone = { symbol: 'SBIN', exchange: 'NSE', product: 'MIS', quantity: 5 }
    expect(await reconcileClose({ fetchPositions, row: gone })).toBe('closed')
    const otherProduct = { symbol: 'NHPC', exchange: 'NSE', product: 'CNC', quantity: -1 }
    expect(await reconcileClose({ fetchPositions, row: otherProduct })).toBe('closed')
  })

  test('quantity -1 is open', async () => {
    const row = { symbol: 'NHPC', exchange: 'NSE', product: 'MIS', quantity: -1 }
    expect(await reconcileClose({ fetchPositions, row })).toBe('open')
  })

  test('a book that cannot be read is unknown', async () => {
    const row = { symbol: 'NHPC', exchange: 'NSE', product: 'MIS', quantity: -1 }
    const failing = async () => {
      throw network()
    }
    expect(await reconcileClose({ fetchPositions: failing, row })).toBe('unknown')
  })
})

describe('reconcileRow', () => {
  test('the row with the id, or null when the book has none', async () => {
    const fetchOrders = fetches(
      book(raw({ orderid: 'A', order_status: 'cancelled' }), raw({ orderid: 'B' })),
    )
    expect(await reconcileRow({ fetchOrders, orderid: 'A' })).toMatchObject({
      orderid: 'A',
      status: 'cancelled',
    })
    expect(await reconcileRow({ fetchOrders, orderid: 'Z' })).toBeNull()
    expect(fetchOrders).toHaveBeenCalledTimes(2)
  })

  test('a book that cannot be read rejects, so a caller can say it could not check', async () => {
    await expect(
      reconcileRow({ fetchOrders: fetches(network()), orderid: 'A' }),
    ).rejects.toMatchObject({
      kind: 'Network',
    })
  })
})
