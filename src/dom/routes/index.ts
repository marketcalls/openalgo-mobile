// The session routes the tool pages call, answered on the phone from /api/v1 (design 7.8, the
// plan's tool contract): none of them is ever sent to the server. Each answers what its web route
// answers with 200; a reply the route makes itself (a bad body, a service's 404 or 500) with that
// status and body; and a failed /api/v1 read with plan D's fromApiError reply, never a 401. An
// aborted page request rejects, so the router answers nothing.
import { ApiError } from '~/core/http/errors'
import type { DomReply, DomRequest, JSONValue } from '~/dom/bridge/protocol'
import { fromApiError, type Route } from '~/dom/gateway/requests'
import { type RouteDeps, RouteError, type RouteOptions } from './deps'
import { gammaDensity } from './gammaDensity'
import { gexData } from './gex'
import { intervalsReply } from './intervals'
import { IvChartQuery, ivChart } from './ivChart'
import { ivSmile } from './ivSmile'
import { OiProfileQuery, oiProfile } from './oiProfile'
import { maxPain, oiData } from './oiTracker'
import { expiries, underlyings } from './pickers'
import { parseBody, parseToolQuery, type ToolQuery } from './query'
import { chartinkSearch, siteSearch } from './search'
import { StraddleQuery, straddleData } from './straddle'
import { lotSize, SimulateQuery, straddleSimulate } from './straddlePnl'
import { StrikeProfileQuery, strikeProfile } from './strikeProfile'
import { VolSurfaceQuery, volSurface } from './volSurface'

export { type RouteDeps, RouteError, type RouteOptions } from './deps'
export { gammaDensity } from './gammaDensity'
export { gexData } from './gex'
export { IvChartQuery, type IvChartQueryOut, ivChart } from './ivChart'
export { ivSmile } from './ivSmile'
export {
  OI_BACKGROUND_MS,
  OI_FIRST_ANSWER_MS,
  OiProfileQuery,
  type OiProfileQueryOut,
  oiPartialNote,
  oiProfile,
} from './oiProfile'
export { maxPain, oiData } from './oiTracker'
export { expiries, underlyings } from './pickers'
export { parseToolQuery, type ToolQuery, ToolQuerySchema } from './query'
export { type ChartinkHit, chartinkSearch, type SiteSearchHit, siteSearch } from './search'
export {
  type AtmAsk,
  type AtmData,
  atmHistories,
  StraddleQuery,
  type StraddleQueryOut,
  straddleData,
  strikeLadder,
} from './straddle'
export {
  lotSize,
  SimulateQuery,
  type SimulateQueryOut,
  straddleSimulate,
} from './straddlePnl'
export {
  type FlipLeg,
  findGammaFlip,
  StrikeProfileQuery,
  type StrikeProfileQueryOut,
  strikeProfile,
} from './strikeProfile'
export { VolSurfaceQuery, type VolSurfaceQueryOut, volSurface } from './volSurface'

type Answer = (r: DomRequest, d: RouteDeps, o: RouteOptions) => Promise<unknown>

/** A query-string value as the route's `request.args.get(name, "")` reads it. */
const arg = (r: DomRequest, name: string) => r.query?.[name] ?? ''
/** A tool POST: the web route's checks on the body, then its service. */
const tool =
  (service: (q: ToolQuery, d: RouteDeps, o: RouteOptions) => Promise<unknown>): Answer =>
  (r, d, o) =>
    service(parseToolQuery(r.body), d, o)

const TABLE: readonly { method: 'GET' | 'POST'; path: string; answer: Answer }[] = [
  {
    method: 'GET',
    path: '/search/api/underlyings',
    answer: (r, d) => underlyings(arg(r, 'exchange'), d),
  },
  {
    method: 'GET',
    path: '/search/api/expiries',
    answer: (r, d) =>
      expiries(arg(r, 'exchange'), arg(r, 'underlying'), r.query?.instrumenttype, d),
  },
  {
    method: 'GET',
    path: '/search/api/search',
    answer: (r, d, o) => siteSearch(arg(r, 'q'), r.query?.exchange, d, o),
  },
  {
    method: 'GET',
    path: '/chartink/search',
    answer: (r, d, o) => chartinkSearch(arg(r, 'q'), r.query?.exchange, d, o),
  },
  { method: 'POST', path: '/oitracker/api/oi-data', answer: tool(oiData) },
  { method: 'POST', path: '/oitracker/api/maxpain', answer: tool(maxPain) },
  { method: 'POST', path: '/ivsmile/api/iv-smile-data', answer: tool(ivSmile) },
  { method: 'POST', path: '/gex/api/gex-data', answer: tool(gexData) },
  { method: 'POST', path: '/gammadensity/api/gamma-data', answer: tool(gammaDensity) },
  {
    method: 'POST',
    path: '/strikeprofile/api/profile-data',
    answer: (r, d, o) => strikeProfile(parseBody(StrikeProfileQuery, r.body), d, o),
  },
  {
    method: 'POST',
    path: '/volsurface/api/surface-data',
    answer: (r, d, o) => volSurface(parseBody(VolSurfaceQuery, r.body), d, o),
  },
  {
    method: 'POST',
    path: '/ivchart/api/iv-data',
    answer: (r, d, o) => ivChart(parseBody(IvChartQuery, r.body), d, o),
  },
  {
    method: 'GET',
    path: '/ivchart/api/intervals',
    answer: (_r, d) => intervalsReply('intraday', d),
  },
  {
    method: 'POST',
    path: '/oiprofile/api/profile-data',
    answer: (r, d, o) => oiProfile(parseBody(OiProfileQuery, r.body), d, o),
  },
  {
    method: 'GET',
    path: '/oiprofile/api/intervals',
    answer: (_r, d) => intervalsReply('oiprofile', d),
  },
  {
    method: 'POST',
    path: '/straddle/api/straddle-data',
    answer: (r, d, o) => straddleData(parseBody(StraddleQuery, r.body), d, o),
  },
  {
    method: 'GET',
    path: '/straddle/api/intervals',
    answer: (_r, d) => intervalsReply('raw', d),
  },
  {
    method: 'POST',
    path: '/straddlepnl/api/simulate',
    answer: (r, d, o) => straddleSimulate(parseBody(SimulateQuery, r.body), d, o),
  },
  {
    method: 'GET',
    path: '/straddlepnl/api/lotsize',
    answer: (r, d, o) => lotSize(arg(r, 'underlying'), arg(r, 'exchange'), d, o),
  },
  {
    method: 'GET',
    path: '/straddlepnl/api/intervals',
    answer: (_r, d) => intervalsReply('raw', d),
  },
]

/** Every route answered on the phone, for the gateway's allowlists. */
export const DEVICE_ROUTES: readonly { method: 'GET' | 'POST'; path: string }[] = TABLE.map(
  ({ method, path }) => ({ method, path }),
)

export function createDeviceRoutes(d: RouteDeps): Route[] {
  return TABLE.map(({ method, path, answer }) => ({
    method,
    path,
    async handle(r, signal): Promise<DomReply> {
      try {
        // the replies are the web routes' JSON bodies
        return { status: 200, body: (await answer(r, d, { signal })) as JSONValue }
      } catch (e) {
        if (e instanceof RouteError) return { status: e.status, body: e.body }
        if (e instanceof ApiError && !signal.aborted) return fromApiError(e)
        throw e
      }
    },
  }))
}
