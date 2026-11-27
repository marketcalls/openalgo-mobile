import { QueryClient } from '@tanstack/react-query'
import { clearProfileCache } from './invalidate'
import { qk } from './keys'

const A = 'prof-a'
const B = 'prof-b'

describe('qk', () => {
  const all = (pid: string) => [
    qk.root(pid),
    qk.caps(pid),
    qk.analyzer(pid),
    qk.funds(pid),
    qk.ping(pid),
    qk.multiquotes(pid, ['NSE:RELIANCE', 'NSE:TCS']),
    qk.quotes(pid, 'NSE', 'RELIANCE'),
    qk.depth(pid, 'NSE', 'RELIANCE'),
    qk.symbol(pid, 'NSE', 'RELIANCE'),
    qk.search(pid, 'rel'),
    qk.search(pid, 'rel', 'NSE'),
    qk.orderbook(pid),
    qk.tradebook(pid),
    qk.positionbook(pid),
    qk.holdings(pid),
    qk.orderstatus(pid, '123'),
    qk.gttbook(pid),
    qk.intervals(pid),
    qk.calendar(pid, '2026-11-27'),
    qk.gttdetect(pid, 'https://algo.example.com', 'zerodha', 'live', 1),
    qk.expiry(pid, 'NFO', 'NIFTY', 'options'),
    qk.optionchain(pid, 'NFO', 'NIFTY', '30DEC26', 10, false),
  ]

  it('starts every key with [p, pid]', () => {
    expect(qk.root(A)).toEqual(['p', A])
    for (const k of all(A)) expect(k.slice(0, 2)).toEqual(['p', A])
  })

  it('the GTT book is its own key, beside the order books', () => {
    expect(qk.gttbook(A)).toEqual(['p', A, 'gttbook'])
  })

  it('the GTT support read is not under the GTT book, so a book poke or reset misses it', () => {
    const k = qk.gttdetect(A, 'https://algo.example.com', 'zerodha', 'analyze', 7)
    expect(k).toEqual(['p', A, 'gttdetect', 'https://algo.example.com', 'zerodha', 'analyze', 7])
    expect(k.slice(0, 3)).not.toEqual(qk.gttbook(A))
  })

  it('expiries are per exchange, underlying and kind', () => {
    expect(qk.expiry(A, 'NFO', 'NIFTY', 'futures')).toEqual([
      'p',
      A,
      'expiry',
      'NFO',
      'NIFTY',
      'futures',
    ])
    expect(qk.expiry(A, 'NFO', 'NIFTY', 'options')).not.toEqual(
      qk.expiry(A, 'NFO', 'NIFTY', 'futures'),
    )
  })

  it('a chain with Greeks is its own entry beside the same chain without (preflight 19)', () => {
    const plain = qk.optionchain(A, 'NFO', 'NIFTY', '30DEC26', 25, false)
    expect(plain).toEqual(['p', A, 'optionchain', 'NFO', 'NIFTY', '30DEC26', 25, false])
    expect(qk.optionchain(A, 'NFO', 'NIFTY', '30DEC26', 25, true)).not.toEqual(plain)
    expect(qk.optionchain(A, 'NFO', 'NIFTY', '30DEC26', 20, false)).not.toEqual(plain)
  })

  it('contains no 64-hex string', () => {
    for (const k of all(A)) expect(JSON.stringify(k)).not.toMatch(/[0-9a-f]{64}/)
  })
})

describe('clearProfileCache', () => {
  it('clears only its own profile', () => {
    const qc = new QueryClient()
    qc.setQueryData(qk.funds(A), 1)
    qc.setQueryData(qk.holdings(A), 2)
    qc.setQueryData(qk.funds(B), 3)
    clearProfileCache(qc, A)
    expect(qc.getQueryData(qk.funds(A))).toBeUndefined()
    expect(qc.getQueryData(qk.holdings(A))).toBeUndefined()
    expect(qc.getQueryData(qk.funds(B))).toBe(3)
    // Each cached query holds a real 5-minute gc timer, which would keep the worker alive.
    qc.clear()
  })
})
