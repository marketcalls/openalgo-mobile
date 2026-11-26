// A tab's write on one row of a book, or on the whole book (design 7.10): behind a native confirm
// that names the server's mode, then sent once through the order safety of `submitOrderAction`,
// one at a time. An outcome that may hide the write is checked against the book, never sent
// again. A write the server took LIVE after the confirm said ANALYZE is told as a danger notice,
// never as a success. The Orders tab's order writes and its GTT writes share it (ruling 25).
import { useState } from 'react'
import type { EndpointId } from '~/core/http/endpoints'
import type { ApiError } from '~/core/http/errors'
import { notifyError, notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { useServices } from '~/core/services/services'
import { toast } from '~/ui/Toast'
import type { WriteOutcome } from '../components/OutcomeLine'
import { useTrading } from '../trading'
import { confirmLiveOrder } from './confirmLive'
import { confirmInMode } from './confirmWrite'
import { useSubmitGuard } from './guard'
import { CHECKING, errorText, modeChanged, settle } from './outcome'
import { holdOrder, otherOrderOut, type PendingScope } from './pending'
import { type ActionKind, liveSurpriseText, submitOrderAction } from './submit'

export type ConfirmedWrite<R> = {
  kind: ActionKind
  endpoint: EndpointId
  /** The row it is on, which the session holds until its outcome is known. */
  scope?: PendingScope
  /** `cancel`: the dismiss button, named for what it keeps ("Keep order"). */
  confirm: { title: string; body: string; ok: string; cancel: string }
  send: () => Promise<R>
  unknown?: (reply: R) => boolean
  /**
   * An error this write's own replies give a meaning `settle` does not know: its line, told as a
   * refusal, or null to leave it to `settle`. G3's JSON 404 on a GTT is "No active GTT", never a
   * missing route (ruling 16).
   */
  refused?: (e: ApiError) => string | null
  /** What the toast says once it went, and whether all of it went (else a warning). */
  done: (reply: R) => { line: string; ok: boolean }
  /**
   * The line to show after an unknown outcome, once the book says. `noReply`: the server may
   * still be sending it, so the check reads on longer.
   */
  check: (o: { noReply: boolean }) => Promise<string>
}

/**
 * One write at a time on the screen, its confirm included, then the cooldown; `busy` disables the
 * write buttons meanwhile. A write on a row is also held on its scope for the session
 * (`market/orders/pending`) until its outcome is known, so a sheet for that row waits for it, even
 * after this screen remounts; `scopeOut` is the toast when another screen's write on the row is
 * still out. `semiBlocked` is the reason of a write Semi-Auto refused, until the next write
 * starts. `liveSurprise` is the notice for a write the server took LIVE after an ANALYZE confirm,
 * until it is dismissed or the next write starts. `outcome` is the last write's line, kept on the
 * tab until dismissed or the next write starts.
 */
export function useConfirmedWrite({ scopeOut }: { scopeOut: string }) {
  const s = useServices()
  const trading = useTrading()
  const guard = useSubmitGuard()
  const [semiBlocked, setSemiBlocked] = useState<string | null>(null)
  const [liveSurprise, setLiveSurprise] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null)
  /** This screen, as the session's writes still out know it. */
  const [me] = useState(() => ({}))

  /** The line on the tab, and as a toast (which a screen reader hears). */
  const tell = (text: string, tone: WriteOutcome['tone'] = 'warning') => {
    setOutcome({ text, tone })
    toast(text)
  }

  const run = <R>(w: ConfirmedWrite<R>) =>
    void guard.run(async () => {
      setSemiBlocked(null)
      setLiveSurprise(null)
      setOutcome(null)
      const c = await confirmInMode(trading.analyzer, { ...w.confirm, destructive: true })
      if (c.kind === 'error') {
        notifyWarning()
        toast(errorText(c.error))
        return
      }
      if (c.kind === 'mode_changed') {
        notifyWarning()
        tell(modeChanged(c.now))
        return
      }
      if (c.kind === 'declined') return
      // The row's buttons wait while it has a write out; this keeps one from ever going.
      if (w.scope !== undefined && otherOrderOut(trading, me, w.scope)) {
        notifyWarning()
        toast(scopeOut)
        return
      }
      const release = w.scope === undefined ? null : holdOrder(trading, me, w.scope)
      try {
        const out = await submitOrderAction({
          kind: w.kind,
          shownMode: c.mode,
          send: w.send,
          gate: trading.analyzer,
          confirmLive: confirmLiveOrder,
          books: s.books,
        })
        const line = out.kind === 'error' ? (w.refused?.(out.error) ?? null) : null
        if (line !== null) {
          notifyWarning()
          tell(line)
          return
        }
        const r = settle(out, w.endpoint, w.unknown)
        switch (r.kind) {
          case 'ok': {
            const d = w.done(r.reply)
            if (r.liveSurprise) {
              notifyError()
              setLiveSurprise(liveSurpriseText(w.kind))
            } else if (d.ok) notifySuccess()
            else notifyWarning()
            tell(d.line, d.ok ? 'neutral' : 'warning')
            return
          }
          case 'maybe':
            notifyWarning()
            tell(CHECKING)
            tell(await w.check({ noReply: r.noReply }))
            return
          case 'refused':
            notifyWarning()
            tell(r.message)
            return
          case 'semi_auto_blocked':
            notifyWarning()
            setSemiBlocked(r.message)
            return
          case 'mode_changed':
            notifyWarning()
            tell(modeChanged(r.now))
            return
          case 'cancelled':
            if (r.message) toast(r.message)
            return
        }
      } finally {
        // The tab's toasts show on the tab itself, so no line is kept for a later sheet.
        release?.()
      }
    })

  return {
    run,
    busy: guard.busy(),
    semiBlocked,
    liveSurprise,
    dismissLiveSurprise: () => setLiveSurprise(null),
    outcome,
    dismissOutcome: () => setOutcome(null),
  }
}
