import type { Capabilities } from '~/core/capabilities/gates'
import { GTT_GATES, gttFeatureKey, gttSupport } from './support'

const BASE = ['ping', 'search', 'funds', 'multioptiongreeks']
const GTT = ['placegttorder', 'modifygttorder', 'cancelgttorder', 'gttorderbook']

function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    host: 'https://algo.example.com',
    version: '2.0.1.6',
    versionSource: 'app-info',
    endpoints: [...BASE, ...GTT],
    probed: {},
    fields: {},
    features: {},
    ws: { orderStream: null, ping: null, close1012: false, authDeadline: true },
    probedAt: 0,
    ...over,
  }
}

const LIVE = { mode: 'live', broker: 'zerodha' } as const
const ANALYZE = { mode: 'analyze', broker: 'zerodha' } as const

test('GTT_GATES and gttFeatureKey', () => {
  expect(GTT_GATES).toEqual({ endpoints: '2.0.0.8', sandbox: '2.0.1.9', status: '2.0.2.4' })
  expect(gttFeatureKey('zerodha', 'live')).toBe('gtt:zerodha:live')
  expect(gttFeatureKey('dhan', 'analyze')).toBe('gtt:dhan:analyze')
})

describe('(RF 2) per broker and mode', () => {
  const seen = caps({
    features: { 'gtt:zerodha:analyze': false, 'gtt:zerodha:live': true },
  })

  test('2.0.1.6, ANALYZE refused: no, needing the sandbox version 2.0.1.9', () => {
    expect(gttSupport(seen, ANALYZE)).toEqual({
      state: 'no',
      reason: 'GTT in the analyzer needs OpenAlgo 2.0.1.9',
      needs: '2.0.1.9',
      detect: false,
    })
  })

  test('the same server in LIVE: yes', () => {
    expect(gttSupport(seen, LIVE)).toMatchObject({ state: 'yes', detect: false })
    expect(gttSupport(seen, LIVE).needs).toBeUndefined()
  })

  test('another broker on the same server has nothing recorded: unknown, and detected', () => {
    expect(gttSupport(seen, { mode: 'live', broker: 'dhan' })).toMatchObject({
      state: 'unknown',
      detect: true,
    })
  })

  test('a broker without GTT in LIVE: no, and no version fixes it', () => {
    const c = caps({ version: '2.0.3.5', features: { 'gtt:angel:live': false } })
    const out = gttSupport(c, { mode: 'live', broker: 'angel' })
    expect(out).toEqual({
      state: 'no',
      reason: 'This broker has no GTT on this server',
      detect: false,
    })
  })

  test('ANALYZE refused on 2.0.1.9 or later is the broker, not the sandbox', () => {
    const c = caps({ version: '2.0.1.9', features: { 'gtt:zerodha:analyze': false } })
    expect(gttSupport(c, ANALYZE)).toEqual({
      state: 'no',
      reason: 'This broker has no GTT on this server',
      detect: false,
    })
  })

  test('ANALYZE refused with the version unknown still names the sandbox version', () => {
    const c = caps({
      version: null,
      versionSource: 'marker',
      features: { 'gtt:zerodha:analyze': false },
    })
    expect(gttSupport(c, ANALYZE)).toMatchObject({ state: 'no', needs: '2.0.1.9' })
  })
})

describe('gates', () => {
  test('no caps yet: unknown, not detected', () => {
    expect(gttSupport(null, LIVE)).toMatchObject({ state: 'unknown', detect: false })
  })

  test('swagger without gttorderbook on 2.0.0.0: no, needing 2.0.0.8', () => {
    const c = caps({ version: '2.0.0.0', endpoints: BASE })
    expect(gttSupport(c, LIVE)).toEqual({
      state: 'no',
      reason: 'GTT needs OpenAlgo 2.0.0.8',
      needs: '2.0.0.8',
      detect: false,
    })
  })

  test('a probe that did not find gttorderbook, version unknown: no, needing 2.0.0.8', () => {
    const c = caps({
      version: null,
      versionSource: 'marker',
      endpoints: null,
      probed: { gttorderbook: false },
    })
    expect(gttSupport(c, LIVE)).toMatchObject({ state: 'no', needs: '2.0.0.8' })
  })

  test('a missing gttorderbook on a server known to be 2.0.0.8 or later needs no version', () => {
    const c = caps({ version: '2.0.3.5', endpoints: BASE })
    expect(gttSupport(c, LIVE)).toEqual({
      state: 'no',
      reason: 'This server does not list the GTT endpoints',
      detect: false,
    })
  })

  test('the missing endpoint beats a recorded success', () => {
    const c = caps({ endpoints: BASE, features: { 'gtt:zerodha:live': true } })
    expect(gttSupport(c, LIVE).state).toBe('no')
  })

  test('2.0.0.7 with gttorderbook unknown and the broker known: no version compare, detected', () => {
    const c = caps({ version: '2.0.0.7', endpoints: null, probed: {} })
    expect(gttSupport(c, LIVE)).toMatchObject({ state: 'unknown', detect: true })
    // what the detection read records then answers, as on any other server
    expect(gttSupport({ ...c, features: { 'gtt:zerodha:live': true } }, LIVE).state).toBe('yes')
    expect(gttSupport({ ...c, features: { 'gtt:zerodha:live': false } }, LIVE)).toEqual({
      state: 'no',
      reason: 'This broker has no GTT on this server',
      detect: false,
    })
  })

  test.each(['NSE_INDEX', 'BSE_INDEX'])('exchange %s: no, indices have no GTT', (exchange) => {
    const c = caps({ features: { 'gtt:zerodha:live': true } })
    expect(gttSupport(c, { ...LIVE, exchange })).toEqual({
      state: 'no',
      reason: 'Indices have no GTT',
      detect: false,
    })
  })

  test('an exchange that takes orders does not change the answer', () => {
    const c = caps({ features: { 'gtt:zerodha:live': true } })
    expect(gttSupport(c, { ...LIVE, exchange: 'NSE' }).state).toBe('yes')
    expect(gttSupport(c, { ...LIVE, exchange: 'NFO' }).state).toBe('yes')
  })

  test("mode 'unknown': unknown, not detected", () => {
    const c = caps({ features: { 'gtt:zerodha:live': true } })
    expect(gttSupport(c, { mode: 'unknown', broker: 'zerodha' })).toMatchObject({
      state: 'unknown',
      detect: false,
    })
  })

  test('broker not known: unknown, not detected', () => {
    expect(gttSupport(caps(), { mode: 'live', broker: null })).toMatchObject({
      state: 'unknown',
      detect: false,
    })
  })
})
