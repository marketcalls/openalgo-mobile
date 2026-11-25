// After a write whose outcome is unknown (MaybePlaced, or a success without an id), the books
// say what happened (design 7.10). These only read: nothing here ever sends an order.
import { isWorking, type OrderRow, type PositionRow } from '../books/schemas'
import type { OrderSpec, PositionToClose } from './schemas'

/** The books lag a write the server answered: each check reads after 2, 5 and 10 s. */
export const RECONCILE_DELAYS_MS: readonly number[] = [2000, 5000, 10000]

/**
 * After a write that got no reply (a timeout, a 502, a reply that could not be read), the server
 * may still be waiting on the broker: the stock server gives a broker request up to 120 s
 * (utils/httpx_client.py REQUEST_TIMEOUT_SECONDS), and a proxy in front of it can give up on the
 * app first. So the check reads on past that: its last read lands 127 s after the failure, which
 * is itself at least the endpoint's timeout after the send. A check that ends earlier would tell
 * "not in the book" while the order may still reach it (design 7.10: never re-sends).
 */
export const NO_REPLY_DELAYS_MS: readonly number[] = [2000, 5000, 10000, 20000, 30000, 60000]

/**
 * What one split child may take at the server, which places the children one after another for
 * the whole run (split_order_service.py): its rate-limit gap (ORDER_RATE_LIMIT, 10 per second by
 * default) and the broker's reply.
 */
export const SPLIT_CHILD_MS = 1000

/**
 * The reads after a write that got no reply: `NO_REPLY_DELAYS_MS`, and for a split of `children`
 * orders, 30 s more per 30 children the server may still be placing.
 */
export function noReplyDelays(children?: number): number[] {
  const extra = children === undefined ? 0 : Math.ceil((children * SPLIT_CHILD_MS) / 30_000)
  return [...NO_REPLY_DELAYS_MS, ...Array.from({ length: extra }, () => 30_000)]
}

/** An order stamped up to this long before the send can still be ours (a broker clock behind). */
const WINDOW_MS = 120_000

/** `dropped`: rows of the book that could not be read (`lenientRows`); one could be ours. */
type FetchOrders = () => Promise<{ orders: readonly OrderRow[]; dropped?: number }>

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
 * `checked` is false when no fetch got the book, or the last one that did had rows it could not
 * read and none of what was sought (the row sought may be one of them), so an empty `found` means
 * "could not check", not "not placed".
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
 * After each delay, one fetch; `read` what the book says (`checked` false when its unreadable
 * rows leave it open), and stop once a sure read is `done`. A fetch that fails is skipped. The
 * answer is the last fetch that worked.
 */
async function poll<B, T>(
  { sleep, delaysMs = RECONCILE_DELAYS_MS }: Polling,
  fetch: () => Promise<B>,
  read: (book: B) => Reconciled<T>,
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
    last = read(book)
    if (last.checked && done(last.found)) return last
  }
  return last
}

/**
 * Polls the orderbook; `pick` gets the rows that could be ours, newest first, and `sure` says
 * whether what it found settles it even when some rows could not be read.
 */
const pollOrders = <T>(
  p: Placement,
  pick: (candidates: OrderRow[]) => T,
  sure: (found: T) => boolean,
  done: (found: T) => boolean,
  none: T,
) =>
  poll(
    p,
    p.fetchOrders,
    ({ orders, dropped = 0 }) => {
      const found = pick(newestFirst(orders.filter((r) => isCandidate(r, p))))
      return { found, checked: dropped === 0 || sure(found) }
    },
    done,
    none,
  )

