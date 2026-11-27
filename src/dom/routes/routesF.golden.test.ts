// Plan F's on-device routes against the server's own Python (design 9.2): each recorded case with
// a master, answered through the phone's routes with the page's own request (`routesF[name].args`),
// and compared with what scripts/golden/harness.py run_f made of the same recording.
import { isRecord } from '~/core/http/errors'
import type { DomReply, JSONValue } from '~/dom/bridge/protocol'
import { keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { type GoldenRouteF, goldenCases, goldenDeps } from '../../../test/helpers/golden'
import { createDeviceRoutes } from './index'

/** How far the flip may sit from the server's: numpy's dot and opengreeks' gamma_array sum and
 *  price in their own order, which moves the interpolated crossing in its last digits. */
const FLIP_BOUND = 0.01

/** The routes the page posts each service's request to. */
const PATHS: readonly [GoldenRouteF, string][] = [
  ['get_strike_profile', '/strikeprofile/api/profile-data'],
  ['get_strike_profile_all', '/strikeprofile/api/profile-data'],
  ['get_vol_surface_data', '/volsurface/api/surface-data'],
]

const withoutFlip = (body: unknown) => {
  if (!isRecord(body)) return body
  const { flip: _flip, ...rest } = body
  return rest
}
const flipOf = (body: unknown) => (isRecord(body) ? body.flip : undefined)

const CASES = goldenCases().filter((c) => c.expected.routesF !== undefined)

beforeEach(() => keepExpectedLogs())
afterEach(() => jest.restoreAllMocks())

test('every case with a master has the routes F golden', () => {
  expect(CASES.map((c) => c.id)).toEqual(
    goldenCases()
      .filter((c) => c.input.master !== undefined)
      .map((c) => c.id),
  )
  expect(CASES.length).toBeGreaterThan(0)
})

test.each(CASES)(
  '$id: strikeProfile at 5% and at all, and volSurface, equal Python',
  async ({ input, expected }) => {
    const d = goldenDeps(input)
    const routes = createDeviceRoutes(d)
    for (const [name, path] of PATHS) {
      const want = expected.routesF?.[name]
      if (!want) throw new Error(`${input.case}: no ${name} golden`)
      const route = routes.find((r) => r.method === 'POST' && r.path === path)
      if (!route) throw new Error(`no route ${path}`)
      const got: DomReply = await route.handle(
        { v: 1, kind: 'request', rid: 1, method: 'POST', path, body: want.args as JSONValue },
        new AbortController().signal,
      )
      expect([name, got.status]).toEqual([name, want.status])
      expect([name, withoutFlip(got.body)]).toEqual([name, withoutFlip(want.body)])
      const [ours, theirs] = [flipOf(got.body), flipOf(want.body)]
      if (typeof theirs === 'number' && typeof ours === 'number') {
        expect([name, Math.abs(ours - theirs) <= FLIP_BOUND]).toEqual([name, true])
      } else {
        expect([name, ours]).toEqual([name, theirs])
      }
    }
    expect(d.misses).toEqual([])
  },
)
