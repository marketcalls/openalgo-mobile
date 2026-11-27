// A tool page's native side over a compat app, built from the same pieces useToolGateway joins
// (startup routes, the page's allowlist routes, the held order writes, one request router), so
// compat runs the gateway without a screen. The seed is the broker the profile names.

import { gate } from '~/core/capabilities/gates'
import type { DomReply, DomRequest, JSONValue, ToolPageId } from '~/dom/bridge/protocol'
import { createHeldWriteRoutes, createHeldWrites } from '~/dom/gateway/heldWrites'
import { createRequestRouter } from '~/dom/gateway/requests'
import { createStartupRoutes } from '~/dom/gateway/startupRoutes'
import { createToolRoutes, type SavedFile } from '~/dom/gateway/toolRoutes'
import { brokerCaps } from '~/market/brokers/seed'
import { createSymbolMaster, type SymbolMaster } from '~/market/master/master'
import { createMemoryMasterDb } from '~/market/master/memoryDb'
import { createOptionsData, type OptionsData } from '~/market/options/data'
import { createAnalyzerGate } from '~/market/orders/analyzerGate'
import type { App } from './compatApp'

export type ToolGateway = {
  /** What `createTrading` builds for these routes (trading.tsx imports react-native, not loadable here). */
  trading: { options: OptionsData; master: SymbolMaster }
  saved: SavedFile[]
  /** One request as the page sends it, answered as the page would be. */
  send(
    method: 'GET' | 'POST',
    path: string,
    x?: { query?: Record<string, string>; body?: JSONValue },
  ): Promise<DomReply>
}

let rid = 0

export function toolGateway(app: App, page: ToolPageId): ToolGateway {
  const pid = app.profile.get().id
  const analyzer = createAnalyzerGate({ queryClient: app.queryClient, pid, api: app.api })
  const trading = {
    options: createOptionsData({
      api: app.api,
      queryClient: app.queryClient,
      pid,
      clock: app.clock,
    }),
    master: createSymbolMaster({
      api: app.api,
      db: Promise.resolve(createMemoryMasterDb()),
      pid,
      now: () => app.clock.now(),
    }),
  }
  const saved: SavedFile[] = []
  const held = createHeldWrites()
  const routes = [
    ...createStartupRoutes({
      seed: () => ({
        broker: 'zerodha',
        capabilities: brokerCaps('zerodha', app.caps.get()?.version ?? null),
      }),
      analyzer: () => analyzer.read(),
    }),
    ...createToolRoutes(page, {
      api: app.api,
      deps: {
        options: trading.options,
        master: trading.master,
        api: app.api,
        now: () => app.clock.now(),
      },
      save: async (f) => {
        saved.push(f)
      },
      greeksOnServer: () => {
        const caps = app.caps.get()
        return caps !== null && gate(caps, 'optionchainGreeks').on
      },
    }),
    ...createHeldWriteRoutes(held, page, { reviewable: new Set(['placeorder']) }),
  ]
  const router = createRequestRouter(routes)
  return {
    trading,
    saved,
    send(method, path, x = {}) {
      const r: DomRequest = { v: 1, kind: 'request', rid: ++rid, method, path, ...x }
      return router(r, new AbortController().signal)
    },
  }
}
