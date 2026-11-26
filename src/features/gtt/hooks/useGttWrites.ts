// The GTT book's writes on the Orders tab (design 17.3): cancel one GTT, behind a confirm that
// names the server's mode, sent once through the order safety of design 7.10 and one at a time
// (`useConfirmedWrite`, which the order writes share). An outcome that may hide the cancel is
// checked against the GTT book, never sent again. Modify is the GTT ticket's.
import { qk } from '~/core/query/keys'
import { useServices } from '~/core/services/services'
import { QUEUED_COPY } from '~/market/components/SessionBanners'
import { type GttCancel, reconcileGttCancel } from '~/market/gtt/reconcile'
import type { GttRow, GttSpec } from '~/market/gtt/schemas'
import { gttProduct, gttSummary } from '~/market/gtt/ticket'
import type { InstrumentCache } from '~/market/instruments/cache'
import { fmtTick } from '~/market/instruments/tick'
import { type OrderMeta, sandboxed, sleep } from '~/market/orders/outcome'
import { onGtt } from '~/market/orders/pending'
import { noReplyDelays, RECONCILE_DELAYS_MS, type Reconciled } from '~/market/orders/reconcile'
import { useConfirmedWrite } from '~/market/orders/useConfirmedWrite'
import { useTrading } from '~/market/trading'

/** On the tab, under a row whose GTT has a write out (the tab's cancel, or a modify sheet's). */
export const GTT_ROW_OUT = 'A change to this GTT is on its way. Modify and Cancel wait for it.'
const CANCELLED = 'GTT cancelled'
const NOT_CHECKED = "Couldn't check the GTT book. Check it before trying again."

/** What a cancel whose outcome was unknown came to, as the GTT book shows it. */
export function cancelLine(r: Reconciled<GttCancel> | null): string {
  if (!r?.checked) return NOT_CHECKED
  const { found } = r
  if (found === 'cancelled') return 'The GTT book shows it cancelled.'
  if (found === 'active') return 'The GTT book still shows it active. Check it before trying again.'
  if (found === 'gone') return 'The GTT is no longer in the book.'
  return `The GTT book shows it ${found.other}.`
}

/**
 * What a row's prices and quantities read at: today's metadata when the cache knows the contract
 * (it never asks the server for a row), else the 0.05 tick, in units.
 */
export function rowMeta(
  instruments: Pick<InstrumentCache, 'peek'>,
  row: Pick<GttRow, 'exchange' | 'symbol'>,
): OrderMeta {
  const m = instruments.peek(row.exchange, row.symbol)
  return m === undefined || m === 'unknown' ? { tick: 0.05, lots: false, lotsize: 1 } : m
}

/**
 * The GTT as the book lists it, in the GTT ticket's terms, for its one-line summary. A row without
 * the legs its type needs has no side to show, and gives none.
 */
function specOf(row: GttRow): GttSpec | null {
  const [first, second] = row.legs
  if (!first) return null
  const common = {
    exchange: row.exchange,
    symbol: row.symbol,
    action: first.action,
    product: gttProduct(row.exchange),
    quantity: first.quantity,
  }
  if (row.type === 'SINGLE') {
    // `above` only steers a send; a summary does not read it.
    return {
      ...common,
      type: 'SINGLE',
      trigger: row.triggers[0] ?? 0,
      price: first.price,
      above: false,
    }
  }
  if (!second) return null
  return {
    ...common,
    type: 'OCO',
    sl: { trigger: first.trigger ?? row.triggers[0] ?? 0, price: first.price },
    tg: { trigger: second.trigger ?? row.triggers[1] ?? 0, price: second.price },
  }
}

/** The cancel confirm's body: `gttSummary`, or the contract and its triggers without legs. */
function summaryOf(row: GttRow, meta: OrderMeta): string {
  const spec = specOf(row)
  if (spec) return gttSummary(spec, meta)
  const triggers = row.triggers.map((n) => fmtTick(n, meta.tick, n)).join(' / ')
  return `${row.type === 'OCO' ? 'GTT OCO' : 'GTT'} · ${row.symbol} · trigger ${triggers || '--'}`
}

/**
 * Cancel one GTT, one write at a time on the tab (`useConfirmedWrite`); `busy` disables the GTT
 * buttons meanwhile. The cancel is held on its GTT for the session (`onGtt`) until its outcome is
 * known, so a modify sheet for it waits. `semiBlocked`, `liveSurprise` and `outcome` are the last
 * cancel's notices, which the Orders tab shows on its GTT segment.
 */
export function useGttWrites() {
  const s = useServices()
  const trading = useTrading()
  const pid = s.profile.get().id
  const { run, ...notices } = useConfirmedWrite({ scopeOut: GTT_ROW_OUT })

  const cancel = (row: GttRow) =>
    run({
      kind: 'gttCancel',
      endpoint: 'cancelgttorder',
      scope: onGtt(row.triggerId),
      confirm: {
        title: 'Cancel this GTT?',
        body: summaryOf(row, rowMeta(trading.instruments, row)),
        ok: 'Cancel GTT',
        cancel: 'Keep GTT',
      },
      send: () => trading.gtt.cancel(row.triggerId),
      unknown: (reply) => reply.kind === 'no_id',
      // G3: a JSON 404 is "No active GTT": it fired, expired or was cancelled since the list was
      // read. The list reads the book again now, and GTT is still served here (ruling 16).
      refused: (e) => {
        if (e.status !== 404 || !e.serverMessage) return null
        void s.queryClient.refetchQueries({ queryKey: qk.gttbook(pid) })
        return e.serverMessage
      },
      done: (reply) =>
        reply.kind === 'ok'
          ? { line: sandboxed(CANCELLED, reply.analyze), ok: true }
          : { line: QUEUED_COPY, ok: false },
      // Each read goes out after the write, never joined to one sent before it (ruling 15).
      check: async ({ noReply }) =>
        cancelLine(
          await reconcileGttCancel({
            fetchBook: () => trading.gtt.book({ fresh: true }),
            triggerId: row.triggerId,
            sleep,
            // No reply: the server may still be sending it, so the check reads on past its timeout.
            delaysMs: noReply ? noReplyDelays() : RECONCILE_DELAYS_MS,
          }).catch(() => null),
        ),
    })

  return { cancel, ...notices }
}

export type GttWrites = ReturnType<typeof useGttWrites>
