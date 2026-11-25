import type { QueryClient } from '@tanstack/react-query'
import type { Api } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import type { Analyzer } from '~/core/http/schemas'
import { qk } from '~/core/query/keys'
import { createQueryClient } from '~/core/query/queryClient'
import analyzeFixture from '../../../test/fixtures/openalgo-docs/analyzer-analyze.json'
import liveFixture from '../../../test/fixtures/openalgo-docs/analyzer-live.json'
import { createAnalyzerGate } from './analyzerGate'

const T0 = Date.UTC(2026, 10, 25, 4, 0)
const PID = 'p1'

/** An Api whose analyzer reads answer from `replies` in turn (the last one repeats). */
function fakeApi(...replies: (object | ApiError | 'hang')[]) {
  const calls: Record<string, unknown>[] = []
  let hang: ((v: unknown) => void) | undefined
  const api: Api = {
    async call(id, body, schema) {
      if (id !== 'analyzer') throw new Error(`unexpected ${id}`)
      calls.push(body)
      const r = replies[Math.min(calls.length, replies.length) - 1]
      if (r instanceof ApiError) throw r
      if (r === 'hang') {
        return schema.parse(await new Promise((res) => (hang = res)))
      }
      return schema.parse(r)
    },
  }
  return { api, calls, release: (v: object) => hang?.(v) }
}

let qc: QueryClient
beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  // the app's own client: its reads retry Network and Server, which the gate must not
  qc = createQueryClient()
})
afterEach(() => {
  qc.clear()
  jest.useRealTimers()
})

describe('createAnalyzerGate', () => {
  test('two reads within 5 s make one call; a read at 5,001 ms makes a second', async () => {
    const { api, calls } = fakeApi(liveFixture, analyzeFixture)
    const gate = createAnalyzerGate({ queryClient: qc, pid: PID, api })
    expect(await gate.read()).toBe('live')
    jest.setSystemTime(T0 + 4_999)
    expect(await gate.read()).toBe('live')
    expect(calls).toHaveLength(1)
    jest.setSystemTime(T0 + 5_001)
    expect(await gate.read()).toBe('analyze')
    expect(calls).toHaveLength(2)
  })

  test("after noteReply({mode:'analyze'}) a read gives analyze with no call", async () => {
    const { api, calls } = fakeApi(liveFixture)
    const gate = createAnalyzerGate({ queryClient: qc, pid: PID, api })
    expect(await gate.read()).toBe('live')
    jest.setSystemTime(T0 + 4_000)
    gate.noteReply({ status: 'success', orderid: '1', mode: 'analyze' })
    // the reply restarts the 5 s
    jest.setSystemTime(T0 + 8_000)
    expect(await gate.read()).toBe('analyze')
    expect(calls).toHaveLength(1)
    jest.setSystemTime(T0 + 9_001)
    expect(await gate.read()).toBe('live')
    expect(calls).toHaveLength(2)
  })

  test('noteReply writes the query the header badge reads, keeping the rest of it', async () => {
    const { api } = fakeApi(liveFixture)
    const gate = createAnalyzerGate({ queryClient: qc, pid: PID, api })
    await gate.read()
    gate.noteReply({ mode: 'analyze' })
    expect(qc.getQueryData<Analyzer>(qk.analyzer(PID))).toEqual({
      mode: 'analyze',
      analyze_mode: true,
      total_logs: 0,
    })
  })

  test('a reply without mode analyze changes nothing (no reply proves LIVE)', async () => {
    const { api } = fakeApi(analyzeFixture)
    const gate = createAnalyzerGate({ queryClient: qc, pid: PID, api })
    for (const reply of [
      { status: 'success', orderid: '1' },
      { status: 'success', mode: 'semi_auto', pending_order_id: 12 },
      { mode: 'live' },
      null,
      'analyze',
    ]) {
      gate.noteReply(reply)
    }
    expect(gate.peek()).toBeNull()
    await gate.read()
    gate.noteReply({ status: 'success', orderid: '1' })
    expect(gate.peek()).toBe('analyze')
  })

  test('peek gives the last reading, however old, and never calls', async () => {
    const { api, calls } = fakeApi(analyzeFixture)
    const gate = createAnalyzerGate({ queryClient: qc, pid: PID, api })
    expect(gate.peek()).toBeNull()
    await gate.read()
    jest.setSystemTime(T0 + 600_000)
    expect(gate.peek()).toBe('analyze')
    expect(calls).toHaveLength(1)
  })

  test('a failed read rejects with its error, once: the gate never retries', async () => {
    const network = new ApiError({ kind: 'Network', status: 0, endpoint: 'analyzer' })
    const { api, calls } = fakeApi(network, liveFixture)
    const gate = createAnalyzerGate({ queryClient: qc, pid: PID, api })
    await expect(gate.read()).rejects.toBe(network)
    expect(calls).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(1)
    expect(await gate.read()).toBe('live')
  })

  test('ttlMs 0 reads the server every time', async () => {
    const { api, calls } = fakeApi(liveFixture, analyzeFixture)
    const gate = createAnalyzerGate({ queryClient: qc, pid: PID, api, ttlMs: 0 })
    expect(await gate.read()).toBe('live')
    expect(await gate.read()).toBe('analyze')
    expect(calls).toHaveLength(2)
  })

  test('an aborted read rejects with Network at once; the request still fills the cache', async () => {
    const { api, calls, release } = fakeApi('hang')
    const gate = createAnalyzerGate({ queryClient: qc, pid: PID, api })
    const ctrl = new AbortController()
    const read = gate.read({ signal: ctrl.signal })
    ctrl.abort()
    await expect(read).rejects.toMatchObject({ kind: 'Network', status: 0, endpoint: 'analyzer' })
    release(analyzeFixture)
    await jest.advanceTimersByTimeAsync(0)
    expect(gate.peek()).toBe('analyze')
    expect(calls).toHaveLength(1)
    // a signal already aborted sends nothing
    jest.setSystemTime(T0 + 10_000)
    const done = new AbortController()
    done.abort()
    await expect(gate.read({ signal: done.signal })).rejects.toMatchObject({ kind: 'Network' })
    expect(calls).toHaveLength(1)
  })

  test("reads are the profile's own", async () => {
    const { api } = fakeApi(analyzeFixture)
    await createAnalyzerGate({ queryClient: qc, pid: PID, api }).read()
    expect(createAnalyzerGate({ queryClient: qc, pid: 'p2', api }).peek()).toBeNull()
  })
})
