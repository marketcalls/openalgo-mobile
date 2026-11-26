import { OrderbookSchema, PositionbookSchema } from '../books/schemas'
import { chartOrders, chartPositions } from './lines'

const RELIANCE = { exchange: 'NSE', symbol: 'RELIANCE' }

/** An orderbook row as the stock server sends it; a key set to undefined is left out. */
const order = (o: Record<string, unknown>) => ({
  action: 'BUY',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  orderid: 'A1',
  product: 'CNC',
  quantity: '1',
  price: 1400,
  pricetype: 'LIMIT',
  order_status: 'open',
  trigger_price: 0,
  timestamp: '24-Nov-2026 09:30:00',
  ...o,
})
const ordersOf = (rows: unknown[]) =>
  OrderbookSchema.parse({ status: 'success', data: { orders: rows, statistics: {} } }).orders

const position = (o: Record<string, unknown>) => ({
  symbol: 'RELIANCE',
  exchange: 'NSE',
  product: 'CNC',
  quantity: '10',
  average_price: '1398.5',
  ...o,
})
const positionsOf = (rows: unknown[]) =>
  PositionbookSchema.parse({ status: 'success', data: rows }).rows

test('chartOrders keeps the working orders of the instrument; chartPositions keeps net ≠ 0 per product', () => {
  const orders = ordersOf([
    order({ orderid: 'A1', quantity: '5' }),
    // a stop sits at its trigger
    order({
      orderid: 'S1',
      action: 'SELL',
      pricetype: 'SL',
      price: 1380,
      trigger_price: 1385,
      order_status: 'trigger pending',
    }),
    order({ orderid: 'M1', pricetype: 'SL-M', price: 0, trigger_price: 1420 }),
    // a LIMIT row with a stray trigger stays at its price
    order({ orderid: 'L2', price: 1401, trigger_price: 1399 }),
    // gone: not working
    order({ orderid: 'C1', order_status: 'complete' }),
    order({ orderid: 'X1', order_status: 'cancelled' }),
    // another instrument
    order({ orderid: 'O1', symbol: 'INFY' }),
    order({ orderid: 'O2', exchange: 'BSE' }),
    // nothing to draw a line at
    order({ orderid: 'K1', pricetype: 'MARKET', price: 0 }),
    order({ orderid: 'K2', price: undefined }),
  ])
  expect(chartOrders(orders, RELIANCE)).toEqual([
    { id: 'A1', side: 'BUY', type: 'LIMIT', qty: 5, price: 1400, trigger: null },
    { id: 'S1', side: 'SELL', type: 'SL', qty: 1, price: 1380, trigger: 1385 },
    { id: 'M1', side: 'BUY', type: 'SL-M', qty: 1, price: 0, trigger: 1420 },
    { id: 'L2', side: 'BUY', type: 'LIMIT', qty: 1, price: 1401, trigger: null },
  ])
  expect(chartOrders(orders, { exchange: 'NSE', symbol: 'TCS' })).toEqual([])

  const positions = positionsOf([
    position({ product: 'CNC', quantity: '10' }),
    position({ product: 'MIS', quantity: '-4', average_price: '1402' }),
    // flat
    position({ product: 'NRML', quantity: '0' }),
    // another instrument, and a product the chart cannot close
    position({ symbol: 'INFY' }),
    position({ product: 'CO', quantity: '3' }),
    // no average to draw it at
    position({
      symbol: 'RELIANCE',
      exchange: 'NSE',
      product: 'NRML',
      quantity: '2',
      average_price: '',
    }),
    // one line per product: a second row of a product is not drawn over the first
    position({ product: 'CNC', quantity: '99', average_price: '1' }),
  ])
  expect(chartPositions(positions, RELIANCE)).toEqual([
    { product: 'CNC', net: 10, avg: 1398.5 },
    { product: 'MIS', net: -4, avg: 1402 },
  ])
})
