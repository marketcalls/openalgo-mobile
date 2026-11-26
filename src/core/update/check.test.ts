import { scriptedFetch } from '../../../test/helpers/fakeFetch'
import { memoryKV } from '../../../test/helpers/memoryKV'
import {
  CHECK_EVERY_MS,
  checkForUpdate,
  dismissUpdate,
  parseRelease,
  RELEASES_PAGE,
  readUpdateState,
  UPDATE_KEY,
} from './check'

const RELEASE = {
  tag_name: 'v0.2.0',
  draft: false,
  prerelease: false,
  html_url: `${RELEASES_PAGE}/tag/v0.2.0`,
}
const ROUTE = 'GET /repos/marketcalls/openalgo-mobile/releases/latest'

function setup(body: unknown = RELEASE, appVersion = '0.1.0') {
  const kv = memoryKV()
  const fetchFake = scriptedFetch({ [ROUTE]: { status: 200, body } })
  let t = 1_000_000
  const deps = (enabled = true) => ({
    fetch: fetchFake,
    kv,
    now: () => t,
    appVersion,
    enabled,
  })
  return { kv, fetchFake, deps, advance: (ms: number) => (t += ms) }
}

test('sends exactly one anonymous GET with only the Accept header', async () => {
  const { fetchFake, deps } = setup()
  const n = await checkForUpdate(deps())
  expect(n).toEqual({ version: '0.2.0', url: `${RELEASES_PAGE}/tag/v0.2.0` })
  expect(fetchFake.calls).toHaveLength(1)
  const [req] = fetchFake.calls
  expect(req).toMatchObject({
    method: 'GET',
    url: 'https://api.github.com/repos/marketcalls/openalgo-mobile/releases/latest',
    headers: { accept: 'application/vnd.github+json' },
    body: undefined,
  })
  expect(Object.keys(req?.headers ?? {})).toEqual(['accept'])
  expect(req?.credentials).toBeUndefined()
})

test('asks once a day and answers from the cache between', async () => {
  const { fetchFake, deps, advance } = setup()
  await checkForUpdate(deps())
  advance(CHECK_EVERY_MS - 1)
  expect(await checkForUpdate(deps())).toMatchObject({ version: '0.2.0' })
  expect(fetchFake.calls).toHaveLength(1)
  advance(1)
  await checkForUpdate(deps())
  expect(fetchFake.calls).toHaveLength(2)
})

test('equal or older versions give no notice', async () => {
  expect(await checkForUpdate(setup(RELEASE, '0.2.0').deps())).toBeNull()
  expect(await checkForUpdate(setup(RELEASE, '0.3.0').deps())).toBeNull()
})

test('a dismissed version gives no notice, a newer one does', async () => {
  const { kv, deps, advance, fetchFake } = setup()
  await checkForUpdate(deps())
  await dismissUpdate(kv, '0.2.0')
  expect(await checkForUpdate(deps())).toBeNull()
  expect((await readUpdateState(kv))?.latest?.version).toBe('0.2.0')
  advance(CHECK_EVERY_MS)
  expect(await checkForUpdate(deps())).toBeNull() // refetched, dismissal kept
  expect(fetchFake.calls).toHaveLength(2)
})

test('parseRelease rejects drafts, prereleases and non x.y.z tags', () => {
  expect(parseRelease({ ...RELEASE, prerelease: true })).toBeNull()
  expect(parseRelease({ ...RELEASE, draft: true })).toBeNull()
  expect(parseRelease({ ...RELEASE, tag_name: 'v0.3.0-beta' })).toBeNull()
  expect(parseRelease({ ...RELEASE, tag_name: '0.3.0' })).toMatchObject({ version: '0.3.0' })
  expect(parseRelease(null)).toBeNull()
})

test('an html_url from another host falls back to the releases page', () => {
  expect(parseRelease({ ...RELEASE, html_url: 'https://evil.example/tag/v0.2.0' })?.url).toBe(
    `${RELEASES_PAGE}/latest`,
  )
  expect(parseRelease({ ...RELEASE, html_url: undefined })?.url).toBe(`${RELEASES_PAGE}/latest`)
})

test('a network failure gives null and still records the check time', async () => {
  const kv = memoryKV()
  const fetchFake = scriptedFetch({ [ROUTE]: 'throw' })
  const deps = { fetch: fetchFake, kv, now: () => 5, appVersion: '0.1.0', enabled: true }
  expect(await checkForUpdate(deps)).toBeNull()
  expect(await readUpdateState(kv)).toMatchObject({ checkedAt: 5, latest: null })
  await checkForUpdate(deps)
  expect(fetchFake.calls).toHaveLength(1)
})

test('an HTTP error gives null', async () => {
  const kv = memoryKV()
  const fetchFake = scriptedFetch({ [ROUTE]: { status: 403, body: { message: 'rate limited' } } })
  const n = await checkForUpdate({
    fetch: fetchFake,
    kv,
    now: () => 5,
    appVersion: '0.1.0',
    enabled: true,
  })
  expect(n).toBeNull()
  expect((await readUpdateState(kv))?.checkedAt).toBe(5)
})

test('disabled sends nothing and stores nothing', async () => {
  const { kv, fetchFake, deps } = setup()
  expect(await checkForUpdate(deps(false))).toBeNull()
  expect(fetchFake.calls).toHaveLength(0)
  expect(kv.data.has(UPDATE_KEY)).toBe(false)
})
