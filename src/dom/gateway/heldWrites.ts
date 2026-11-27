// A tool page's order writes (design 7.7 and 7.10): every page has a route for each /api/v1 order
// write, whatever its allowlist, and nothing here sends one. A reviewable write is held, one at a
// time, until native settles it with the reply the page gets: the review sheet shows it, and only
// a confirmed review sends it (the tool screen's HeldOrderSheet). An unreviewable write is
// answered 501 at once. Until the review begins its send, a DOM abort or cancelAll (the user
// left the tool) answers the page "cancelled" and the write is dropped for good (RF 5); once it
// has begun, the write keeps its real outcome.
import { createStore, type StoreApi } from 'zustand/vanilla'
import { ENDPOINTS, type EndpointId } from '~/core/http/endpoints'
import { isRecord } from '~/core/http/errors'
import type { DomReply, JSONValue, ToolPageId } from '~/dom/bridge/protocol'
import { type Route, refused } from './requests'

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

export type HeldWrites = StoreApi<{ current: HeldWrite | null }> & {
  /** Answers the page with `reply` and frees the hold; a stale `id` is ignored. */
  settle(id: number, reply: DomReply): void
  /**
   * The review is confirmed and its send begins: from now on neither cancelAll nor a DOM abort
   * answers it, only settle. False when `id` is no longer held (it was cancelled or aborted):
   * then nothing may be sent.
   */
  begin(id: number): boolean
  /** Answers "cancelled" to a hold whose send has not begun; a begun one is left to settle. */
  cancelAll(): void
}

export const CANCELLED_COPY = 'Order cancelled in the app.'
export const ONE_AT_A_TIME = 'Another order from this tool is waiting for your review.'
export const TOOL_ORDERS_LATER = "This tool's orders aren't supported in this build."

const errorReply = (status: number, message: string): DomReply => ({
  status,
  body: { status: 'error', message },
})

type Hold = (w: Omit<HeldWrite, 'id'>, signal: AbortSignal) => Promise<DomReply>
/** Each store's way to hold a write, for its routes only: the store itself holds nothing. */
const HOLDERS = new WeakMap<HeldWrites, Hold>()

export function createHeldWrites(): HeldWrites {
  const store = createStore<{ current: HeldWrite | null }>(() => ({ current: null }))
  let pending: { id: number; begun: boolean; answer: (r: DomReply) => void } | null = null
  let lastId = 0

  function answer(reply: DomReply) {
    const p = pending
    if (!p) return
    pending = null
    store.setState({ current: null })
    p.answer(reply)
  }

  const held: HeldWrites = {
    ...store,
    settle(id, reply) {
      if (pending?.id === id) answer(reply)
    },
    begin(id) {
      if (pending?.id !== id) return false
      pending.begun = true
      return true
    },
    cancelAll() {
      if (pending && !pending.begun) answer(errorReply(400, CANCELLED_COPY))
    },
  }

  HOLDERS.set(held, (w, signal) => {
    if (pending) return Promise.resolve(errorReply(409, ONE_AT_A_TIME))
    if (signal.aborted) return Promise.resolve(errorReply(400, CANCELLED_COPY))
    const id = ++lastId
    return new Promise((resolve) => {
      const onAbort = () => {
        if (pending?.id === id && !pending.begun) answer(errorReply(400, CANCELLED_COPY))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      pending = {
        id,
        begun: false,
        answer: (reply) => {
          signal.removeEventListener('abort', onAbort)
          resolve(reply)
        },
      }
      store.setState({ current: { id, ...w } })
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
