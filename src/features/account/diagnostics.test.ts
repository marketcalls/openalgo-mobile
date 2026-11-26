import type { Capabilities } from '~/core/capabilities/gates'
import { buildDiagnostics, capabilityReport, serializeDiagnostics } from './diagnostics'

const KEY = 'ab'.repeat(32)

const caps = (version: string): Capabilities => ({
  host: 'https://algo.example.com',
  version,
  versionSource: 'app-info',
  endpoints: null,
  probed: {},
  fields: {},
  features: {},
  ws: { orderStream: null, ping: null, close1012: false, authDeadline: false },
  probedAt: 0,
})

describe('capabilityReport', () => {
  test('on 2.0.1.6 the order stream is on and option-chain Greeks need 2.0.2.0', () => {
    const rows = capabilityReport(caps('2.0.1.6'))
    const row = (f: string) => rows.find((r) => r.feature === f)
    expect(row('orderStream')?.on).toBe(true)
    expect(row('optionchainGreeks')).toMatchObject({ on: false })
    expect(row('optionchainGreeks')?.reason).toContain('needs 2.0.2.0')
  })
})

describe('GTT support', () => {
  test('the report carries its state and reason', () => {
    const r = buildDiagnostics({
      ...base(),
      gtt: {
        state: 'no',
        reason: 'GTT in the analyzer needs OpenAlgo 2.0.1.9',
        needs: '2.0.1.9',
        detect: false,
      },
    })
    expect(r.gtt).toEqual({ state: 'no', reason: 'GTT in the analyzer needs OpenAlgo 2.0.1.9' })
    expect(JSON.parse(serializeDiagnostics(r)).gtt).toEqual(r.gtt)
  })

  test('without it, the report says so', () => {
    expect(buildDiagnostics(base()).gtt).toBeNull()
  })
})

describe('serializeDiagnostics', () => {
  test('holds no 64-hex string and no apikey value, even when a log line or a field has one', () => {
    const report = buildDiagnostics({
      appVersion: '0.1.0',
      server: {
        origin: 'https://algo.example.com',
        version: '2.0.1.6',
        broker: 'zerodha',
        feedMode: 'live',
        wsUrl: `wss://algo.example.com/ws?apikey=${KEY}`,
      },
      caps: caps('2.0.1.6'),
      feed: { state: 'live', lastCloseCode: null, failures: 0, everLive: true, broker: 'zerodha' },
      scheduler: {
        queued: { read: 0, history: 0, order: 0, smart: 0, control: 0 },
        inFlight: 0,
        started: 3,
        deduped: 1,
        rateLimited: 0,
        gated: [],
        paused: false,
        halted: false,
      },
      store: { ticksIn: 1, flushes: 1, keysPublished: 1, keys: 1 },
      logs: [`INFO [x] sent {"apikey":"${KEY}"} and ${KEY}`],
    })
    const text = serializeDiagnostics(report)
    expect(text).not.toMatch(/[0-9a-f]{64}/i)
    expect(text).not.toContain('apikey":"')
    expect(JSON.parse(text).appVersion).toBe('0.1.0')
  })

  test('keeps the last 200 log lines', () => {
    const logs = Array.from({ length: 250 }, (_, i) => `line ${i}`)
    const r = buildDiagnostics({ ...base(), logs })
    expect(r.logs).toHaveLength(200)
    expect(r.logs[199]).toBe('line 249')
  })
})

function base() {
  return {
    appVersion: '0.1.0',
    server: { origin: 'o', version: null, broker: null, feedMode: 'polling' as const, wsUrl: null },
    caps: null,
    feed: {
      state: 'idle' as const,
      lastCloseCode: null,
      failures: 0,
      everLive: false,
      broker: null,
    },
    scheduler: {
      queued: { read: 0, history: 0, order: 0, smart: 0, control: 0 },
      inFlight: 0,
      started: 0,
      deduped: 0,
      rateLimited: 0,
      gated: [],
      paused: false,
      halted: false,
    },
    store: { ticksIn: 0, flushes: 0, keysPublished: 0, keys: 0 },
    logs: [],
  }
}
