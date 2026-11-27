// The on-device routes' dependencies for a test (preflight F conflict 18): what the test gives,
// over defaults that stand for a phone with no master stored, a screen in front, the server
// pricing the Greeks and an empty previous-day OI cache of its own. Options and the Api refuse
// every read the test did not give.
import { profileStorage } from '~/core/config/storage'
import type { RouteDeps } from '~/dom/routes'
import { IntervalsSchema } from '~/market/chart/schemas'
import { createPrevOiCache } from '~/market/history/prevOi'
import { memoryKV } from './memoryKV'

export type RouteDepsOverrides = Partial<Omit<RouteDeps, 'options' | 'master'>> & {
  options?: Partial<RouteDeps['options']>
  master?: Partial<RouteDeps['master']>
}

const notGiven = (what: string) => () => Promise.reject(new Error(`testRouteDeps: no ${what}`))

export function testRouteDeps(o: RouteDepsOverrides = {}): RouteDeps {
  const api: RouteDeps['api'] = o.api ?? { call: notGiven('api') }
  return {
    now: () => Date.now(),
    greeksOnServer: () => true,
    lifetime: new AbortController().signal,
    progress: () => {},
    active: () => true,
    untilActive: async () => {},
    // the routes' intervals over the deps' own Api
    intervals: () => api.call('intervals', {}, IntervalsSchema),
    prevOi: createPrevOiCache(profileStorage(memoryKV(), 'test')),
    ...o,
    api,
    options: {
      expiries: notGiven('options.expiries'),
      expiriesQuery: () => {
        throw new Error('testRouteDeps: no options.expiriesQuery')
      },
      futuresPrice: notGiven('options.futuresPrice'),
      chain: notGiven('options.chain'),
      ...o.options,
    },
    master: {
      underlyingsNow: async () => ({ list: [], source: 'defaults' }),
      strikes: async () => null,
      futures: async () => null,
      lotSizeLike: async () => undefined,
      ...o.master,
    },
  }
}
