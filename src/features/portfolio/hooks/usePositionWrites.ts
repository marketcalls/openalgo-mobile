// The portfolio's writes (design 7.10): close one position and close all, each behind a native
// confirm that names the server's mode, sent once through the order safety of T10 and one at a
// time. Any 5xx or an unreadable reply on a close may hide it (about 28 adapters answer a flat
// close with "No OpenPosition Found" as a 500), so it is checked against the positionbook, never
// sent again. A write the server took LIVE after an ANALYZE confirm is told as a danger notice.
import { useCallback, useState } from 'react'
import type { EndpointId } from '~/core/http/endpoints'
import { notifyError, notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { qk } from '~/core/query/keys'
import { useServices } from '~/core/services/services'
import type { Positionbook, PositionRow } from '~/market/books/schemas'
import { QUEUED_COPY } from '~/market/components/SessionBanners'
import { confirmLiveOrder } from '~/market/orders/confirmLive'
import { confirmInMode } from '~/market/orders/confirmWrite'
import { useSubmitGuard } from '~/market/orders/guard'
import { CHECKING, errorText, modeChanged, settle, sleep } from '~/market/orders/outcome'
import { RECONCILE_DELAYS_MS, reconcileClose } from '~/market/orders/reconcile'
import { type ActionKind, liveSurpriseText, submitOrderAction } from '~/market/orders/submit'
import { useTrading } from '~/market/trading'
import { toast } from '~/ui/Toast'

export const NOT_READ = "The positions can't be read right now."
export const CLOSE_SENT = 'Close order sent'
export const ALREADY_FLAT = 'Already flat'
export const CLOSE_CHECKING = 'Close may have gone through: checking positions.'
export const POSITION_CLOSED = 'Position is closed'
export const CLOSE_UNCHECKED = "Couldn't check. Pull to refresh."
export const CLOSE_ALL_BODY =
  'This closes every open position in the account at market, across all strategies and the web.'
export const closeOneBody = (row: Pick<PositionRow, 'symbol' | 'product' | 'quantity'>) =>
  `This closes the whole net position (${row.quantity}) for ${row.symbol} ${row.product} at market, including quantity opened by strategies or the web.`
export const stillOpen = (qty: number) => `Still open: ${qty}. You can try Close again.`
const positions = (n: number) => `${n} ${n === 1 ? 'position' : 'positions'}`

type Write<R> = {
  kind: ActionKind
  endpoint: EndpointId
  confirm: { title: string; body: string; ok: string }
  send: () => Promise<R>
  unknown?: (reply: R) => boolean
  done: (reply: R) => { line: string; ok: boolean }
  /** The line to show after an unknown outcome, once the book says. */
  check: () => Promise<string>
}

/**
 * One read of the positionbook sent now, never joined to one already out: a read sent before
 * the write may not show it. What it read is shown on the books unless a newer reply is there.
 */
function useFreshPositions(): () => Promise<Positionbook> {
  const s = useServices()
  const trading = useTrading()
  const pid = s.profile.get().id
  return useCallback(async () => {
    const key = qk.positionbook(pid)
    const sentAt = Date.now()
    const b = await trading.orders.positionbook({ fresh: true })
    if ((s.queryClient.getQueryState(key)?.dataUpdatedAt ?? 0) < sentAt) {
      s.queryClient.setQueryData(key, b)
    }
    return b
  }, [s, trading, pid])
}

/**
 * Close one and close all, one write at a time on the screen (its confirm included), then the
 * cooldown; `busy` disables the buttons meanwhile. `semiBlocked` is the reason of a write
 * Semi-Auto refused, until the next write starts; `liveSurprise` the notice for a write the
 * server took LIVE after an ANALYZE confirm, until dismissed or the next write starts.
 */
export function usePositionWrites() {
  const s = useServices()
  const trading = useTrading()
  const guard = useSubmitGuard()
  const readPositions = useFreshPositions()
  const [semiBlocked, setSemiBlocked] = useState<string | null>(null)
  const [liveSurprise, setLiveSurprise] = useState<string | null>(null)

  const write = <R>(w: Write<R>) =>
    void guard.run(async () => {
      setSemiBlocked(null)
      setLiveSurprise(null)
      const c = await confirmInMode(trading.analyzer, { ...w.confirm, destructive: true })
      if (c.kind === 'error') {
        notifyWarning()
        toast(errorText(c.error))
        return
      }
      if (c.kind === 'declined') return
      const out = await submitOrderAction({
        kind: w.kind,
        shownMode: c.mode,
        send: w.send,
        gate: trading.analyzer,
        confirmLive: confirmLiveOrder,
        books: s.books,
      })
      const r = settle(out, w.endpoint, w.unknown)
      switch (r.kind) {
        case 'ok': {
          const d = w.done(r.reply)
          if (r.liveSurprise) {
            notifyError()
            setLiveSurprise(liveSurpriseText(w.kind))
          } else if (d.ok) notifySuccess()
          else notifyWarning()
          toast(d.line)
          return
        }
        case 'maybe':
          notifyWarning()
          toast(w.kind === 'closeOne' ? CLOSE_CHECKING : CHECKING)
          toast(await w.check())
          return
        case 'refused':
          notifyWarning()
          toast(r.message)
          return
        case 'semi_auto_blocked':
          notifyWarning()
          setSemiBlocked(r.message)
          return
        case 'mode_changed':
          notifyWarning()
          toast(modeChanged(r.now))
          return
        case 'cancelled':
          if (r.message) toast(r.message)
          return
      }
    })

  const closeOne = (row: PositionRow) =>
    write({
      kind: 'closeOne',
      endpoint: 'placesmartorder',
      confirm: {
        title: `Close ${row.symbol} ${row.product}?`,
        body: closeOneBody(row),
        ok: 'Close position',
      },
      send: () => trading.orders.smartClose(row),
      unknown: (reply) => reply.kind === 'no_id',
      done: (reply) => ({
        line:
          reply.kind === 'queued' ? QUEUED_COPY : reply.kind === 'flat' ? ALREADY_FLAT : CLOSE_SENT,
        ok: true,
      }),
      check: async () => {
        let qty = 0
        const r = await reconcileClose({
          fetchPositions: async () => {
            const b = await readPositions()
            qty =
              b.rows.find(
                (p) =>
                  p.symbol === row.symbol &&
                  p.exchange === row.exchange &&
                  p.product === row.product,
              )?.quantity ?? 0
            return b
          },
          row,
          sleep,
        }).catch(() => 'unknown' as const)
        return r === 'closed' ? POSITION_CLOSED : r === 'open' ? stillOpen(qty) : CLOSE_UNCHECKED
      },
    })

  /** `n` is the count of open positions the book shows, which the confirm names. */
  const closeAll = (n: number) =>
    write({
      kind: 'closeAll',
      endpoint: 'closeposition',
      confirm: {
        title: `Close all ${n} open ${n === 1 ? 'position' : 'positions'}?`,
        body: CLOSE_ALL_BODY,
        ok: 'Close all',
      },
      send: () => trading.orders.closeAll(),
      done: (reply) => ({ line: reply.message, ok: true }),
      // The book lags the write: it is read after each of T10's delays until none is open.
      check: async () => {
        let open: number | null = null
        for (const ms of RECONCILE_DELAYS_MS) {
          await sleep(ms)
          try {
            open = (await readPositions()).rows.filter((p) => p.quantity !== 0).length
          } catch {
            continue
          }
          if (open === 0) break
        }
        return open === null
          ? `Status unknown. ${CLOSE_UNCHECKED}`
          : `Status unknown. ${positions(open)} still open.`
      },
    })

  return {
    closeOne,
    closeAll,
    busy: guard.busy(),
    semiBlocked,
    liveSurprise,
    dismissLiveSurprise: () => setLiveSurprise(null),
  }
}
