// A tool page's routes, built from its allowlist (design 7.7): the session routes ported to the
// phone, and the /api/v1 calls the page makes itself. Those go through the Api with the page's
// key placeholder dropped (the HTTP client adds the real key), the capability gate adapting the
// body, and the page's signal; the page gets the server's body as it came. The tearsheet is
// saved by native, since the WebView cannot save a file. A failed call is the router's
// fromApiError reply, never a 401.
import { z } from 'zod'
import type { KeyedApi } from '~/core/http/api'
import { ENDPOINTS, type EndpointId, KEYED_GETS } from '~/core/http/endpoints'
import { type JSONValue, OPENED_IN_APP, type ToolPageId } from '~/dom/bridge/protocol'
import { createDeviceRoutes, type RouteDeps } from '~/dom/routes'
import { ORDER_WRITE_PATHS } from './heldWrites'
import { createOptionChainRoute } from './optionChainRoute'
import { type Route, refused } from './requests'
import { PassThroughSchema, pageBody, TOOL_ALLOWLIST, type ToolRouteSpec } from './toolAllowlist'

export type { RouteDeps } from '~/dom/routes'

/** A file a tool hands to the phone: the tearsheet's text, or a page's save as base64. */
export type SavedFile = { name: string; mime: string } & ({ text: string } | { base64: string })

type ToolApi = Pick<KeyedApi, 'call' | 'get'>

const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * What a download saves as: the tearsheet named by its period, so a second one never replaces
 * the first in the share sheet's target; without both dates, the web's own name
 * (api/portfolio.ts downloadTearsheet).
 */
const DOWNLOADS: Partial<Record<EndpointId, (body: Record<string, unknown>) => string>> = {
  'portfolio/tearsheet': ({ start_date: from, end_date: to }) =>
    typeof from === 'string' && typeof to === 'string' && DAY.test(from) && DAY.test(to)
      ? `OpenAlgo-tearsheet-${from}-to-${to}.html`
      : 'portfolio-tearsheet.html',
}

/** The /api/v1 endpoint a row names, by its path and the method its kind sends. A tool only
 *  reads: an endpoint on an order, smart or control lane (an order, a close, the analyzer switch)
 *  never builds as a row, whatever else guards it (defence in depth beside ORDER_WRITE_PATHS). */
function endpointOf(spec: ToolRouteSpec): EndpointId {
  const id = spec.path.slice('/api/v1/'.length) as EndpointId
  const def = Object.hasOwn(ENDPOINTS, id) ? ENDPOINTS[id] : undefined
  const method = spec.kind === 'lookup' ? 'GET' : 'POST'
  if (def?.path !== spec.path || def.method !== method || spec.method !== method) {
    throw new Error(`no ${spec.kind} endpoint at ${spec.method} ${spec.path}`)
  }
  if (def.lane !== 'read' && def.lane !== 'history') {
    throw new Error(`${spec.path} is on the ${def.lane} lane: a tool row only reads`)
  }
  return id
}

const body200 = (body: unknown): { status: number; body: JSONValue } => ({
  status: 200,
  // the server's JSON, as the client parsed it
  body: body as JSONValue,
})

function passRoute(api: ToolApi, id: EndpointId): Route {
  return {
    method: 'POST',
    path: ENDPOINTS[id].path,
    async handle(r, signal) {
      const body = pageBody(r.body)
      if (body === null) return refused()
      return body200(await api.call(id, body, PassThroughSchema, { signal }))
    },
  }
}

function lookupRoute(api: ToolApi, id: EndpointId): Route {
  return {
    method: 'GET',
    path: ENDPOINTS[id].path,
    async handle(r, signal) {
      // `?apikey=__native__` is the page's; a keyed GET gets the real key from the client
      const { apikey: _placeholder, ...query } = r.query ?? {}
      const withKey = KEYED_GETS.has(id)
      return body200(await api.get(id, query, PassThroughSchema, { signal, withKey }))
    },
  }
}

function downloadRoute(api: ToolApi, id: EndpointId, save: (f: SavedFile) => Promise<void>): Route {
  const name = DOWNLOADS[id]
  if (name === undefined) throw new Error(`no file name for the ${id} download`)
  return {
    method: 'POST',
    path: ENDPOINTS[id].path,
    async handle(r, signal) {
      const body = pageBody(r.body)
      if (body === null) return refused()
      const text = await api.call(id, body, z.string(), { signal })
      await save({ name: name(body), mime: 'text/html', text })
      // the page's own save of this body is dropped (dom/web/downloads.ts)
      return { status: 200, body: OPENED_IN_APP }
    },
  }
}

type ToolRouteDeps = {
  api: ToolApi
  deps: RouteDeps
  save: (f: SavedFile) => Promise<void>
  greeksOnServer?: () => boolean
}

/** The route one allowlist row names; a row that names none is a bug, and throws. */
function routeOf(spec: ToolRouteSpec, d: ToolRouteDeps, device: readonly Route[]): Route {
  if (ORDER_WRITE_PATHS.has(spec.path)) {
    throw new Error(`${spec.path} is an order write: held for review, never allowlisted`)
  }
  switch (spec.kind) {
    case 'device': {
      const found = device.find((x) => x.method === spec.method && x.path === spec.path)
      if (!found) throw new Error(`no device route at ${spec.method} ${spec.path}`)
      return found
    }
    case 'pass':
      return passRoute(d.api, endpointOf(spec))
    case 'lookup':
      return lookupRoute(d.api, endpointOf(spec))
    case 'download':
      return downloadRoute(d.api, endpointOf(spec), d.save)
    case 'optionchain':
      if (endpointOf(spec) !== 'optionchain') throw new Error(`not optionchain: ${spec.path}`)
      return createOptionChainRoute({
        api: d.api,
        greeksOnServer: d.greeksOnServer ?? (() => false),
        now: d.deps.now,
      })
  }
}

/**
 * The routes of `page`'s allowlist, in its order. `greeksOnServer` serves an `optionchain` row
 * (gate optionchainGreeks); without it, the phone prices the Greeks. A row that names no route
 * (a device path dom/routes lacks, an endpoint ENDPOINTS lacks, an order write) throws.
 */
export function createToolRoutes(page: ToolPageId, d: ToolRouteDeps): Route[] {
  const device = createDeviceRoutes(d.deps)
  return TOOL_ALLOWLIST[page].map((spec) => routeOf(spec, d, device))
}
