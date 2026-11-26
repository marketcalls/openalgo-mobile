// After a GTT write whose outcome is unknown (MaybePlaced, a Server error from its own endpoint,
// or a success without an id), the GTT book says what happened (design 7.10). These only read:
// nothing here ever sends a GTT write.
import { type Polling, poll, type Reconciled } from '../orders/reconcile'
import type { GttBook, GttRow, GttSpec } from './schemas'

/** `dropped`: rows of the book that could not be read; one could be the GTT sought. */
type FetchBook = () => Promise<Pick<GttBook, 'rows' | 'dropped'>>

const round2 = (n: number) => Math.round(n * 100) / 100

const sameValues = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]
    return y !== undefined && round2(x) === round2(y)
  })

/** The spec's triggers, ascending as the book lists a row's: G2 puts the stop-loss below. */
const triggersOf = (s: GttSpec) =>
  s.type === 'SINGLE' ? [s.trigger] : [s.sl.trigger, s.tg.trigger]

/** The spec's limit prices, in the same order, as each leg pairs with its own trigger. */
const pricesOf = (s: GttSpec) => (s.type === 'SINGLE' ? [s.price] : [s.sl.price, s.tg.price])

/** The same contract and type, with the spec's triggers (at 2 dp). */
const hasTriggers = (r: GttRow, s: GttSpec) =>
  r.symbol === s.symbol &&
  r.exchange === s.exchange &&
  r.type === s.type &&
  sameValues(r.triggers, triggersOf(s))

/**
 * A row whose status the book does not give: absent, blank or unreadable all parse as `''`. It
 * may be active or not, so it answers neither way.
 */
const noStatus = (r: GttRow) => r.status === ''

/** Every value a modify sends: the triggers, and each leg's side, quantity and limit price. */
const hasSpec = (r: GttRow, s: GttSpec) =>
  hasTriggers(r, s) &&
  r.legs.every((l) => l.action === s.action && l.quantity === s.quantity) &&
  sameValues(
    r.legs.map((l) => l.price),
    pricesOf(s),
  )

/**
 * The GTT a placement made, if the book shows one: the first row of the contract and type, with
 * the spec's triggers, that was not in the book before the send (`knownIds`). Its status is not
 * asked: a GTT that fired at once is still the one placed.
 */
export function reconcileGttPlacement({
  fetchBook,
  spec,
  knownIds,
  ...polling
}: Polling & {
  fetchBook: FetchBook
  spec: GttSpec
  knownIds: ReadonlySet<string>
}): Promise<Reconciled<GttRow | null>> {
  return poll(
    polling,
    fetchBook,
    ({ rows, dropped }) => {
      const found = rows.find((r) => !knownIds.has(r.triggerId) && hasTriggers(r, spec)) ?? null
      return { found, checked: found !== null || dropped === 0 }
    },
    (found) => found !== null,
    null,
  )
}

export type GttChange = 'applied' | 'unchanged' | 'gone'

/**
 * After a modify: `applied` when the row shows the spec's values; `unchanged` when the row is
 * still active with other values; `gone` when it is absent or no longer active. A broker that
 * replaces the GTT gives it a new id and cancels or drops the old row, so once the row by id has
 * left, another active row with the spec's values is the change, `applied`. While the row by id
 * is still active, such a row is some other GTT: the modify has not shown, whatever it matches.
 * The book lags the write, so only `applied` stops the reads early. An unreadable row could be
 * the row by id, or once that has left its replacement, so it leaves such an answer unchecked.
 * The row by id with no status (`''`) and other values may still be active or may have left, so
 * that read is unknown (unchecked), and the reads go on to the deadline.
 */
export function reconcileGttChange({
  fetchBook,
  triggerId,
  spec,
  ...polling
}: Polling & {
  fetchBook: FetchBook
  triggerId: string
  spec: GttSpec
}): Promise<Reconciled<GttChange>> {
  return poll(
    polling,
    fetchBook,
    ({ rows, dropped }): Reconciled<GttChange> => {
      const row = rows.find((r) => r.triggerId === triggerId)
      if (row && hasSpec(row, spec)) return { found: 'applied', checked: true }
      if (row?.status === 'active') return { found: 'unchanged', checked: true }
      if (row && noStatus(row)) return { found: 'unchanged', checked: false }
      const replaced = rows.some(
        (r) => r.triggerId !== triggerId && r.status === 'active' && hasSpec(r, spec),
      )
      if (replaced) return { found: 'applied', checked: true }
      return { found: 'gone', checked: dropped === 0 }
    },
    (found) => found === 'applied',
    'unchanged',
  )
}

export type GttCancel = 'cancelled' | 'active' | 'gone' | { other: string }

/**
 * After a cancel: the row's status.
 * - Absent is `gone`, the cancel took effect: a book read without `status` (a server before
 *   2.0.2.4) lists active rows only, and so do Dhan's, Angel's, Fyers' and Upstox's even with
 *   `status: 'all'` (c8b2896 `get_gtt_book` accepts `include_history` and ignores it). It is
 *   checked unless the read dropped a row, which could be this GTT, still active.
 * - Any status besides cancelled and active (deleted, triggered, expired, the sandbox's
 *   triggering) is `{ other }`.
 * - No status (`''`: absent, blank or unreadable; Dhan's and Angel's mappers lower-case a missing
 *   one to `''`) says nothing about the cancel: that read is unknown (unchecked), never
 *   `{ other: '' }`, and the reads go on to the deadline.
 * Only a checked answer other than `active` stops the reads: the book may not show the cancel yet.
 */
export function reconcileGttCancel({
  fetchBook,
  triggerId,
  ...polling
}: Polling & { fetchBook: FetchBook; triggerId: string }): Promise<Reconciled<GttCancel>> {
  return poll(
    polling,
    fetchBook,
    ({ rows, dropped }): Reconciled<GttCancel> => {
      const row = rows.find((r) => r.triggerId === triggerId)
      if (!row) return { found: 'gone', checked: dropped === 0 }
      if (noStatus(row)) return { found: 'active', checked: false }
      const { status } = row
      const found = status === 'cancelled' || status === 'active' ? status : { other: status }
      return { found, checked: true }
    },
    (found) => found !== 'active',
    'active',
  )
}
