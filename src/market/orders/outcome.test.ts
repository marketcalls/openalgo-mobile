import { ApiError, userMessage } from '~/core/http/errors'
import { type Orderbook, OrderbookSchema, type OrderRow } from '../books/schemas'
import {
  CHECKING,
  checkOrder,
  errorText,
  modeChanged,
  NOT_CHECKED,
  NOT_IN_BOOK,
  orderTerms,
  type Settled,
  settle,
} from './outcome'
import type { IdReply } from './schemas'
import { type Outcome, submitOrderAction } from './submit'

/** One orderbook row as the server sends it (C6): an open BUY LIMIT 1 YESBANK @ 16.50. */
const raw = (o: Record<string, unknown> = {}) => ({
  action: 'BUY',
  symbol: 'YESBANK',
  exchange: 'NSE',
  orderid: 'A1',
  product: 'MIS',
  quantity: '1',
  price: 16.5,
  pricetype: 'LIMIT',
  order_status: 'open',
  trigger_price: 0,
  timestamp: '25-Nov-2026 09:30:00',
  ...o,
})
const book = (...rows: object[]): Orderbook =>
  OrderbookSchema.parse({ status: 'success', data: { orders: rows, statistics: {} } })
const rowOf = (o: Record<string, unknown> = {}) => book(raw(o)).orders[0] as OrderRow

/** A read answering each call with the next book (the last one repeats); an Error rejects. */
function reads(...books: (Orderbook | Error)[]) {
  let i = 0
  return jest.fn(async () => {
    const b = books[Math.min(i++, books.length - 1)]
    if (b === undefined || b instanceof Error) throw b ?? new Error('no book')
    return b
  })
}

const MAYBE_PLACED = new ApiError({ kind: 'MaybePlaced', status: 502, endpoint: 'modifyorder' })
const SERVER = new ApiError({ kind: 'Server', status: 500, endpoint: 'modifyorder' })
const NO_ID: IdReply = { kind: 'no_id' }
const noId = (r: IdReply) => r.kind === 'no_id'

/** No wait between the check's reads. */
const NOW = [0, 0, 0]

describe('settle', () => {
  test('MaybePlaced, a Server error from the write itself, and a success without an id: maybe', () => {
    // no reply from the server's order logic: it may still be sending, so the check reads longer
    expect(settle({ kind: 'maybe' }, 'modifyorder', noId)).toEqual({ kind: 'maybe', noReply: true })
    expect(settle({ kind: 'error', error: SERVER }, 'modifyorder', noId)).toEqual({
      kind: 'maybe',
      noReply: false,
    })
    expect(settle({ kind: 'done', reply: NO_ID }, 'modifyorder', noId)).toEqual({
      kind: 'maybe',
      noReply: false,
    })
  })

  test('a Server error from another endpoint, or any other error, is refused with its message', () => {
    const analyzer = new ApiError({ kind: 'Server', status: 500, endpoint: 'analyzer' })
    expect(settle({ kind: 'error', error: analyzer }, 'modifyorder')).toEqual({
      kind: 'refused',
      message: userMessage(analyzer),
    })
    const bad = new ApiError({
      kind: 'Validation',
      status: 400,
      endpoint: 'modifyorder',
      serverMessage: 'Invalid price',
    })
    expect(settle({ kind: 'error', error: bad }, 'modifyorder')).toEqual({
      kind: 'refused',
      message: userMessage(bad),
    })
  })

  test('a reply with an id is ok, with the LIVE surprise when the server took it LIVE', () => {
    const reply: IdReply = { kind: 'ok', orderid: 'A1', analyze: false }
    expect(settle({ kind: 'done', reply }, 'modifyorder', noId)).toEqual({ kind: 'ok', reply })
    expect(settle({ kind: 'done', reply, liveSurprise: true }, 'modifyorder', noId)).toEqual({
      kind: 'ok',
      reply,
      liveSurprise: true,
    })
  })

  test('without `unknown`, a success is ok whatever its reply', () => {
    expect(settle({ kind: 'done', reply: NO_ID }, 'cancelorder')).toEqual({
      kind: 'ok',
      reply: NO_ID,
    })
  })

  test('Semi-Auto, a mode change and a cancelled live confirm pass through', () => {
    const cases: Outcome<IdReply>[] = [
      { kind: 'semi_auto_blocked', message: 'Semi-Auto' },
      { kind: 'mode_changed', now: 'analyze' },
      { kind: 'cancelled', message: 'no' },
      { kind: 'cancelled' },
    ]
    for (const out of cases) expect(settle(out, 'modifyorder', noId)).toEqual(out)
  })

  test.each([
    ['MaybePlaced', () => Promise.reject(MAYBE_PLACED)],
    ['a Server error', () => Promise.reject(SERVER)],
    ['a success without an id', () => Promise.resolve(NO_ID)],
  ])(
    '%s is reconciled against the book, and the write is never sent again',
    async (_what, reply) => {
      const send = jest.fn(reply)
      const out = await submitOrderAction<IdReply>({
        kind: 'modify',
        shownMode: 'live',
        send,
        gate: { read: async () => 'live', noteReply: jest.fn(), invalidate: jest.fn() },
        confirmLive: async () => 'ok',
        books: { poke: jest.fn() },
      })
      const r: Settled<IdReply> = settle(out, 'modifyorder', noId)
      expect(r).toMatchObject({ kind: 'maybe' })
      // what a screen does with maybe: it reads the book, and only reads it
      const readBook = reads(book(raw()), book(raw({ price: 17 })))
      const line = await checkOrder({
        readBook,
        before: rowOf(),
        sent: { pricetype: 'LIMIT', quantity: 1, price: 17, trigger_price: 0 },
        delaysMs: NOW,
      })
      expect(line).toBe('Order status: open · Now LIMIT 1 @ 17.00 · Sent LIMIT 1 @ 17.00')
      expect(readBook).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenCalledTimes(1)
    },
  )
})

