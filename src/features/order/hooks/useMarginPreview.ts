// The ticket's margin line (design 7.10): `/api/v1/margin` for the order as it would be sent,
// asked once the ticket has been still for a moment. It is optional: a server that answers 501
// (15 brokers, C4) turns it off for the session, and any other failure only hides the line.
import { useEffect, useRef, useState } from 'react'
import { hasEndpoint } from '~/core/capabilities/gates'
import { ApiError } from '~/core/http/errors'
import { log } from '~/core/log/logger'
import { useServices } from '~/core/services/services'
import type { OrderSpec } from '~/market/orders/schemas'
import { useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'

/** Edits closer together than this make one margin call. */
export const MARGIN_DEBOUNCE_MS = 600

/**
 * The margin `spec` needs, in rupees; null while there is none to show. `spec` is null while the
 * ticket has issues. It asks only while nothing is blocked, the server is not known to lack the
 * endpoint (ruling 25: an unknown one is tried) and margin has not been turned off.
 */
export function useMarginPreview(spec: OrderSpec | null): number | null {
  const { caps } = useServices()
  const { orders, flags } = useTrading()
  const blocked = useBrokerBlocked()
  // the flag lives on Trading, for the session; the state re-renders the ticket that set it
  const [, setOff] = useState(false)
  const [shown, setShown] = useState<{ sig: string; total: number } | null>(null)
  const latest = useRef(spec)
  latest.current = spec

  const sig = spec === null ? null : JSON.stringify(spec)
  const c = caps.get()
  const listed = c === null || hasEndpoint(c, 'margin') !== false
  const asks = sig !== null && listed && !flags.marginOff && !blocked

  useEffect(() => {
    const target = latest.current
    if (!asks || sig === null || target === null) return
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      orders.margin(target, { signal: ctrl.signal }).then(
        (m) => setShown({ sig, total: m.total }),
        (e: unknown) => {
          if (ctrl.signal.aborted) return
          setShown(null)
          if (e instanceof ApiError && e.kind === 'Unsupported') {
            log.info('order', 'margin is not supported here: hidden for the session')
            flags.marginOff = true
            setOff(true)
          }
        },
      )
    }, MARGIN_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [asks, sig, orders, flags])

  return asks && shown?.sig === sig ? shown.total : null
}
