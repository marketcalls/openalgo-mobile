import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Pressable, Text } from 'react-native'
import { createSubmitGuard, type SubmitGuard, useSubmitGuard } from './guard'

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createSubmitGuard', () => {
  beforeEach(() => jest.useFakeTimers({ now: Date.UTC(2026, 10, 25, 4, 0) }))
  afterEach(() => jest.useRealTimers())

  test('two runs in the same tick: the second is busy and fn runs once', async () => {
    const g = createSubmitGuard()
    const fn = jest.fn(async () => 'sent')
    const first = g.run(fn)
    const second = g.run(fn)
    expect(await second).toBe('busy')
    expect(await first).toBe('sent')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('busy while in flight and for 120 ms after it settles', async () => {
    const g = createSubmitGuard()
    const d = deferred<string>()
    expect(g.busy()).toBe(false)
    const run = g.run(() => d.promise)
    expect(g.busy()).toBe(true)
    jest.advanceTimersByTime(5_000)
    expect(g.busy()).toBe(true)
    d.resolve('ok')
    expect(await run).toBe('ok')
    jest.advanceTimersByTime(119)
    expect(g.busy()).toBe(true)
    const fn = jest.fn(async () => 'again')
    expect(await g.run(fn)).toBe('busy')
    expect(fn).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(g.busy()).toBe(false)
    expect(await g.run(fn)).toBe('again')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('a clock stepped back mid-cooldown still frees the guard 120 ms after the settle', async () => {
    const g = createSubmitGuard()
    await g.run(async () => 'sent')
    jest.advanceTimersByTime(60)
    // the device's date is set back an hour (NTP, or by hand): only the wall clock moves
    jest.setSystemTime(Date.now() - 3_600_000)
    jest.advanceTimersByTime(59)
    expect(g.busy()).toBe(true)
    jest.advanceTimersByTime(1)
    expect(g.busy()).toBe(false)
    const fn = jest.fn(async () => 'next')
    expect(await g.run(fn)).toBe('next')
  })

  test('a clock stepped forward mid-cooldown does not end it early', async () => {
    const g = createSubmitGuard()
    await g.run(async () => 'sent')
    jest.setSystemTime(Date.now() + 3_600_000)
    expect(g.busy()).toBe(true)
    jest.advanceTimersByTime(119)
    expect(g.busy()).toBe(true)
    jest.advanceTimersByTime(1)
    expect(g.busy()).toBe(false)
  })

  test('a run that fails rejects its caller, then cools down the same way', async () => {
    const g = createSubmitGuard()
    await expect(
      g.run(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(g.busy()).toBe(true)
    jest.advanceTimersByTime(120)
    expect(g.busy()).toBe(false)
  })

  test('a custom cooldown', async () => {
    const g = createSubmitGuard({ cooldownMs: 500 })
    await g.run(async () => 1)
    jest.advanceTimersByTime(499)
    expect(g.busy()).toBe(true)
    jest.advanceTimersByTime(1)
    expect(g.busy()).toBe(false)
  })

  test('subscribers hear the start, the settle and the end of the cooldown', async () => {
    const g = createSubmitGuard()
    const seen: boolean[] = []
    const off = g.subscribe(() => seen.push(g.busy()))
    const d = deferred<void>()
    const run = g.run(() => d.promise)
    expect(seen).toEqual([true])
    d.resolve()
    await run
    expect(seen).toEqual([true, true])
    jest.advanceTimersByTime(120)
    expect(seen).toEqual([true, true, false])
    off()
    await g.run(async () => {})
    expect(seen).toHaveLength(3)
  })
})

/** Every guard each component rendered with. */
const guards = new Map<string, Set<SubmitGuard>>()
const Confirm = ({ id, send }: { id: string; send: () => Promise<void> }) => {
  const guard = useSubmitGuard()
  guards.set(id, (guards.get(id) ?? new Set()).add(guard))
  return (
    <Pressable testID={id} onPress={() => void guard.run(send)}>
      <Text testID={`${id}-state`}>{guard.busy() ? 'busy' : 'ready'}</Text>
    </Pressable>
  )
}

describe('useSubmitGuard', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('one guard per component, kept across renders, and it re-renders on every change', async () => {
    guards.clear()
    const d = deferred<void>()
    const send = jest.fn(() => d.promise)
    const other = jest.fn(async () => {})
    await render(
      <>
        <Confirm id="a" send={send} />
        <Confirm id="b" send={other} />
      </>,
    )
    // Two taps before the screen re-renders, in one act (fireEvent's own acts would overlap):
    // Pressability's click handler is the press, as an accessibility tap delivers it.
    const tap = screen.getByTestId('a').props.onClick as (e: object) => void
    await act(async () => {
      tap({})
      tap({})
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('a-state').props.children).toBe('busy')
    // the other component's guard is its own
    expect(screen.getByTestId('b-state').props.children).toBe('ready')
    await fireEvent.press(screen.getByTestId('b'))
    expect(other).toHaveBeenCalledTimes(1)
    await act(async () => d.resolve())
    expect(screen.getByTestId('a-state').props.children).toBe('busy')
    await act(async () => jest.advanceTimersByTime(119))
    expect(screen.getByTestId('a-state').props.children).toBe('busy')
    await act(async () => jest.advanceTimersByTime(1))
    expect(screen.getByTestId('a-state').props.children).toBe('ready')
    const [a = [], b = []] = [[...(guards.get('a') ?? [])], [...(guards.get('b') ?? [])]]
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0]).not.toBe(b[0])
  })
})
