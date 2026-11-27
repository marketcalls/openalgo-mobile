// What the chart page may ask of native (design 7.7, 7.9): its history and search over the
// chart's two-route allowlist, its WebSocket emulated over the app's own feed, and its storage on
// the phone. Its intents and events go to the screen.
// - A hidden chart sends nothing: its requests wait for the next focus (one shared wait per
//   hidden period, not a listener per request), and its polled quotes stop (design 7.5).
// - Under polling the emulation relays polled quotes, framed only while the instrument's
//   exchange is in session by the server's calendar (RF 5); the defaults stand in until that is
//   read, and an exchange it does not list is not filtered.
// - `reset` lets go of everything a page holds: the WebView died, or the screen reloads it or
//   goes. A page that loads again on the same host restarts its socket ids at 1, so its holds go
//   then too.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServices } from '~/core/services/services'
import type { DomHandlers } from '~/dom/bridge/DomHost'
import type { Outbox } from '~/dom/bridge/outbox'
import type { DomEvent, DomIntentMsg } from '~/dom/bridge/protocol'
import { createChartRoutes } from '~/dom/gateway/chartRoutes'
import { createChartStorageHandler } from '~/dom/gateway/chartStorage'
import { createRequestRouter } from '~/dom/gateway/requests'
import { createWsEmulation } from '~/dom/gateway/wsEmulation'
import { calendarExchange, DEFAULT_CALENDARS, inSession } from '~/market/chart/calendar'
import { useSessionCalendars } from '~/market/chart/queries'

type Options = {
  /** The current page's outbox; a new page (a new host) comes with a new one. */
  outbox: Outbox
  /** The app is polling for prices. */
  polling: boolean
  /** The screen is in front and the app in the foreground. */
  active: boolean
  onIntent: (m: DomIntentMsg) => void
  onEvent: (e: DomEvent) => void
}

/** Resolves the requests that wait for the screen to be shown again. */
type Waiting = { promise: Promise<void>; resolve: () => void }

function waiting(): Waiting {
  let resolve = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

export function useChartGateway(o: Options): { handlers: DomHandlers; reset(): void } {
  const s = useServices()
  const latest = useRef(o)
  latest.current = o
  const calendars = useSessionCalendars()
  const sessions = useRef(DEFAULT_CALENDARS)
  sessions.current = calendars?.calendars ?? DEFAULT_CALENDARS

  // The emulation and the hidden-period wait read the screen's state when they run.
  const shown = useRef<{ active: boolean; waiting: Waiting | null }>({
    active: o.active,
    waiting: null,
  })
  useEffect(() => {
    const g = shown.current
    g.active = o.active
    if (!o.active || g.waiting === null) return
    g.waiting.resolve()
    g.waiting = null
  }, [o.active])

  const [emulation] = useState(() =>
    createWsEmulation({
      realtime: s.realtime,
      store: s.store,
      polling: s.polling,
      orderEvents: s.orderEvents,
      // the same feed status the polling consumers and the app's badges follow
      feedMode: () =>
        latest.current.polling || s.realtime.status().state === 'polling' ? 'polling' : 'live',
      whenPolling: 'relay',
      active: () => shown.current.active,
      post: (m) => latest.current.outbox.post(m),
      isOpen: (exchange, now) => {
        const spec = sessions.current[calendarExchange(exchange)]
        return spec ? inSession(spec, now) : null
      },
    }),
  )

  const reset = useCallback(() => {
    emulation.closeAll()
    latest.current.outbox.clear()
  }, [emulation])
  // the screen goes: nothing it held stays
  useEffect(() => reset, [reset])

  // The page's storage keeps one write queue per stored name, in the handler: one per profile.
  const storage = useMemo(() => createChartStorageHandler(s.storage), [s.storage])

  const whenActive = useCallback((): Promise<void> => {
    const g = shown.current
    if (g.active) return Promise.resolve()
    g.waiting ??= waiting()
    return g.waiting.promise
  }, [])

  // One set per page: its requests are counted against the per-page cap on their own.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new outbox is a new page, which gets its own set
  const handlers = useMemo<DomHandlers>(() => {
    let loaded = false
    return {
      request: createRequestRouter(createChartRoutes(s.api), { whenActive }),
      socket: (m) => emulation.handle(m),
      storage,
      intent: (m) => latest.current.onIntent(m),
      event: (e) => {
        if (e.name === 'loaded') {
          // the page loaded again on this host: what the last load held goes first
          if (loaded) reset()
          loaded = true
        }
        latest.current.onEvent(e)
      },
    }
  }, [o.outbox, s.api, whenActive, emulation, storage, reset])

  return { handlers, reset }
}
