import { act, renderHook } from '@testing-library/react-native'
import type { Trading } from '../trading'
import {
  holdOrder,
  NEW_ORDER,
  onOrder,
  otherOrderOut,
  takeUnseenOutcome,
  useScopesOut,
  useUnseenOutcome,
} from './pending'

/** A session: the registry keys on the Trading container's identity only. */
const session = () => ({}) as Trading

describe('writes still out, by scope', () => {
  test("another owner's write on the same scope is out; its own, or another scope's, is not", () => {
    const t = session()
    const ticket = {}
    const sheet = {}
    const release = holdOrder(t, ticket)
    expect(otherOrderOut(t, sheet)).toBe(true)
    expect(otherOrderOut(t, sheet, NEW_ORDER)).toBe(true)
    expect(otherOrderOut(t, ticket)).toBe(false)
    expect(otherOrderOut(t, sheet, onOrder('A1'))).toBe(false)

    const modify = holdOrder(t, sheet, onOrder('A1'))
    expect(otherOrderOut(t, ticket, onOrder('A1'))).toBe(true)
    expect(otherOrderOut(t, ticket, onOrder('B1'))).toBe(false)
    release()
    modify()
    expect(otherOrderOut(t, sheet)).toBe(false)
    expect(otherOrderOut(t, ticket, onOrder('A1'))).toBe(false)
  })

  test('each session keeps its own', () => {
    const a = session()
    const b = session()
    holdOrder(a, {}, onOrder('A1'))
    expect(otherOrderOut(a, {}, onOrder('A1'))).toBe(true)
    expect(otherOrderOut(b, {}, onOrder('A1'))).toBe(false)
  })

  test("a second release does nothing, and does not end another hold's", () => {
    const t = session()
    const owner = {}
    const first = holdOrder(t, owner, onOrder('A1'))
    first('Order modified')
    const second = holdOrder(t, owner, onOrder('A1'))
    first('again')
    expect(otherOrderOut(t, {}, onOrder('A1'))).toBe(true)
    expect(takeUnseenOutcome(t, onOrder('A1'))).toBe('Order modified')
    second()
    expect(otherOrderOut(t, {}, onOrder('A1'))).toBe(false)
  })

  test('an unseen outcome is kept on its scope, and taken once', () => {
    const t = session()
    holdOrder(t, {}, onOrder('A1'))('Order status: open')
    holdOrder(t, {})('Order placed: 1')
    expect(takeUnseenOutcome(t, onOrder('B1'))).toBeNull()
    expect(takeUnseenOutcome(t, onOrder('A1'))).toBe('Order status: open')
    expect(takeUnseenOutcome(t, onOrder('A1'))).toBeNull()
    expect(takeUnseenOutcome(t)).toBe('Order placed: 1')
    // a release without a line keeps none
    holdOrder(t, {}, onOrder('A1'))()
    expect(takeUnseenOutcome(t, onOrder('A1'))).toBeNull()
  })
})

describe('the hooks', () => {
  test('useScopesOut follows the holds; useUnseenOutcome follows its scope', async () => {
    const t = session()
    const out = await renderHook(() => useScopesOut(t))
    const unseen = await renderHook(() => useUnseenOutcome(t, onOrder('A1')))
    expect([...out.result.current]).toEqual([])
    let release: (line?: string | null) => void = () => {}
    await act(async () => {
      release = holdOrder(t, {}, onOrder('A1'))
    })
    expect([...out.result.current]).toEqual([onOrder('A1')])
    // the snapshot is the same set until something changes
    const before = out.result.current
    await out.rerender({})
    expect(out.result.current).toBe(before)
    await act(async () => release('Order modified'))
    expect([...out.result.current]).toEqual([])
    expect(unseen.result.current).toBe('Order modified')
    await act(async () => {
      takeUnseenOutcome(t, onOrder('A1'))
    })
    expect(unseen.result.current).toBeNull()
  })
})