describe('checkOrder', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  /** Runs the check over the real delays, the clock moved on by hand. */
  async function run(p: Promise<string>, ms: number) {
    let line: string | undefined
    void p.then((l) => {
      line = l
    })
    await jest.advanceTimersByTimeAsync(ms)
    return line
  }

  test("a book that lags past 2 s still reports the change, at T10's next delay", async () => {
    const readBook = reads(book(raw()), book(raw({ order_status: 'cancelled' })))
    const check = checkOrder({ readBook, before: rowOf() })
    expect(await run(check, 2_000)).toBeUndefined()
    expect(readBook).toHaveBeenCalledTimes(1)
    expect(await run(check, 5_000)).toBe('Order status: cancelled')
    expect(readBook).toHaveBeenCalledTimes(2)
  })

  test("a modify's line has the type, quantity and price now beside what was sent", async () => {
    const readBook = reads(book(raw({ quantity: '2', price: 17.05 })))
    const sent = { pricetype: 'LIMIT' as const, quantity: 2, price: 17.05, trigger_price: 0 }
    const check = checkOrder({ readBook, before: rowOf(), sent })
    expect(await run(check, 2_000)).toBe(
      'Order status: open · Now LIMIT 2 @ 17.05 · Sent LIMIT 2 @ 17.05',
    )
  })

  test('a change that never shows: after every delay, the order as it is beside what was sent', async () => {
    const readBook = reads(book(raw()))
    const sent = { pricetype: 'LIMIT' as const, quantity: 1, price: 17, trigger_price: 0 }
    const check = checkOrder({ readBook, before: rowOf(), sent })
    expect(await run(check, 16_999)).toBeUndefined()
    expect(await run(check, 1)).toBe(
      'Order status: open · Now LIMIT 1 @ 16.50 · Sent LIMIT 1 @ 17.00',
    )
    expect(readBook).toHaveBeenCalledTimes(3)
  })

  test('gone from the book, and a book that cannot be read', async () => {
    const gone = checkOrder({ readBook: reads(book(raw({ orderid: 'B1' }))), before: rowOf() })
    expect(await run(gone, 2_000)).toBe(NOT_IN_BOOK)
    const down = new ApiError({ kind: 'Network', status: 0, endpoint: 'orderbook' })
    const failing = reads(down)
    const unread = checkOrder({ readBook: failing, before: rowOf() })
    expect(await run(unread, 17_000)).toBe(NOT_CHECKED)
    expect(failing).toHaveBeenCalledTimes(3)
  })
})

describe('orderTerms', () => {
  test("each type with the prices it carries, lots when the contract trades in them, '--' unread", () => {
    const fut = { tick: 0.05, lots: true, lotsize: 65 }
    expect(orderTerms({ pricetype: 'LIMIT', quantity: 130, price: 24000 }, fut)).toBe(
      'LIMIT 2L (130) @ 24,000.00',
    )
    expect(
      orderTerms({ pricetype: 'SL', quantity: 1, price: 17, trigger_price: 16.9 }, undefined),
    ).toBe('SL 1 @ 17.00 trigger 16.90')
    expect(orderTerms({ pricetype: 'sl-m', quantity: 1, trigger_price: 16.9 })).toBe(
      'SL-M 1 @ 16.90',
    )
    expect(orderTerms({ pricetype: 'MARKET', quantity: 1, price: 0 })).toBe('MARKET 1')
    expect(orderTerms({ pricetype: 'LIMIT', quantity: 1 })).toBe('LIMIT 1 @ --')
    expect(orderTerms({ pricetype: '', quantity: 1 })).toBe('-- 1')
  })
})

describe('copy', () => {
  test("A-T7's MaybePlaced copy, verbatim; the mode change and an unknown error", () => {
    expect(CHECKING).toBe('Status unknown: checking order book')
    expect(modeChanged('analyze')).toBe('The server is now in ANALYZE mode. Nothing was sent.')
    expect(errorText(new Error('x'))).toBe('Something went wrong.')
  })
})
