import { liveHoldingPnl, livePositionPnl, totals } from './livePnl'

const pos = (o: Record<string, number | undefined> = {}) => ({
  quantity: 10,
  average_price: 100,
  ltp: 101,
  pnl: 9,
  pnlpercent: 0.9,
  lot_size: undefined,
  today_realized_pnl: undefined,
  ...o,
})

describe('livePositionPnl', () => {
  test('a long is (ltp - avg) x qty, against |avg x qty|', () => {
    expect(livePositionPnl(pos(), 105)).toEqual({ ltp: 105, pnl: 50, pnlPct: 5, live: true })
  })

  test('a short is (avg - ltp) x |qty|', () => {
    const r = livePositionPnl(pos({ quantity: -104, average_price: 17.2 }), 17.31)
    expect(r.pnl).toBeCloseTo(-11.44, 6)
    expect(r.live).toBe(true)
  })

  test('a closed row keeps the REST pnl, with the live ltp', () => {
    const r = livePositionPnl(pos({ quantity: 0, average_price: 0, pnl: 5.9, pnlpercent: 1 }), 1200)
    expect(r).toEqual({ ltp: 1200, pnl: 5.9, pnlPct: 1, live: false })
  })

  test("today's realised P&L is added", () => {
    expect(livePositionPnl(pos({ today_realized_pnl: 20 }), 105).pnl).toBe(70)
  })

  test('lot_size scales the P&L', () => {
    const r = livePositionPnl(pos({ quantity: 2, average_price: 3000, lot_size: 0.01 }), 3100)
    expect(r.pnl).toBeCloseTo(2, 9)
  })

  test('no average price keeps the REST pnl', () => {
    const r = livePositionPnl(pos({ quantity: 5, average_price: 0, pnl: 3 }), 100)
    expect(r.pnl).toBe(3)
    expect(r.live).toBe(false)
  })

  test('without a tick the row is as the REST book has it', () => {
    expect(livePositionPnl(pos())).toEqual({ ltp: 101, pnl: 9, pnlPct: 0.9, live: false })
  })
})

describe('liveHoldingPnl', () => {
  const h = { quantity: 5, average_price: 100, ltp: 90, pnl: -50, pnlpercent: -10 }

  test('recomputes from the average price', () => {
    expect(liveHoldingPnl(h, 110)).toEqual({ ltp: 110, pnl: 50, pnlPct: 10, live: true })
  })

  test('without an average price it keeps the REST figures', () => {
    const r = liveHoldingPnl({ ...h, average_price: undefined }, 110)
    expect(r).toEqual({ ltp: 110, pnl: -50, pnlPct: -10, live: false })
  })
})

test('totals adds the pnl of each row, skipping an unreadable one', () => {
  expect(totals([{ pnl: 1.5 }, { pnl: -0.5 }, { pnl: undefined }])).toBe(1)
})