/** The order a single placement made, if the book shows one. */
export function reconcilePlacement(p: Placement): Promise<Reconciled<OrderRow | null>> {
  const found = (r: OrderRow | null) => r !== null
  return pollOrders(
    p,
    (rows) => rows.find((r) => r.quantity === p.spec.quantity) ?? null,
    found,
    found,
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
  const all = (found: OrderRow[]) => found.length >= p.children.length
  return pollOrders(p, pick, all, all, [])
}

/**
 * Whether a close went through: the row of that symbol and product at quantity 0, or gone from
 * the book, is closed. Like a placement, it waits before each read, because the positionbook
 * lags the close: a read at once can still show the old quantity, and "still open" then invites
 * a second close while the first may be working (a resend after a maybe, rulings 5). It stops
 * at the first read that shows the position closed. `open` is what the last read that worked
 * showed after every delay; `unknown` is no read working at all, or a last read whose row is
 * missing while some rows could not be read (the position may be one of them).
 */
export async function reconcileClose({
  fetchPositions,
  row,
  ...polling
}: Polling & {
  fetchPositions: () => Promise<{ rows: readonly PositionRow[]; dropped?: number }>
  row: Pick<PositionToClose, 'symbol' | 'exchange' | 'product'>
}): Promise<'closed' | 'open' | 'unknown'> {
  const isClosed = ({ rows, dropped = 0 }: { rows: readonly PositionRow[]; dropped?: number }) => {
    const now = rows.find(
      (r) => r.symbol === row.symbol && r.exchange === row.exchange && r.product === row.product,
    )
    return { found: !now || now.quantity === 0, checked: now !== undefined || dropped === 0 }
  }
  const { found: closed, checked } = await poll(polling, fetchPositions, isClosed, (c) => c, false)
  if (!checked) return 'unknown'
  return closed ? 'closed' : 'open'
}

/**
 * After a close whose position the book still shows open: an order working to close it, if the
 * orderbook shows one. That is a working order on the contract and product, on the side that
 * closes the position (`side`), placed no earlier than the close was sent (less a broker clock
 * behind); its quantity is not compared, since the server sizes a close from the position. One
 * read, at once: the close was sent long enough ago for the book to list it. `checked` false
 * when the book could not be read, or had unreadable rows and no such order.
 */
export async function findWorkingExit({
  fetchOrders,
  row,
  side,
  sentAt,
}: {
  fetchOrders: FetchOrders
  row: Pick<PositionToClose, 'symbol' | 'exchange' | 'product'>
  side: 'BUY' | 'SELL'
  sentAt: number
}): Promise<Reconciled<OrderRow | null>> {
  let book: Awaited<ReturnType<FetchOrders>>
  try {
    book = await fetchOrders()
  } catch {
    return { found: null, checked: false }
  }
  const found =
    newestFirst(
      book.orders.filter(
        (r) =>
          r.symbol === row.symbol &&
          r.exchange === row.exchange &&
          r.product === row.product &&
          r.action === side &&
          isWorking(r) &&
          (r.placedAt === null || r.placedAt >= sentAt - WINDOW_MS),
      ),
    )[0] ?? null
  return { found, checked: found !== null || (book.dropped ?? 0) === 0 }
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

/** What a modify or a cancel changes of an order: its status, type, quantity, price or trigger. */
const sameOrder = (a: OrderRow, b: OrderRow) =>
  a.status === b.status &&
  a.pricetype === b.pricetype &&
  a.quantity === b.quantity &&
  a.price === b.price &&
  a.trigger_price === b.trigger_price

/**
 * After a write on one order (a modify or a cancel) whose outcome is unknown: the order's row
 * once the book shows it changed from `before`, the row as it was when the write went, or gone
 * (null). The book lags the write, so a read that still shows the order as it was is not the
 * answer while delays remain: it reads after each delay and stops at the first change. Otherwise
 * it gives what the last read that worked showed; `checked` is false when no read worked.
 */
export function reconcileRowChange({
  fetchOrders,
  before,
  ...polling
}: Polling & { fetchOrders: FetchOrders; before: OrderRow }): Promise<Reconciled<OrderRow | null>> {
  return poll(
    polling,
    fetchOrders,
    ({ orders, dropped = 0 }) => {
      const now = orders.find((r) => r.orderid === before.orderid) ?? null
      // gone is sure only when every row could be read: the order may be one that could not
      return { found: now, checked: now !== null || dropped === 0 }
    },
    (now) => now === null || !sameOrder(now, before),
    null,
  )
}

/**
 * After a cancel all whose outcome is unknown: how many orders the book shows still working,
 * read after each delay until it shows none. Otherwise the count the last read that worked
 * showed; `checked` is false when no read worked, or the last one had rows it could not read.
 */
export function reconcileCancelAll({
  fetchOrders,
  ...polling
}: Polling & { fetchOrders: FetchOrders }): Promise<Reconciled<number>> {
  return poll(
    polling,
    fetchOrders,
    ({ orders, dropped = 0 }) => ({
      found: orders.filter(isWorking).length,
      checked: dropped === 0,
    }),
    (open) => open === 0,
    0,
  )
}
