// The last prices of a screen's open contracts, live. Mode 1 (LTP only) is acquired for each key
// and a `quotes` consumer is registered, so polling mode (and a feed that drops) still gets
// prices. The tick store flushes once per frame, so a burst of ticks is one render here.
import { useContext, useEffect, useMemo, useReducer } from 'react'
import { LiveContext } from '~/core/realtime/useLive'
import { useScreenActive } from '~/core/realtime/useScreenActive'

const split = (key: string) => {
  const i = key.indexOf(':')
  return { exchange: key.slice(0, i), symbol: key.slice(i + 1) }
}

/**
 * `keys` are `EX:SYM`; the answer holds an LTP for each key that has a quote. `active` false
 * (nothing open, blocked, or another segment in front) holds no feed slot and no poll.
 */
export function useLiveLtps(
  keys: readonly string[],
  active: boolean,
): Record<string, number | undefined> {
  const live = useContext(LiveContext)
  if (!live) throw new Error('LiveContext is not provided')
  const { realtime, polling, store } = live
  const screenActive = useScreenActive()
  const on = active && screenActive
  const joined = keys.join('|')
  const [version, bump] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (!on || joined === '') return
    const list = joined.split('|')
    const releases = list.map((k) => realtime.acquire({ ...split(k), mode: 1 }))
    const unregister = polling.register({ kind: 'quotes', keys: () => list }, true)
    const offs = list.map((k) => store.subscribe(k, bump))
    bump()
    return () => {
      for (const f of [...releases, unregister, ...offs]) f()
    }
  }, [on, joined, realtime, polling, store])

  // `version` marks a tick. It is an argument, not only a listed dependency: the React Compiler
  // memoizes on what the callback reads and drops any other, which froze these prices at the
  // screen's first read.
  return useMemo(() => ltpsAt(version, store, on ? joined : ''), [on, joined, store, version])
}

/** Each key's LTP in `store` at tick `_version` (see the memo above). */
function ltpsAt(
  _version: number,
  store: { get(k: string): { ltp?: number } | undefined },
  joined: string,
): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {}
  for (const k of joined === '' ? [] : joined.split('|')) out[k] = store.get(k)?.ltp
  return out
}
