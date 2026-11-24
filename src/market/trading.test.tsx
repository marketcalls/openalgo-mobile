import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react-native'
import { Text } from 'react-native'
import { profileStorage } from '~/core/config/storage'
import type { Api } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import { type Services, ServicesProvider } from '~/core/services/services'
import { memoryKV } from '../../test/helpers/memoryKV'
import { SymbolSchema } from './instruments/meta'
import { useInstrument } from './instruments/useInstrument'
import { createTrading, TradingProvider, useTrading } from './trading'

const NOW = Date.UTC(2026, 10, 24, 5, 0)

function fakeServices() {
  const calls: unknown[] = []
  const api: Api = {
    async call(_id, body) {
      calls.push(body)
      if (body.symbol === 'GONE') {
        throw new ApiError({
          kind: 'Unsupported',
          status: 404,
          endpoint: 'symbol',
          serverMessage: 'Symbol GONE not found in exchange NFO',
        })
      }
      return SymbolSchema.parse({
        status: 'success',
        data: { symbol: body.symbol, exchange: body.exchange, lotsize: 75, tick_size: 0.05 },
      }) as never
    },
  }
  const s = {
    api,
    storage: profileStorage(memoryKV(), 'p1'),
    profile: { get: () => ({ id: 'p1' }) },
  } as unknown as Services
  return { s, calls }
}

const Probe = ({ ex, sym }: { ex: string; sym: string }) => {
  const { meta, unknown, loading } = useInstrument(ex, sym)
  return (
    <Text testID="v">{loading ? 'loading' : unknown ? 'unknown' : `lot ${meta?.lotsize}`}</Text>
  )
}

const mount = async (ui: React.ReactElement, s: Services) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  })
  return await render(
    <ServicesProvider value={s}>
      <QueryClientProvider client={qc}>
        <TradingProvider now={() => NOW}>{ui}</TradingProvider>
      </QueryClientProvider>
    </ServicesProvider>,
  )
}

const Bad = () => {
  useTrading()
  return null
}

describe('Trading', () => {
  test('createTrading holds the instrument cache', () => {
    const { s } = fakeServices()
    const t = createTrading(s, { now: () => NOW })
    expect(typeof t.instruments.get).toBe('function')
  })

  test('useTrading outside the provider throws', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await expect(render(<Bad />)).rejects.toThrow('TradingProvider is missing')
    spy.mockRestore()
  })

  test('useInstrument loads a known contract', async () => {
    const { s, calls } = fakeServices()
    await mount(<Probe ex="NFO" sym="NIFTY30DEC25FUT" />, s)
    await waitFor(() => expect(screen.getByTestId('v').props.children).toBe('lot 75'))
    expect(calls).toHaveLength(1)
  })

  test('useInstrument reports an expired contract as unknown', async () => {
    const { s } = fakeServices()
    await mount(<Probe ex="NFO" sym="GONE" />, s)
    await waitFor(() => expect(screen.getByTestId('v').props.children).toBe('unknown'))
  })
})
