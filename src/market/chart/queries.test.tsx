import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import { createQueryClient } from '~/core/query/queryClient'
import { type Services, ServicesProvider } from '~/core/services/services'
import { DEFAULT_TIMINGS, IST_OFFSET_MS } from './calendar'
import { useChartIntervals, useSessionCalendars } from './queries'

const T0 = Date.UTC(2026, 10, 27, 5, 0)
const midnight = Date.UTC(2026, 10, 27) - IST_OFFSET_MS

const Probe = () => {
  const cal = useSessionCalendars()
  const iv = useChartIntervals(true)
  return <Text testID="out">{`${cal?.source ?? '-'}|${iv?.join(',') ?? '-'}`}</Text>
}
function setup(
  timingsReply: () => unknown = () =>
    DEFAULT_TIMINGS.map((r) => ({
      exchange: r.exchange,
      start_time: midnight + r.start_offset,
      end_time: midnight + r.end_offset,
    })),
) {
  const calls: string[] = []
  const call = async (id: string, _b: unknown, schema: { parse(v: unknown): unknown }) => {
    calls.push(id)
    const data =
      id === 'intervals'
        ? { minutes: ['1m', '5m'], days: ['D'] }
        : id === 'market/timings'
          ? timingsReply()
          : []
    return schema.parse({ status: 'success', data })
  }
  const queryClient = createQueryClient()
  const services = {
    api: { call },
    profile: { get: () => ({ id: 'p1' }) },
    queryClient,
  } as unknown as Services
  const mount = async () => {
    await render(
      <ServicesProvider value={services}>
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>
      </ServicesProvider>,
    )
  }
  return { calls, mount }
}

const settle = () =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(0)
  })
const count = (calls: string[], id: string) => calls.filter((c) => c === id).length

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
})
afterEach(() => jest.useRealTimers())

test('a second chart the same IST day, 10 min later, reads the calendar and intervals from the cache', async () => {
  const { calls, mount } = setup()
  await mount()
  await settle()
  expect(screen.getByTestId('out').props.children).toBe('server|1m,5m,D')
  await act(async () => screen.unmount())
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10 * 60_000)
  })
  await mount()
  await settle()
  expect(screen.getByTestId('out').props.children).toBe('server|1m,5m,D')
  expect(count(calls, 'intervals')).toBe(1)
  expect(count(calls, 'market/timings')).toBe(1)
  expect(count(calls, 'market/holidays')).toBe(1)
})

test('a calendar that fell back to defaults is read again after 5 minutes', async () => {
  const { calls, mount } = setup(() => [])
  await mount()
  await settle()
  expect(screen.getByTestId('out').props.children).toBe('defaults|1m,5m,D')
  const before = count(calls, 'market/holidays')
  await act(async () => screen.unmount())
  await act(async () => {
    await jest.advanceTimersByTimeAsync(6 * 60_000)
  })
  await mount()
  await settle()
  expect(count(calls, 'market/holidays')).toBeGreaterThan(before)
  expect(count(calls, 'intervals')).toBe(1)
})
