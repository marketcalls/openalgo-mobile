import { z } from 'zod'
import { num } from '~/core/http/coerce'
import holdings from '../../../test/fixtures/openalgo-docs/holdings.json'
import orderbook from '../../../test/fixtures/openalgo-docs/orderbook.json'
import positionbook from '../../../test/fixtures/openalgo-docs/positionbook.json'
import tradebook from '../../../test/fixtures/openalgo-docs/tradebook.json'
import {
  HoldingsSchema,
  isWorking,
  lenientRows,
  OrderbookSchema,
  PositionbookSchema,
  TradebookSchema,
  WORKING,
} from './schemas'

const ok = (data: unknown) => ({ status: 'success', data })
const ORDER = {
  action: 'BUY',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  orderid: '250408000989443',
  product: 'MIS',
  quantity: '1',
  price: 1186.0,
  pricetype: 'LIMIT',
  order_status: 'open',
  trigger_price: 0.0,
  timestamp: '08-Apr-2025 13:58:03',
}
const POSITION = { symbol: 'NHPC', exchange: 'NSE', product: 'MIS', quantity: '-1' }
// 08-Apr-2025 13:58:03 IST is 08:28:03 UTC.
const PLACED_AT = Date.UTC(2025, 3, 8, 8, 28, 3)

describe('lenientRows', () => {
  const rows = lenientRows(z.object({ a: num }))

  test('keeps the rows that parse and counts the rest', () => {
    expect(rows.parse([{ a: 1 }, { a: 'x' }, { a: '2' }, 'junk'])).toEqual({
      rows: [{ a: 1 }, { a: 2 }],
      dropped: 2,
    })
  })

  test('an absent or null list is empty', () => {
    expect(rows.parse(undefined)).toEqual({ rows: [], dropped: 0 })
    expect(rows.parse(null)).toEqual({ rows: [], dropped: 0 })
  })
})

describe('OrderbookSchema', () => {
  test('the docs fixture', () => {
    const book = OrderbookSchema.parse(orderbook)
    expect(book.dropped).toBe(0)
    expect(book.orders).toHaveLength(2)
    expect(book.orders[0]).toEqual({
      orderid: '250408000989443',
      symbol: 'RELIANCE',
      exchange: 'NSE',
      action: 'BUY',
      product: 'MIS',
      pricetype: 'MARKET',
      quantity: 1,
      price: 1186,
      trigger_price: 0,
      status: 'complete',
      timestamp: '08-Apr-2025 13:58:03',
      placedAt: PLACED_AT,
    })
    expect(book.orders[1]).toMatchObject({ symbol: 'YESBANK', status: 'cancelled' })
    expect(book.stats).toEqual({
      total_buy_orders: 2,
      total_sell_orders: 0,
      total_completed_orders: 1,
      total_open_orders: 0,
      total_rejected_orders: 0,
    })
  })

  test('(RF 4) one malformed row is kept with its bad fields unset; a row without an id is dropped', () => {
    const { orderid: _, ...noId } = ORDER
    const book = OrderbookSchema.parse(
      ok({
        orders: [
          {
            ...ORDER,
            price: '',
            order_status: ' Trigger Pending',
            timestamp: '2025-04-08 13:58:03',
            quantity: '1.0',
          },
          noId,
        ],
        statistics: {},
      }),
    )
    expect(book.dropped).toBe(1)
    expect(book.orders).toHaveLength(1)
    const [row] = book.orders
    expect(row?.price).toBeUndefined()
    expect(row?.status).toBe('trigger pending')
    expect(row && isWorking(row)).toBe(true)
    expect(row?.placedAt).toBeNull()
    expect(row?.quantity).toBe(1)
  })

  test('missing orders and statistics read as an empty book', () => {
    expect(OrderbookSchema.parse(ok({}))).toEqual({ orders: [], stats: {}, dropped: 0 })
  })

  test('a numeric orderid becomes a string, since modify and cancel send fields.Str', () => {
    const [row] = OrderbookSchema.parse(
      ok({ orders: [{ ...ORDER, orderid: 250408000989443 }] }),
    ).orders
    expect(row?.orderid).toBe('250408000989443')
  })

  test('a lowercase side is read as BUY or SELL; any other side drops the row', () => {
    const book = OrderbookSchema.parse(
      ok({
        orders: [
          { ...ORDER, action: 'sell' },
          { ...ORDER, action: 'HOLD' },
        ],
      }),
    )
    expect(book.orders.map((o) => o.action)).toEqual(['SELL'])
    expect(book.dropped).toBe(1)
  })

  test('a blank orderid, symbol or exchange drops the row', () => {
    const book = OrderbookSchema.parse(
      ok({
        orders: [
          { ...ORDER, orderid: ' ' },
          { ...ORDER, symbol: '' },
          { ...ORDER, exchange: null },
        ],
      }),
    )
    expect(book).toMatchObject({ orders: [], dropped: 3 })
  })

  test('an unreadable optional field is unset, not fatal', () => {
    const [row] = OrderbookSchema.parse(
      ok({ orders: [{ ...ORDER, trigger_price: 'N/A', product: null }] }),
    ).orders
    expect(row).toMatchObject({ trigger_price: undefined, product: '', status: 'open' })
  })

  test('the books accept every number as a string', () => {
    const strings = JSON.parse(
      JSON.stringify(orderbook, (_k, v: unknown) => (typeof v === 'number' ? String(v) : v)),
    )
    expect(OrderbookSchema.parse(strings)).toEqual(OrderbookSchema.parse(orderbook))
  })
})

