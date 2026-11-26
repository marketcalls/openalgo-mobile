// The DOM side of the bridge (design 7.7): `call` sends one typed message to native and returns its
// reply; `deliver` is the page's imperative handle, which native's outbox calls with each batch.
// A batch is checked with the protocol's dependency-free guard (no zod in a DOM bundle, preflight
// conflict 3) and dropped whole if any message in it is not one native sends.
import {
  type DomReply,
  type DomToNative,
  isNativeToDomBatch,
  type JSONValue,
  type NativeToDom,
} from '~/dom/bridge/protocol'

type SocketEvent = NativeToDom & { kind: 'socket' }

export type DomClient = {
  call(m: DomToNative): Promise<DomReply>
  deliver(batch: unknown): void
  onPush(topic: string, fn: (p: unknown) => void): () => void
  onSocket(sid: number, fn: (e: NativeToDom & { kind: 'socket' }) => void): () => void
  /** A socket id no listener holds, within the protocol's 0-999. */
  nextSid(): number
}

const SIDS = 1000

function isReply(x: unknown): x is DomReply {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  const r = x as { status?: unknown; body?: unknown }
  return Number.isInteger(r.status) && r.body !== undefined
}

function listen<K, A>(map: Map<K, Set<(a: A) => void>>, key: K, fn: (a: A) => void): () => void {
  let fns = map.get(key)
  if (fns === undefined) {
    fns = new Set()
    map.set(key, fns)
  }
  fns.add(fn)
  return () => {
    const now = map.get(key)
    now?.delete(fn)
    if (now?.size === 0) map.delete(key)
  }
}

type Failure = { error: unknown } | null

/** Runs every listener, a copy of the set so one may stop listening; returns the first error. */
function each<A>(fns: Set<(a: A) => void> | undefined, arg: A): Failure {
  let failure: Failure = null
  for (const fn of fns ? [...fns] : []) {
    try {
      fn(arg)
    } catch (error) {
      failure ??= { error }
    }
  }
  return failure
}

export function createDomClient(bridge: (m: JSONValue) => Promise<JSONValue>): DomClient {
  const pushes = new Map<string, Set<(p: unknown) => void>>()
  const sockets = new Map<number, Set<(e: SocketEvent) => void>>()
  let lastSid = 0

  return {
    async call(m) {
      const reply = await bridge(m)
      if (!isReply(reply)) throw new Error('openalgo-mobile: not a bridge reply')
      return reply
    },

    // Each listener runs even if an earlier one throws, so one bug costs no other message; the
    // first error is rethrown once the batch is done, where the page's error handler sees it.
    deliver(batch) {
      if (!isNativeToDomBatch(batch)) return
      let failure: Failure = null
      for (const m of batch) {
        const f =
          m.kind === 'push' ? each(pushes.get(m.topic), m.payload) : each(sockets.get(m.sid), m)
        failure ??= f
      }
      if (failure) throw failure.error
    },

    onPush: (topic, fn) => listen(pushes, topic, fn),
    onSocket: (sid, fn) => listen(sockets, sid, fn),

    nextSid() {
      for (let i = 0; i < SIDS; i++) {
        lastSid = (lastSid + 1) % SIDS
        if (!sockets.has(lastSid)) return lastSid
      }
      throw new Error('openalgo-mobile: every socket id is in use')
    },
  }
}
