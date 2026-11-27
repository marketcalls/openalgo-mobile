// A tool page's order writes (design 7.7 and 7.10): every page has a route for each /api/v1 order
// write, whatever its allowlist, and nothing here sends one. A reviewable write is held until
// native settles it with the reply the page gets: the review sheet shows it, and only a confirmed
// review sends it (the tool screen's HeldOrderSheet). Held writes are shown one at a time, first
// in, first out (ux-bar T12-12): the others wait their turn, unanswered, and none of them can be
// begun or settled until it is the one on show. An unreviewable write is answered 501 at once.
// Until the review begins its send, a DOM abort or cancelAll (the user left the tool) answers the
// page "cancelled" and the write is dropped for good (RF 5), the waiting ones too; once it has
// begun, the write keeps its real outcome.
import { createStore, type StoreApi } from 'zustand/vanilla'
import { ENDPOINTS, type EndpointId } from '~/core/http/endpoints'
import { isRecord } from '~/core/http/errors'
import type { DomReply, JSONValue, ToolPageId } from '~/dom/bridge/protocol'
import { MAX_DOM_INFLIGHT, type Route, refused } from './requests'

export const ORDER_WRITE_ENDPOINTS = [
  'placeorder',
  'placesmartorder',
  'basketorder',
  'optionsmultiorder',
  'splitorder',
] as const satisfies readonly EndpointId[]
export type OrderWriteEndpoint = (typeof ORDER_WRITE_ENDPOINTS)[number]

/** The order writes' paths: never on an allowlist, always held or refused. */
export const ORDER_WRITE_PATHS: ReadonlySet<string> = new Set(
  ORDER_WRITE_ENDPOINTS.map((e) => ENDPOINTS[e].path),
)

/** A write held for review: the page's body as it came, its `apikey` placeholder included. */
export type HeldWrite = {
  id: number
  endpoint: OrderWriteEndpoint
  body: Record<string, JSONValue>
  page: ToolPageId
}

/** `current` is the write on show; `waiting` counts those behind it, first in, first out. */
export type HeldWritesState = { current: HeldWrite | null; waiting: number }

export type HeldWrites = StoreApi<HeldWritesState> & {
  /**
   * Answers the page with `reply` and frees the hold, and the next waiting write is shown. Only
   * the write on show is settled: a stale or waiting `id` is ignored.
   */
  settle(id: number, reply: DomReply): void
  /**
   * The review is confirmed and its send begins: from now on neither cancelAll nor a DOM abort
   * answers it, only settle. False when `id` is not the write on show (it was cancelled or
   * aborted, or it is still waiting): then nothing may be sent.
   */
  begin(id: number): boolean
  /**
   * Answers "cancelled" to the write on show if its send has not begun, and to every waiting
   * write; a begun one is left to settle.
   */
  cancelAll(): void
}

export const CANCELLED_COPY = 'Order cancelled in the app.'
/** The reply to a write past MAX_HELD_WRITES: it is never held. */
export const ONE_AT_A_TIME = 'Another order from this tool is waiting for your review.'
export const TOOL_ORDERS_LATER = "This tool's orders aren't supported in this build."
/**
 * The writes one page may have held at once, the one on show included. Half the page's request
 * cap, since held writes count toward it (conflict 17): the page's reads still go while its
 * orders wait. Raise it only by constant.
 */
export const MAX_HELD_WRITES = MAX_DOM_INFLIGHT / 2

const errorReply = (status: number, message: string): DomReply => ({
  status,
  body: { status: 'error', message },
})

type Hold = (w: Omit<HeldWrite, 'id'>, signal: AbortSignal) => Promise<DomReply>
/** Each store's way to hold a write, for its routes only: the store itself holds nothing. */
const HOLDERS = new WeakMap<HeldWrites, Hold>()

/** A held write and the page's answer for it. */
type Pending = { write: HeldWrite; begun: boolean; answer: (r: DomReply) => void }

export function createHeldWrites(): HeldWrites {
  const store = createStore<HeldWritesState>(() => ({ current: null, waiting: 0 }))
  /** The write on show. */
  let shown: Pending | null = null
  /** The writes behind it, first in, first out; none has begun. */
  const queue: Pending[] = []
  let lastId = 0

  const publish = () => store.setState({ current: shown?.write ?? null, waiting: queue.length })

  /** Answers the write on show; the next in the queue takes its place. */
  function answerShown(reply: DomReply) {
    const p = shown
    if (!p) return
    shown = queue.shift() ?? null
    publish()
    p.answer(reply)
  }

  const held: HeldWrites = {
    ...store,
    settle(id, reply) {
      if (shown?.write.id === id) answerShown(reply)
    },
    begin(id) {
      if (shown?.write.id !== id) return false
      shown.begun = true
      return true
    },
    cancelAll() {
      const gone = queue.splice(0)
      if (shown && !shown.begun) {
        gone.unshift(shown)
        shown = null
      }
      if (gone.length === 0) return
      publish()
      for (const p of gone) p.answer(errorReply(400, CANCELLED_COPY))
    },
  }

  HOLDERS.set(held, (w, signal) => {
    if (signal.aborted) return Promise.resolve(errorReply(400, CANCELLED_COPY))
    if ((shown ? 1 : 0) + queue.length >= MAX_HELD_WRITES) {
      return Promise.resolve(errorReply(409, ONE_AT_A_TIME))
    }
    const write: HeldWrite = { id: ++lastId, ...w }
    return new Promise((resolve) => {
      const p: Pending = {
        write,
        begun: false,
        answer: (reply) => {
          signal.removeEventListener('abort', onAbort)
          resolve(reply)
        },
      }
      function onAbort() {
        if (p.begun) return
        if (shown === p) {
          answerShown(errorReply(400, CANCELLED_COPY))
          return
        }
        const i = queue.indexOf(p)
        if (i < 0) return
        queue.splice(i, 1)
        publish()
        p.answer(errorReply(400, CANCELLED_COPY))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (shown) queue.push(p)
      else shown = p
      publish()
    })
  })
  return held
}

/**
 * The order-write routes of one page, every one of ORDER_WRITE_ENDPOINTS: `reviewable` ones are
 * held in `h` (made by createHeldWrites), the others answered 501. A body that is not an object is
 * refused, never held.
 */
export function createHeldWriteRoutes(
  h: HeldWrites,
  page: ToolPageId,
  o: { reviewable: ReadonlySet<OrderWriteEndpoint> },
): Route[] {
  const hold = HOLDERS.get(h)
  if (!hold) throw new Error('createHeldWriteRoutes takes a store made by createHeldWrites')
  return ORDER_WRITE_ENDPOINTS.map((endpoint) => ({
    method: 'POST',
    path: ENDPOINTS[endpoint].path,
    async handle(r, signal) {
      if (!o.reviewable.has(endpoint)) return errorReply(501, TOOL_ORDERS_LATER)
      if (!isRecord(r.body)) return refused()
      // a parsed JSON object: no value is undefined
      return hold({ endpoint, body: r.body as Record<string, JSONValue>, page }, signal)
    },
  }))
}
