import { Alert, type AlertButton } from 'react-native'
import { ApiError } from '~/core/http/errors'
import type { AnalyzerMode } from './analyzerGate'
import { confirmInMode } from './confirmWrite'
import { READ_DEADLINE_MS } from './submit'

const COPY = {
  title: 'Cancel this order?',
  body: 'BUY LIMIT 1 ITC @ 100.00 · CNC',
  ok: 'Cancel order',
}

let answer = true
const alert = () => jest.mocked(Alert.alert)

beforeEach(() => {
  answer = true
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons?: AlertButton[]) => {
    buttons?.find((b) => (answer ? b.style !== 'cancel' : b.style === 'cancel'))?.onPress?.()
  })
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

const gate = (read: () => Promise<AnalyzerMode>) => ({ read: jest.fn(read) })

test('the mode read now heads the confirm; yes is that mode', async () => {
  const g = gate(async () => 'live')
  await expect(confirmInMode(g, { ...COPY, destructive: true })).resolves.toEqual({
    kind: 'confirmed',
    mode: 'live',
  })
  expect(g.read).toHaveBeenCalledTimes(1)
  const [title, body, buttons] = alert().mock.calls[0] ?? []
  expect(title).toBe('LIVE · Cancel this order?')
  expect(body).toBe(COPY.body)
  expect(buttons?.[1]).toMatchObject({ text: 'Cancel order', style: 'destructive' })
})

test('ANALYZE in analyzer mode; no is declined', async () => {
  answer = false
  await expect(
    confirmInMode(
      gate(async () => 'analyze'),
      COPY,
    ),
  ).resolves.toEqual({
    kind: 'declined',
  })
  expect(alert().mock.calls[0]?.[0]).toBe('ANALYZE · Cancel this order?')
})

test('a read that fails asks nothing', async () => {
  const e = new ApiError({ kind: 'Network', status: 0, endpoint: 'analyzer' })
  await expect(
    confirmInMode(
      gate(async () => {
        throw e
      }),
      COPY,
    ),
  ).resolves.toEqual({ kind: 'error', error: e })
  expect(Alert.alert).not.toHaveBeenCalled()
})

test('a read still out after the deadline asks nothing (ruling 6)', async () => {
  jest.useFakeTimers()
  const g = {
    read: jest.fn(
      ({ signal }: { signal?: AbortSignal } = {}) =>
        new Promise<AnalyzerMode>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new ApiError({ kind: 'Network', status: 0, endpoint: 'analyzer' })),
          )
        }),
    ),
  }
  const out = confirmInMode(g, COPY)
  await jest.advanceTimersByTimeAsync(READ_DEADLINE_MS)
  await expect(out).resolves.toMatchObject({ kind: 'error' })
  expect(Alert.alert).not.toHaveBeenCalled()
})
