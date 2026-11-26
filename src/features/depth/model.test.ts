import { ticketHref } from '~/market/links'
import { ladderRows, levelTicket } from './model'

describe('ladderRows', () => {
  const depth = {
    buy: [
      { price: 1423.9, quantity: 200, orders: 4 },
      { price: 1423.8, quantity: 50, orders: 1 },
      { price: 1423.7, quantity: 100 },
    ],
    sell: [
      { price: 1424, quantity: 10, orders: 2 },
      { price: 1424.1, quantity: 40, orders: 3 },
    ],
  }

  test("each level's share is its quantity over its own side's largest", () => {
    const r = ladderRows(depth, 5)
    expect(r.bids.map((l) => l.share)).toEqual([1, 0.25, 0.5])
    expect(r.asks.map((l) => l.share)).toEqual([0.25, 1])
  })

  test('keeps price, quantity and orders; a level without orders has none', () => {
    const r = ladderRows(depth, 5)
    expect(r.bids[0]).toEqual({ price: 1423.9, quantity: 200, orders: 4, share: 1 })
    expect(r.bids[2]).toEqual({ price: 1423.7, quantity: 100, share: 0.5 })
  })

  test('at most n levels a side, the share taken over those shown', () => {
    const r = ladderRows(depth, 1)
    expect(r.bids).toEqual([{ price: 1423.9, quantity: 200, orders: 4, share: 1 }])
    expect(r.asks).toEqual([{ price: 1424, quantity: 10, orders: 2, share: 1 }])
  })

  test('an empty side, or a side of zero quantities, has no bars', () => {
    const r = ladderRows({ buy: [{ price: 10, quantity: 0 }], sell: [] }, 5)
    expect(r.bids).toEqual([{ price: 10, quantity: 0, share: 0 }])
    expect(r.asks).toEqual([])
    expect(ladderRows(undefined, 5)).toEqual({ bids: [], asks: [] })
  })
})

describe('levelTicket', () => {
  test('a bid presets SELL LIMIT at its price; an ask BUY LIMIT', () => {
    expect(ticketHref(levelTicket('bid', 1423.9, 'NSE', 'RELIANCE'))).toBe(
      ticketHref({
        exchange: 'NSE',
        symbol: 'RELIANCE',
        action: 'SELL',
        pricetype: 'LIMIT',
        price: 1423.9,
      }),
    )
    expect(levelTicket('ask', 1424, 'NSE', 'RELIANCE')).toEqual({
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'BUY',
      pricetype: 'LIMIT',
      price: 1424,
    })
  })
})
