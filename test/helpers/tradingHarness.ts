// The trading layer over the mock: `makeApp` (real services, Node fetch and `ws`) plus the
// trading pieces the order paths use, with the timings the compat suite needs.
import { createEventWatch } from '~/market/books/eventWatch'
import { createInstrumentCache } from '~/market/instruments/cache'
import { type AnalyzerMode, createAnalyzerGate } from '~/market/orders/analyzerGate'
import { createOrderApi } from '~/market/orders/api'
import { type ActionKind, submitOrderAction } from '~/market/orders/submit'
import { type App, makeApp } from './compatApp'
import type { MockServerProcess } from './mockServer'

/** The waits between order book reads after an unknown outcome: short, so tests stay quick. */
export const RECONCILE_DELAYS_MS = [200, 500, 1000] as const
/** A splitorder that has not answered by then is given up as MaybePlaced. */
export const SPLIT_TIMEOUT_MS = 2000
/** How long an own order may go without its event before the watch demotes. */
export const WATCH_TIMEOUT_MS = 1000

export async function tradingHarness(mock: MockServerProcess) {
  const app: App = await makeApp(mock)
  const now = () => Date.now()
  const instruments = createInstrumentCache({ api: app.api, storage: app.storage, now })
  // ttlMs 0: a toggle of the analyzer shows on the next read.
  const gate = createAnalyzerGate({
    queryClient: app.queryClient,
    pid: app.profile.get().id,
    api: app.api,
    ttlMs: 0,
  })
  const watch = createEventWatch({ now, timeoutMs: WATCH_TIMEOUT_MS })
  const offBus = app.orderEvents.subscribe((u) => watch.seen(u.orderid))

  /** One write as the screens send it: the mode is read again and must match `shownMode`. */
  async function submit<R>(kind: ActionKind, send: () => Promise<R>, shownMode?: AnalyzerMode) {
    return submitOrderAction({
      kind,
      shownMode: shownMode ?? (await gate.read()),
      send,
      gate,
      confirmLive: async () => 'ok',
      books: app.books,
    })
  }

  return {
    app,
    api: app.api,
    orders: createOrderApi(app.api),
    gate,
    watch,
    realtime: app.realtime,
    bus: app.orderEvents,
    instruments: instruments,
    submit,
    control: mock.control,
    stats: () => mock.stats(),
    splitTimeoutMs: SPLIT_TIMEOUT_MS,
    delaysMs: RECONCILE_DELAYS_MS,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    dispose() {
      offBus()
      watch.reset()
      app.dispose()
    },
  }
}

export type TradingHarness = Awaited<ReturnType<typeof tradingHarness>>
