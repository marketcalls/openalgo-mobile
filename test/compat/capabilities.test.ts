// What the app learns about each stock-server version: from app-info, swagger.json, the keyless
// probes and the live feed.
import { type FeatureId, gate } from '~/core/capabilities/gates'
import { serverStep } from '~/features/onboarding/flow'
import { apiCalls, makeFeed, PROFILE_IDS, until } from '../helpers/compatApp'
import { type MockServerProcess, startMockServerProcess } from '../helpers/mockServer'

const T0 = Date.UTC(2026, 10, 24, 4, 0)
const step = (m: MockServerProcess) =>
  serverStep(m.origin, { fetch, allowDevHosts: true, now: () => T0 })

let mock: MockServerProcess | null = null
afterEach(async () => {
  await mock?.stop()
  mock = null
})

type Row = {
  orderStream: boolean
  close1012: boolean
  optionchainGreeks: boolean
  portfolioTools: boolean
  sectorRotation: boolean
}
const EXPECTED: Record<(typeof PROFILE_IDS)[number], Row> = {
  '2.0.0.0': {
    orderStream: false,
    close1012: false,
    optionchainGreeks: false,
    portfolioTools: false,
    sectorRotation: false,
  },
  '2.0.1.6': {
    orderStream: true,
    close1012: false,
    optionchainGreeks: false,
    portfolioTools: false,
    sectorRotation: false,
  },
  '2.0.2.0': {
    orderStream: true,
    close1012: false,
    optionchainGreeks: true,
    portfolioTools: true,
    sectorRotation: false,
  },
  '2.0.3.5': {
    orderStream: true,
    close1012: true,
    optionchainGreeks: true,
    portfolioTools: true,
    sectorRotation: true,
  },
}

describe('capabilities per version', () => {
  test.each(PROFILE_IDS)(
    '%s: the gates match the version once the feed is connected',
    async (p) => {
      mock = await startMockServerProcess({ PROFILE: p })
      const feed = await makeFeed(mock)
      feed.realtime.start()
      // The feed's answer to subscribe_orders settles the order stream (S11).
      await until(() => feed.caps.ws().orderStream !== null, 5000, 'orderStream known')
      feed.realtime.stop()

      const c = feed.caps.get()
      if (!c) throw new Error('no caps')
      const on = (f: FeatureId) => gate(c, f).on
      expect({
        orderStream: on('orderStream'),
        close1012: c.ws.close1012,
        optionchainGreeks: on('optionchainGreeks'),
        portfolioTools: on('portfolioTools'),
        sectorRotation: on('sectorRotation'),
      }).toEqual(EXPECTED[p])
    },
  )
})

describe('version detection fallbacks', () => {
  test('2.0.3.5 without app-info is found through swagger.json', async () => {
    mock = await startMockServerProcess({ PROFILE: '2.0.3.5' })
    await mock.control({ appInfo: false })
    const r = await step(mock)
    if (r.kind !== 'ok') throw new Error(`serverStep gave ${r.kind}`)
    expect(r.caps).toMatchObject({ version: null, versionSource: 'marker' })
    expect(r.caps.endpoints).toContain('sectorrotation')
    // swagger answered, so nothing was probed
    expect(apiCalls((await mock.stats()).requests)).toEqual({})
  })

  test('2.0.2.0 without app-info or swagger.json is found through the probe', async () => {
    mock = await startMockServerProcess({ PROFILE: '2.0.2.0' })
    await mock.control({ appInfo: false, swagger: false })
    const r = await step(mock)
    if (r.kind !== 'ok') throw new Error(`serverStep gave ${r.kind}`)
    expect(r.caps).toMatchObject({ version: null, versionSource: 'marker', endpoints: null })
    expect(r.caps.probed).toMatchObject({
      multioptiongreeks: true,
      'portfolio/backtest': true,
      'sip/backtest': true,
      sectorrotation: false,
    })
    expect(gate(r.caps, 'portfolioTools').on).toBe(true)
    expect(gate(r.caps, 'sectorRotation').on).toBe(false)
    const probes = Object.values(apiCalls((await mock.stats()).requests)).reduce((a, b) => a + b, 0)
    expect(probes).toBeGreaterThan(0)
    expect(probes).toBeLessThanOrEqual(10)
  })
})
