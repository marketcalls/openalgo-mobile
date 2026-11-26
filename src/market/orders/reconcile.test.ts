import { ApiError } from '~/core/http/errors'
import positionbook from '../../../test/fixtures/openalgo-docs/positionbook.json'
import {
  type Orderbook,
  OrderbookSchema,
  type Positionbook,
  PositionbookSchema,
} from '../books/schemas'
import {
  findWorkingExit,
  NO_REPLY_DELAYS_MS,
  noReplyDelays,
  RECONCILE_DELAYS_MS,
  reconcileCancelAll,
  reconcileClose,
  reconcilePlacement,
  reconcileRow,
  reconcileRowChange,
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
/** A row the app cannot read (no order id): dropped and counted. */
const unreadable = () => raw({ orderid: undefined })

/** A fetch answering each call with the next book (the last one repeats); an Error rejects. */
function answers<B>(books: (B | Error)[]) {
  let i = 0
  return jest.fn(async () => {
    const b = books[Math.min(i++, books.length - 1)]
    if (b === undefined || b instanceof Error) throw b ?? new Error('no book')
    return b
  })
}
const fetches = (...books: (Orderbook | Error)[]) => answers(books)
const positionReads = (...books: (Positionbook | Error)[]) => answers(books)

const sleep = jest.fn(async (_ms: number) => {})
const NONE: ReadonlySet<string> = new Set()
const network = () => new ApiError({ kind: 'Network', status: 0, endpoint: 'orderbook' })

beforeEach(() => sleep.mockClear())

describe('the delays', () => {
  const sum = (ms: readonly number[]) => ms.reduce((a, b) => a + b, 0)

  test('waits 2, 5 and 10 s by default', () => {
    expect(RECONCILE_DELAYS_MS).toEqual([2000, 5000, 10000])
  })

  test("after no reply, the last read lands past the stock server's 120 s broker timeout", () => {
    expect(NO_REPLY_DELAYS_MS.slice(0, 3)).toEqual(RECONCILE_DELAYS_MS)
    expect(sum(NO_REPLY_DELAYS_MS)).toBeGreaterThan(120_000)
    expect(noReplyDelays()).toEqual(NO_REPLY_DELAYS_MS)
  })

  test('a split reads on 30 s more per 30 children the server may still be placing', () => {
    expect(sum(noReplyDelays(2))).toBe(sum(NO_REPLY_DELAYS_MS) + 30_000)
    expect(sum(noReplyDelays(100))).toBe(sum(NO_REPLY_DELAYS_MS) + 4 * 30_000)
    // 100 children at 1 s each, after the 120 s a broker request may take
    expect(sum(noReplyDelays(100))).toBeGreaterThan(120_000 + 100 * 1_000)
  })
})

describe('reconcilePlacement', () => {
  test('the delays it is given: the no-reply series reads six times before it gives up', async () => {
    const fetchOrders = fetches(book())
    const out = await reconcilePlacement({
      fetchOrders,
      spec: SPEC,
      sentAt: SENT_AT,
      knownIds: NONE,
      sleep,
      delaysMs: noReplyDelays(),
    })
    expect(out).toEqual({ found: null, checked: true })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...NO_REPLY_DELAYS_MS])
  })

  test('a book with an unreadable row and no match could not check: the row may be ours', async () => {
    const fetchOrders = fetches(book(raw({ symbol: 'SBIN' }), unreadable()))
    const args = { spec: SPEC, sentAt: SENT_AT, knownIds: NONE, sleep }
    expect(await reconcilePlacement({ fetchOrders, ...args })).toEqual({
      found: null,
      checked: false,
    })
    expect(fetchOrders).toHaveBeenCalledTimes(3)
    // a match is a match, whatever else could not be read
    const matched = fetches(book(raw(), unreadable()))
    expect(await reconcilePlacement({ fetchOrders: matched, ...args })).toMatchObject({
      found: { orderid: 'NEW1' },
      checked: true,
    })
    // the last read decides: unreadable rows, then a clean book with no match
    const cleared = fetches(book(unreadable()), book())
    expect(await reconcilePlacement({ fetchOrders: cleared, ...args })).toEqual({
      found: null,
      checked: true,
    })
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

describe('reconcileSplit and unreadable rows', () => {
  const SPLIT: OrderSpec = { ...SPEC, exchange: 'NFO', symbol: 'NIFTY30DEC26FUT', quantity: 1820 }
  const child = (o: Record<string, unknown>) =>
    raw({ exchange: 'NFO', symbol: 'NIFTY30DEC26FUT', ...o })

  test('some children found and a row unreadable: not checked; all found: checked', async () => {
    const args = { spec: SPLIT, children: [1755, 65], sentAt: SENT_AT, knownIds: NONE, sleep }
    const some = fetches(book(child({ orderid: 'C1', quantity: '1755' }), unreadable()))
    expect(await reconcileSplit({ fetchOrders: some, ...args })).toMatchObject({
      found: [{ orderid: 'C1' }],
      checked: false,
    })
    const all = fetches(
      book(
        child({ orderid: 'C1', quantity: '1755' }),
        child({ orderid: 'C2', quantity: '65' }),
        unreadable(),
      ),
    )
    expect((await reconcileSplit({ fetchOrders: all, ...args })).checked).toBe(true)
  })
})

describe('reconcileClose', () => {
  const positions = PositionbookSchema.parse(positionbook)
  const fetchPositions = async () => positions
  const NHPC = { symbol: 'NHPC', exchange: 'NSE', product: 'MIS', quantity: -1 }
  /** The positionbook with NHPC MIS at `quantity`, as the server sends it. */
  const nhpcAt = (quantity: string) =>
    PositionbookSchema.parse({
      status: 'success',
      data: [{ symbol: 'NHPC', exchange: 'NSE', product: 'MIS', quantity, ltp: '83.72' }],
    })
  const delays = () => sleep.mock.calls.map(([ms]) => ms)

  test('quantity 0 is closed', async () => {
    const row = { symbol: 'RELIANCE', exchange: 'NSE', product: 'MIS', quantity: 5 }
    expect(await reconcileClose({ fetchPositions, row, sleep })).toBe('closed')
  })

  test('a row gone from the book is closed; another product of the symbol does not count', async () => {
    const gone = { symbol: 'SBIN', exchange: 'NSE', product: 'MIS', quantity: 5 }
    expect(await reconcileClose({ fetchPositions, row: gone, sleep })).toBe('closed')
    const otherProduct = { symbol: 'NHPC', exchange: 'NSE', product: 'CNC', quantity: -1 }
    expect(await reconcileClose({ fetchPositions, row: otherProduct, sleep })).toBe('closed')
  })

  test('quantity -1 is open', async () => {
    expect(await reconcileClose({ fetchPositions, row: NHPC, sleep })).toBe('open')
  })

  test('a book that cannot be read is unknown', async () => {
    const failing = async () => {
      throw network()
    }
    expect(await reconcileClose({ fetchPositions: failing, row: NHPC, sleep })).toBe('unknown')
  })

  test('waits 2 s before its first read, as the books lag', async () => {
    const order: string[] = []
    const logged = async (ms: number) => {
      order.push(`sleep ${ms}`)
    }
    const read = jest.fn(async () => {
      order.push('read')
      return nhpcAt('0')
    })
    expect(await reconcileClose({ fetchPositions: read, row: NHPC, sleep: logged })).toBe('closed')
    expect(order).toEqual(['sleep 2000', 'read'])
  })

  test('a book still showing the old quantity is read again: closed on the 2nd read', async () => {
    const fetchPositions = positionReads(nhpcAt('-1'), nhpcAt('0'))
    expect(await reconcileClose({ fetchPositions, row: NHPC, sleep })).toBe('closed')
    expect(fetchPositions).toHaveBeenCalledTimes(2)
    expect(delays()).toEqual([2000, 5000])
  })

  test('open only after every read showed it open', async () => {
    const fetchPositions = positionReads(nhpcAt('-1'))
    expect(await reconcileClose({ fetchPositions, row: NHPC, sleep })).toBe('open')
    expect(fetchPositions).toHaveBeenCalledTimes(3)
    expect(delays()).toEqual([2000, 5000, 10000])
  })

  test('a failed read is skipped: the answer is the last read that worked', async () => {
    const lateClose = positionReads(network(), nhpcAt('0'))
    expect(await reconcileClose({ fetchPositions: lateClose, row: NHPC, sleep })).toBe('closed')
    expect(lateClose).toHaveBeenCalledTimes(2)
    const openThenFail = positionReads(nhpcAt('-1'), network())
    expect(await reconcileClose({ fetchPositions: openThenFail, row: NHPC, sleep })).toBe('open')
    expect(openThenFail).toHaveBeenCalledTimes(3)
    const never = positionReads(network())
    expect(await reconcileClose({ fetchPositions: never, row: NHPC, sleep })).toBe('unknown')
    expect(never).toHaveBeenCalledTimes(3)
  })

  test('the row missing while a row could not be read is unknown, never closed', async () => {
    const withUnreadable = PositionbookSchema.parse({
      status: 'success',
      data: [{ exchange: 'NSE', product: 'MIS', quantity: '-1' }],
    })
    expect(withUnreadable.dropped).toBe(1)
    const fetchPositions = positionReads(withUnreadable)
    expect(await reconcileClose({ fetchPositions, row: NHPC, sleep })).toBe('unknown')
    expect(fetchPositions).toHaveBeenCalledTimes(3)
    // the row there at 0 is closed, whatever else could not be read
    const zero = PositionbookSchema.parse({
      status: 'success',
      data: [
        { symbol: 'NHPC', exchange: 'NSE', product: 'MIS', quantity: '0' },
        { exchange: 'NSE', product: 'MIS', quantity: '-1' },
      ],
    })
    expect(await reconcileClose({ fetchPositions: positionReads(zero), row: NHPC, sleep })).toBe(
      'closed',
    )
  })

  test('takes the delays it is given', async () => {
    const fetchPositions = positionReads(nhpcAt('-1'))
    const delaysMs = [200, 500, 1000]
    expect(await reconcileClose({ fetchPositions, row: NHPC, sleep, delaysMs })).toBe('open')
    expect(delays()).toEqual(delaysMs)
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

describe('reconcileRowChange', () => {
  /** The order as it was when the write went: open, LIMIT 10 @ 1420. */
  const BEFORE = book(raw({ orderid: 'A' })).orders[0] as NonNullable<Orderbook['orders'][number]>
  const delays = () => sleep.mock.calls.map(([ms]) => ms)

  test('a book that lags the write: the reads go on until it shows the order changed', async () => {
    const fetchOrders = fetches(
      book(raw({ orderid: 'A' })),
      book(raw({ orderid: 'A' })),
      book(raw({ orderid: 'A', price: 1425 })),
    )
    const out = await reconcileRowChange({ fetchOrders, before: BEFORE, sleep })
    expect(out).toEqual({ found: expect.objectContaining({ price: 1425 }), checked: true })
    expect(fetchOrders).toHaveBeenCalledTimes(3)
    expect(delays()).toEqual([2000, 5000, 10000])
  })

  test.each([
    ['status', { order_status: 'cancelled' }],
    ['type', { pricetype: 'MARKET' }],
    ['quantity', { quantity: '20' }],
    ['trigger', { trigger_price: 1410 }],
  ])('a changed %s stops at that read', async (_what, change) => {
    const fetchOrders = fetches(book(raw({ orderid: 'A', ...change })))
    const out = await reconcileRowChange({ fetchOrders, before: BEFORE, sleep })
    expect(out).toEqual({ found: expect.objectContaining({ orderid: 'A' }), checked: true })
    expect(fetchOrders).toHaveBeenCalledTimes(1)
    expect(delays()).toEqual([2000])
  })

  test('an order gone from the book is null, at the first read that shows it gone', async () => {
    const fetchOrders = fetches(book(raw({ orderid: 'A' })), book(raw({ orderid: 'B' })))
    expect(await reconcileRowChange({ fetchOrders, before: BEFORE, sleep })).toEqual({
      found: null,
      checked: true,
    })
    expect(fetchOrders).toHaveBeenCalledTimes(2)
  })

  test('unchanged after every delay: the row as the last read showed it', async () => {
    const fetchOrders = fetches(book(raw({ orderid: 'A' })))
    const out = await reconcileRowChange({ fetchOrders, before: BEFORE, sleep, delaysMs: [1, 2] })
    expect(out).toEqual({ found: expect.objectContaining({ price: 1420 }), checked: true })
    expect(fetchOrders).toHaveBeenCalledTimes(2)
  })

  test('a failed read is skipped; none working is unchecked', async () => {
    const skipped = fetches(network(), book(raw({ orderid: 'A', order_status: 'complete' })))
    expect(await reconcileRowChange({ fetchOrders: skipped, before: BEFORE, sleep })).toEqual({
      found: expect.objectContaining({ status: 'complete' }),
      checked: true,
    })
    const down = fetches(network())
    expect(await reconcileRowChange({ fetchOrders: down, before: BEFORE, sleep })).toEqual({
      found: null,
      checked: false,
    })
    expect(down).toHaveBeenCalledTimes(3)
  })
})

describe('findWorkingExit', () => {
  const ROW = { symbol: 'RELIANCE', exchange: 'NSE', product: 'MIS' }
  const run = (b: Orderbook | Error, side: 'BUY' | 'SELL' = 'SELL') =>
    findWorkingExit({ fetchOrders: fetches(b), row: ROW, side, sentAt: SENT_AT })

  test('a working order on the closing side, after the send, whatever its quantity', async () => {
    const exit = raw({ orderid: 'X1', action: 'SELL', pricetype: 'MARKET', quantity: '7' })
    expect(await run(book(exit))).toMatchObject({ found: { orderid: 'X1' }, checked: true })
    // the sandbox stamps a time that does not parse: it cannot be ruled out
    const sandbox = raw({ orderid: 'S1', action: 'SELL', timestamp: '2026-11-25 09:30:01' })
    expect((await run(book(sandbox))).found?.orderid).toBe('S1')
  })

  test.each([
    ['the other side', { action: 'BUY' }],
    ['another product', { product: 'CNC', action: 'SELL' }],
    ['a filled order', { order_status: 'complete', action: 'SELL' }],
    ['a rejected order', { order_status: 'rejected', action: 'SELL' }],
    ['an order from before the send', { action: 'SELL', timestamp: '25-Nov-2026 09:27:00' }],
  ])('%s is not a working exit', async (_what, change) => {
    expect(await run(book(raw(change)))).toEqual({ found: null, checked: true })
  })

  test('a book that cannot be read, or has unreadable rows and no exit, could not check', async () => {
    expect(await run(network())).toEqual({ found: null, checked: false })
    expect(await run(book(unreadable()))).toEqual({ found: null, checked: false })
  })
})

describe('reconcileRowChange and reconcileCancelAll with unreadable rows', () => {
  const BEFORE = book(raw({ orderid: 'A' })).orders[0] as NonNullable<Orderbook['orders'][number]>

  test('an order missing while a row could not be read is not "gone"', async () => {
    const fetchOrders = fetches(book(raw({ orderid: 'B' }), unreadable()))
    expect(await reconcileRowChange({ fetchOrders, before: BEFORE, sleep })).toEqual({
      found: null,
      checked: false,
    })
    expect(fetchOrders).toHaveBeenCalledTimes(3)
  })

  test('none working while a row could not be read is not "all cancelled"', async () => {
    const fetchOrders = fetches(
      book(raw({ orderid: 'A', order_status: 'cancelled' }), unreadable()),
    )
    expect(await reconcileCancelAll({ fetchOrders, sleep })).toEqual({ found: 0, checked: false })
  })
})

describe('reconcileCancelAll', () => {
  const twoOpen = () =>
    book(raw({ orderid: 'A' }), raw({ orderid: 'B', order_status: 'trigger pending' }))

  test('reads until the book shows none working', async () => {
    const fetchOrders = fetches(
      twoOpen(),
      book(
        raw({ orderid: 'A', order_status: 'cancelled' }),
        raw({ orderid: 'C', order_status: 'complete' }),
      ),
    )
    expect(await reconcileCancelAll({ fetchOrders, sleep })).toEqual({ found: 0, checked: true })
    expect(fetchOrders).toHaveBeenCalledTimes(2)
  })

  test('still open after every delay: the count the last read showed; none read is unchecked', async () => {
    const open = fetches(twoOpen())
    expect(await reconcileCancelAll({ fetchOrders: open, sleep })).toEqual({
      found: 2,
      checked: true,
    })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 5000, 10000])
    expect(await reconcileCancelAll({ fetchOrders: fetches(network()), sleep })).toEqual({
      found: 0,
      checked: false,
    })
  })
})
