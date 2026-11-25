// After a write whose outcome is unknown (MaybePlaced, or a success without an id), the books
// say what happened (design 7.10). These only read: nothing here ever sends an order.
import type { OrderRow, PositionRow } from '../books/schemas'
import type { OrderSpec, PositionToClose } from './schemas'

export const RECONCILE_DELAYS_MS: readonly number[] = [2000, 5000, 10000]

/** An order stamped up to this long before the send can still be ours (a broker clock behind). */
const WINDOW_MS = 120_000

type FetchOrders = () => Promise<{ orders: readonly OrderRow[] }>

/** The books lag the write, so each check waits, then reads once, per delay. */
type Polling = {
  sleep: (ms: number) => Promise<void>
  delaysMs?: readonly number[]
}

type Placement = Polling & {
  fetchOrders: FetchOrders
  spec: Pick<OrderSpec, 'symbol' | 'exchange' | 'action' | 'product' | 'quantity'>
  /** Epoch ms of the send. */
  sentAt: number
  /** The ids in the orderbook cache at submit time: those orders are not ours. */
  knownIds: ReadonlySet<string>
}

/**
 * `checked` is false when no fetch got the book, so an empty `found` means "could not check",
 * not "not placed".
 */
export type Reconciled<T> = { found: T; checked: boolean }

/** A row that could be the order sent: the same contract, side and product, new, and recent. */
function isCandidate(r: OrderRow, p: Placement): boolean {
  const { spec } = p
  return (
    r.symbol === spec.symbol &&
    r.exchange === spec.exchange &&
    r.action === spec.action &&
    r.product === spec.product &&
    !p.knownIds.has(r.orderid) &&
    (r.placedAt === null || r.placedAt >= p.sentAt - WINDOW_MS)
  )
}

const timeOf = (r: OrderRow) => r.placedAt ?? Number.NEGATIVE_INFINITY

/**
 * Newest first by the parsed time. Rows whose time does not parse keep the book's order after
 * the timed ones: the sandbox stamps "%Y-%m-%d %H:%M:%S", which reads as null, and lists newest
 * first, so its first candidate is its newest (ruling 5 carry-forward).
 */
const newestFirst = (rows: readonly OrderRow[]) =>
  [...rows].sort((a, b) => (timeOf(a) === timeOf(b) ? 0 : timeOf(b) > timeOf(a) ? 1 : -1))

/**
 * After each delay, one fetch; `read` what the book says, and stop once `done` says so.
 * A fetch that fails is skipped. The answer is the last fetch that worked.
 */
async function poll<B, T>(
  { sleep, delaysMs = RECONCILE_DELAYS_MS }: Polling,
  fetch: () => Promise<B>,
  read: (book: B) => T,
  done: (found: T) => boolean,
  none: T,
): Promise<Reconciled<T>> {
  let last: Reconciled<T> = { found: none, checked: false }
  for (const ms of delaysMs) {
    await sleep(ms)
    let book: B
    try {
      book = await fetch()
    } catch {
      continue
    }
    last = { found: read(book), checked: true }
    if (done(last.found)) return last
  }
  return last
}

/** Polls the orderbook; `pick` gets the rows that could be ours, newest first. */
const pollOrders = <T>(
  p: Placement,
  pick: (candidates: OrderRow[]) => T,
  done: (found: T) => boolean,
  none: T,
) =>
  poll(
    p,
    p.fetchOrders,
    ({ orders }) => pick(newestFirst(orders.filter((r) => isCandidate(r, p)))),
    done,
    none,
  )

/** The order a single placement made, if the book shows one. */
export function reconcilePlacement(p: Placement): Promise<Reconciled<OrderRow | null>> {
  return pollOrders(
    p,
    (rows) => rows.find((r) => r.quantity === p.spec.quantity) ?? null,
    (found) => found !== null,
    null,
  )
}

/**
 * The child orders a split made: rows of the child sizes, each child taking one row, so the
 * result never holds more rows of a size than there are children of it. It stops early once
 * every child is found; otherwise it gives the children the last book showed.
 */
export function reconcileSplit(
  p: Placement & { children: readonly number[] },
): Promise<Reconciled<OrderRow[]>> {
  const pick = (rows: OrderRow[]) => {
    const left = [...p.children]
    const found: OrderRow[] = []
    for (const r of rows) {
      const i = left.indexOf(r.quantity)
      if (i < 0) continue
      left.splice(i, 1)
      found.push(r)
    }
    return found
  }
  return pollOrders(p, pick, (found) => found.length >= p.children.length, [])
}

/**
 * Whether a close went through: the row of that symbol and product at quantity 0, or gone from
 * the book, is closed. Like a placement, it waits before each read, because the positionbook
 * lags the close: a read at once can still show the old quantity, and "still open" then invites
 * a second close while the first may be working (a resend after a maybe, rulings 5). It stops
 * at the first read that shows the position closed. `open` is what the last read that worked
 * showed after every delay; `unknown` is no read working at all.
 */
export async function reconcileClose({
  fetchPositions,
  row,
  ...polling
}: Polling & {
  fetchPositions: () => Promise<{ rows: readonly PositionRow[] }>
  row: Pick<PositionToClose, 'symbol' | 'exchange' | 'product'>
}): Promise<'closed' | 'open' | 'unknown'> {
  const isClosed = ({ rows }: { rows: readonly PositionRow[] }) => {
    const now = rows.find(
      (r) => r.symbol === row.symbol && r.exchange === row.exchange && r.product === row.product,
    )
    return !now || now.quantity === 0
  }
  const { found: closed, checked } = await poll(polling, fetchPositions, isClosed, (c) => c, false)
  if (!checked) return 'unknown'
  return closed ? 'closed' : 'open'
}

/** The order's row as the book shows it now; null when it is not there. A failed read rejects. */
export async function reconcileRow({
  fetchOrders,
  orderid,
}: {
  fetchOrders: FetchOrders
  orderid: string
}): Promise<OrderRow | null> {
  return (await fetchOrders()).orders.find((r) => r.orderid === orderid) ?? null
}
