import { type Capabilities, type FeatureId, gate, hasEndpoint, VERSION_GATES } from './gates'

const BASE = ['ping', 'search', 'funds', 'history', 'optionchain', 'multioptiongreeks']
const TOOLS = ['portfolio/backtest', 'sip/backtest']

function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    host: 'https://algo.example.com',
    version: '2.0.3.5',
    versionSource: 'app-info',
    endpoints: [...BASE, ...TOOLS, 'sectorrotation'],
    probed: {},
    fields: {},
    ws: { orderStream: null, ping: null, close1012: true, authDeadline: true },
    probedAt: 0,
    ...over,
  }
}

const FEATURES: FeatureId[] = [
  ...(Object.keys(VERSION_GATES) as (keyof typeof VERSION_GATES)[]),
  'historySource',
]

test('VERSION_GATES holds the S10 versions', () => {
  expect(VERSION_GATES).toEqual({
    authDeadline: '2.0.0.5',
    orderStream: '2.0.1.6',
    portfolioTools: '2.0.1.8',
    optionchainGreeks: '2.0.2.0',
    json404: '2.0.2.1',
    sectorRotation: '2.0.3.0',
    omitsAbsentTickFields: '2.0.3.3',
    close1012: '2.0.3.5',
  })
})

describe('gate by version', () => {
  test.each(FEATURES)('2.0.3.5 turns %s on', (f) => {
    expect(gate(caps(), f)).toMatchObject({ on: true })
    expect(gate(caps(), f).needs).toBeUndefined()
  })

  test('2.0.1.6: orderStream on, optionchainGreeks needs 2.0.2.0', () => {
    const c = caps({ version: '2.0.1.6', endpoints: BASE })
    expect(gate(c, 'orderStream').on).toBe(true)
    expect(gate(c, 'optionchainGreeks')).toEqual({
      on: false,
      reason: 'needs 2.0.2.0; the server is 2.0.1.6',
      needs: '2.0.2.0',
    })
  })

  test('the gate version itself is enough', () => {
    expect(gate(caps({ version: '2.0.2.0' }), 'optionchainGreeks').on).toBe(true)
    expect(gate(caps({ version: '2.0.2.0' }), 'json404').on).toBe(false)
  })

  test('with no version, a version-gated feature is off: server version unknown', () => {
    const c = caps({ version: null, versionSource: 'marker' })
    expect(gate(c, 'close1012')).toEqual({
      on: false,
      reason: 'server version unknown',
      needs: '2.0.3.5',
    })
    expect(gate(c, 'authDeadline')).toMatchObject({ on: false, reason: 'server version unknown' })
  })

  test('historySource has no version gate, so it is on even with no version', () => {
    expect(gate(caps({ version: null, versionSource: 'marker' }), 'historySource')).toMatchObject({
      on: true,
    })
  })
})

