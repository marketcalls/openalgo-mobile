import { CHART_TOPICS, isNativeToDomBatch } from './protocol'
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
