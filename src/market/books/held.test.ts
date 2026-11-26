import { heldQuantities } from './held'
import type { HoldingRow, PositionRow } from './schemas'

const hold = (symbol: string, quantity: number): HoldingRow =>
  ({ symbol, exchange: 'NSE', product: 'CNC', quantity }) as HoldingRow
const pos = (symbol: string, quantity: number, product: string): PositionRow =>
  ({ symbol, exchange: 'NSE', product, quantity }) as PositionRow

describe('heldQuantities', () => {
  it('uses the holdings quantity', () => {
    expect(heldQuantities([hold('RELIANCE', 10)], []).get('NSE:RELIANCE')).toBe(10)
  })

  it('sums signed position quantities across products', () => {
    const m = heldQuantities([], [pos('TCS', -50, 'MIS'), pos('TCS', 20, 'NRML')])
    expect(m.get('NSE:TCS')).toBe(-30)
  })

  it('leaves a closed position out', () => {
    expect(heldQuantities([], [pos('INFY', 0, 'MIS')]).has('NSE:INFY')).toBe(false)
  })

  it('prefers holdings over a position in the same symbol', () => {
    expect(heldQuantities([hold('SBIN', 5)], [pos('SBIN', 5, 'CNC')]).get('NSE:SBIN')).toBe(5)
  })

  it('is empty without books', () => {
    expect(heldQuantities(undefined, undefined).size).toBe(0)
  })
})
