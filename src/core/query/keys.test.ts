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
  ]

  it('starts every key with [p, pid]', () => {
    expect(qk.root(A)).toEqual(['p', A])
    for (const k of all(A)) expect(k.slice(0, 2)).toEqual(['p', A])
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
  })
})
