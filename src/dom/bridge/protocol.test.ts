import { type BrokerCaps, brokerCaps } from '~/market/brokers/seed'
import { TOOLS } from '~/market/tools/registry'
import { type BrokerCapsJson, CHART_TOPICS, isNativeToDomBatch, TOOL_PAGE_IDS } from './protocol'
import { NativeToDomBatchSchema } from './schemas'

const good = [
  { kind: 'socket', sid: 1, event: 'open' },
  { kind: 'socket', sid: 2, event: 'message', data: '{}' },
  { kind: 'push', topic: CHART_TOPICS.redraw, payload: { a: [1] } },
]
const bad = [
  {},
  [{ kind: 'eval', code: 'x' }],
  [{ kind: 'socket', sid: 1, event: 'message' }],
  [{ kind: 'socket', sid: 1000, event: 'open' }],
  [{ kind: 'socket', sid: 1, event: 'open', extra: 1 }],
  [{ kind: 'push', topic: 1, payload: null }],
  [{ kind: 'push', topic: 't' }],
  [{ kind: 'push', topic: 't', payload: 1, extra: 1 }],
  [null],
  [{ kind: 'socket', sid: 1.5, event: 'open' }],
]

test('the guard accepts a native batch, empty included', () => {
  expect(isNativeToDomBatch(good)).toBe(true)
  expect(isNativeToDomBatch([])).toBe(true)
})

test('the guard refuses what the schema refuses', () => {
  for (const b of bad) {
    expect(isNativeToDomBatch(b)).toBe(false)
    expect(NativeToDomBatchSchema.safeParse(b).success).toBe(false)
  }
})

test('every tool page is a tool of the pinned frontend, once', () => {
  const tools = new Set(TOOLS.map((t) => t.id))
  for (const page of TOOL_PAGE_IDS) expect(tools.has(page)).toBe(true)
  expect(new Set(TOOL_PAGE_IDS).size).toBe(TOOL_PAGE_IDS.length)
})

test("the seed's broker capabilities are the protocol's BrokerCapsJson, both ways", () => {
  // protocol.ts imports nothing from market, so the two declarations are held together here
  const caps: BrokerCapsJson = brokerCaps('zerodha', '2.0.3.5')
  const back: BrokerCaps = caps
  expect(Object.keys(back).sort()).toEqual([
    'broker_name',
    'broker_type',
    'leverage_config',
    'supported_exchanges',
  ])
})