describe('isWorking', () => {
  test('working means open, pending or trigger pending (C6)', () => {
    expect([...WORKING].sort()).toEqual(['open', 'pending', 'trigger pending'])
    const status = (s: string) => isWorking({ status: s })
    expect(['open', 'pending', 'trigger pending'].map(status)).toEqual([true, true, true])
    expect(['complete', 'rejected', 'cancelled', ''].map(status)).toEqual([
      false,
      false,
      false,
      false,
    ])
  })
})

describe('TradebookSchema', () => {
  test('the docs fixture', () => {
    const book = TradebookSchema.parse(tradebook)
    expect(book.dropped).toBe(0)
    expect(book.rows[0]).toEqual({
      orderid: '250408000989443',
      symbol: 'RELIANCE',
      exchange: 'NSE',
      action: 'BUY',
      product: 'MIS',
      quantity: 1,
      average_price: 1180.1,
      trade_value: 1180.1,
      timestamp: '13:58:03',
    })
    expect(book.rows[1]).toMatchObject({ symbol: 'NHPC', action: 'SELL' })
  })

  test('a trade without an orderid or a side is dropped', () => {
    const [trade] = tradebook.data
    const { orderid: _, ...noId } = trade ?? {}
    const { action: __, ...noSide } = trade ?? {}
    expect(TradebookSchema.parse(ok([noId, noSide, trade]))).toMatchObject({ dropped: 2 })
  })
})

describe('PositionbookSchema', () => {
  test('the docs fixture', () => {
    const book = PositionbookSchema.parse(positionbook)
    expect(book.dropped).toBe(0)
    expect(book.rows).toHaveLength(3)
    expect(book.rows[0]).toEqual({
      symbol: 'NHPC',
      exchange: 'NSE',
      product: 'MIS',
      quantity: -1,
      average_price: 83.74,
      ltp: 83.72,
      pnl: 0.02,
    })
  })

  test('(RF 4) a null pnl is kept as unset', () => {
    const book = PositionbookSchema.parse(ok([{ ...POSITION, pnl: null }]))
    expect(book.dropped).toBe(0)
    expect(book.rows[0]?.pnl).toBeUndefined()
  })

  test('the optional C6 fields parse when present', () => {
    const [row] = PositionbookSchema.parse(
      ok([{ ...POSITION, pnlpercent: '-0.5', lot_size: '75', today_realized_pnl: 20 }]),
    ).rows
    expect(row).toMatchObject({ pnlpercent: -0.5, lot_size: 75, today_realized_pnl: 20 })
  })

  test('a position without a symbol, exchange or product is dropped', () => {
    const { product: _, ...noProduct } = POSITION
    const { exchange: __, ...noExchange } = POSITION
    expect(PositionbookSchema.parse(ok([noProduct, noExchange, POSITION]))).toMatchObject({
      dropped: 2,
    })
  })
})

describe('HoldingsSchema', () => {
  test('the docs fixture', () => {
    const book = HoldingsSchema.parse(holdings)
    expect(book.dropped).toBe(0)
    expect(book.rows).toHaveLength(3)
    expect(book.rows[2]).toEqual({
      symbol: 'CANBK',
      exchange: 'NSE',
      product: 'CNC',
      quantity: 5,
      pnl: -69,
      pnlpercent: -13.43,
    })
    expect(book.stats).toEqual({
      totalholdingvalue: 1768,
      totalinvvalue: 2001,
      totalprofitandloss: -233.15,
      totalpnlpercentage: -11.65,
    })
  })

  test('a holding without a symbol is dropped', () => {
    const [first, ...rest] = holdings.data.holdings
    const { symbol: _, ...noSymbol } = first ?? {}
    const book = HoldingsSchema.parse(ok({ holdings: [noSymbol, ...rest], statistics: {} }))
    expect(book).toMatchObject({ dropped: 1, stats: {} })
    expect(book.rows.map((r) => r.symbol)).toEqual(['TATASTEEL', 'CANBK'])
  })
})