describe('evidence beats version (design 5.8)', () => {
  test('no version, swagger lists portfolio/backtest and sip/backtest → portfolioTools on', () => {
    const c = caps({ version: null, versionSource: 'marker', endpoints: [...BASE, ...TOOLS] })
    expect(gate(c, 'portfolioTools')).toEqual({
      on: true,
      reason: 'swagger.json lists portfolio/backtest and sip/backtest',
    })
  })

  test('2.0.1.7 with both listed → portfolioTools on', () => {
    expect(
      gate(caps({ version: '2.0.1.7', endpoints: [...BASE, ...TOOLS] }), 'portfolioTools').on,
    ).toBe(true)
  })

  test('no version, the live feed acked subscribe_orders → orderStream on', () => {
    const c = caps({
      version: null,
      versionSource: 'marker',
      ws: { orderStream: true, ping: null, close1012: false, authDeadline: false },
    })
    expect(gate(c, 'orderStream')).toEqual({
      on: true,
      reason: 'the live feed acknowledged subscribe_orders',
    })
  })

  test('2.0.3.5 whose live feed refused subscribe_orders → orderStream off', () => {
    const c = caps({ ws: { orderStream: false, ping: null, close1012: true, authDeadline: true } })
    expect(gate(c, 'orderStream')).toEqual({
      on: false,
      reason: 'the live feed refused subscribe_orders',
    })
  })

  test('swagger missing one of the pair → off, naming it, with the version it needs', () => {
    const c = caps({ version: '2.0.1.6', endpoints: [...BASE, 'portfolio/backtest'] })
    expect(gate(c, 'portfolioTools')).toEqual({
      on: false,
      reason: 'swagger.json does not list sip/backtest',
      needs: '2.0.1.8',
    })
  })

  test('2.0.3.5 whose swagger lacks sectorrotation → off, with no needs', () => {
    expect(gate(caps({ endpoints: [...BASE, ...TOOLS] }), 'sectorRotation')).toEqual({
      on: false,
      reason: 'swagger.json does not list sectorrotation',
    })
  })

  test('without swagger, probes are the evidence', () => {
    const c = caps({
      version: null,
      versionSource: 'marker',
      endpoints: null,
      probed: { 'portfolio/backtest': true, 'sip/backtest': true, sectorrotation: false },
    })
    expect(gate(c, 'portfolioTools')).toEqual({
      on: true,
      reason: 'probes found portfolio/backtest and sip/backtest',
    })
    expect(gate(c, 'sectorRotation')).toEqual({
      on: false,
      reason: 'probes did not find sectorrotation',
      needs: '2.0.3.0',
    })
  })

  test('swagger wins over probes', () => {
    const c = caps({
      endpoints: BASE,
      probed: { 'portfolio/backtest': true, 'sip/backtest': true },
    })
    expect(gate(c, 'portfolioTools').on).toBe(false)
  })

  test('incomplete probe evidence falls back to the version', () => {
    const c = caps({ version: '2.0.1.6', endpoints: null, probed: { 'portfolio/backtest': true } })
    expect(gate(c, 'portfolioTools')).toEqual({
      on: false,
      reason: 'needs 2.0.1.8; the server is 2.0.1.6',
      needs: '2.0.1.8',
    })
  })
})

describe('a refused field comes first', () => {
  test('optionchain.with_greeks false turns optionchainGreeks off on 2.0.3.5', () => {
    expect(
      gate(caps({ fields: { 'optionchain.with_greeks': false } }), 'optionchainGreeks'),
    ).toEqual({ on: false, reason: 'the server refused optionchain.with_greeks' })
  })

  test('below the gate, the refusal also says which version it needs', () => {
    const c = caps({ version: '2.0.1.9', fields: { 'optionchain.with_greeks': false } })
    expect(gate(c, 'optionchainGreeks')).toMatchObject({ on: false, needs: '2.0.2.0' })
  })

  test('history.source false turns historySource off', () => {
    expect(gate(caps({ fields: { 'history.source': false } }), 'historySource')).toEqual({
      on: false,
      reason: 'the server refused history.source',
    })
  })

  test('a field that is true or unrelated changes nothing', () => {
    const c = caps({
      version: '2.0.1.6',
      fields: { 'optionchain.with_greeks': true, 'x.y': false },
    })
    expect(gate(c, 'optionchainGreeks').on).toBe(false)
    expect(gate(c, 'historySource').on).toBe(true)
  })
})

describe('hasEndpoint', () => {
  test('reads swagger when it was served', () => {
    const c = caps({ endpoints: BASE, probed: { sectorrotation: true } })
    expect(hasEndpoint(c, 'ping')).toBe(true)
    expect(hasEndpoint(c, 'sectorrotation')).toBe(false)
  })

  test('otherwise reads the probes, and null means unknown', () => {
    const c = caps({ endpoints: null, probed: { 'sip/backtest': false, multioptiongreeks: true } })
    expect(hasEndpoint(c, 'multioptiongreeks')).toBe(true)
    expect(hasEndpoint(c, 'sip/backtest')).toBe(false)
    expect(hasEndpoint(c, 'sectorrotation')).toBeNull()
  })
})
