// The margin line (design 7.10): `/api/v1/margin` for the order as it would be sent, asked once
// the ticket has been still for a moment, and for a basket's review once, with every leg
// (ux-bar BR-5). It is optional: a server that answers 501 (15 brokers, C4) turns it off for the
// session, and any other failure only hides the line. It never holds up a confirm.
import { useEffect, useRef, useState } from 'react'
import { hasEndpoint } from '~/core/capabilities/gates'
import { ApiError } from '~/core/http/errors'
import { log } from '~/core/log/logger'
import { useServices } from '~/core/services/services'
import type { BasketLeg } from '~/market/orders/basket'
import { type Margin, MarginSchema, marginBody, type OrderSpec } from '~/market/orders/schemas'
import { useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'

/** Edits closer together than this make one margin call. */
export const MARGIN_DEBOUNCE_MS = 600

/** The positions one margin request takes, and their symbols' length (MarginCalculatorSchema). */
const MAX_POSITIONS = 50
const MAX_POSITION_SYMBOL = 50

/**
 * The margin the request `sig` names, in rupees, asked `delayMs` after `sig` last changed; null
 * while there is none to show. `sig` is null when there is nothing to ask. It asks only while
 * nothing is blocked, the server is not known to lack the endpoint (ruling 25: an unknown one is
 * tried) and margin has not been turned off. A new `sig` or the screen going aborts the last ask.
 */
function useMargin(
  sig: string | null,
  delayMs: number,
  ask: (signal: AbortSignal) => Promise<Margin>,
): number | null {
  const { caps } = useServices()
  const { flags } = useTrading()
  const blocked = useBrokerBlocked()
  // the flag lives on Trading, for the session; the state re-renders the screen that set it
  const [, setOff] = useState(false)
  const [shown, setShown] = useState<{ sig: string; total: number } | null>(null)
  const latest = useRef(ask)
  latest.current = ask

  const c = caps.get()
  const listed = c === null || hasEndpoint(c, 'margin') !== false
  const asks = sig !== null && listed && !flags.marginOff && !blocked

  useEffect(() => {
    if (!asks || sig === null) return
    const target = latest.current
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      target(ctrl.signal).then(
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
    }, delayMs)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [asks, sig, delayMs, flags])

  return asks && shown?.sig === sig ? shown.total : null
}

/** The ticket's margin for `spec`, null while the ticket has issues (`spec` null). */
export function useMarginPreview(spec: OrderSpec | null): number | null {
  const { orders } = useTrading()
  return useMargin(spec === null ? null : JSON.stringify(spec), MARGIN_DEBOUNCE_MS, (signal) =>
    // a non-null sig is a non-null spec
    orders.margin(spec as OrderSpec, { signal }),
  )
}

/**
 * A basket's margin, every leg in one call, asked once as its review opens. A basket the server
 * would refuse to price (more than 50 legs, or a symbol over 50 characters) is never asked.
 */
export function useBasketMargin(legs: readonly BasketLeg[]): number | null {
  const { api } = useServices()
  const fits =
    legs.length <= MAX_POSITIONS && legs.every((l) => l.symbol.length <= MAX_POSITION_SYMBOL)
  const body = { positions: legs.flatMap((l) => marginBody(l).positions) }
  return useMargin(fits ? JSON.stringify(body) : null, 0, (signal) =>
    api.call('margin', body, MarginSchema, { signal }),
  )
}
