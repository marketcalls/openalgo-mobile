// The tool pages' interval routes, answered from the screen's one /intervals read (RouteDeps):
// - oiprofile: GET /oiprofile/api/intervals (blueprints/oiprofile.py:24,98-126 at c8b2896), the
//   broker's minutes within 1m, 5m and 15m;
// - intraday: GET /ivchart/api/intervals (ivchart.py:109-137), seconds, minutes and hours;
// - raw: the /intervals body as it is, which /straddle, /straddlepnl and /strategybuilder send
//   (straddle_chart.py:69-86, custom_straddle.py:116-135, strategy_chart.py:182-197).
// A failed read is the Api's error, which the device routes answer as plan D's fromApiError.
import type { JSONValue } from '~/dom/bridge/protocol'
import type { RouteDeps } from './deps'

/** oiprofile.py ALLOWED_INTERVALS. */
const OI_PROFILE_INTERVALS: ReadonlySet<string> = new Set(['1m', '5m', '15m'])

export async function intervalsReply(
  kind: 'oiprofile' | 'intraday' | 'raw',
  d: RouteDeps,
): Promise<JSONValue> {
  const data = await d.intervals()
  if (kind === 'raw') return { status: 'success', data }
  if (kind === 'intraday') {
    const { seconds = [], minutes = [], hours = [] } = data
    return { status: 'success', data: { seconds, minutes, hours } }
  }
  const intervals = (data.minutes ?? []).filter((i) => OI_PROFILE_INTERVALS.has(i))
  return { status: 'success', data: { intervals } }
}
