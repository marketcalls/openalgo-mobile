import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react-native'
import { AppState, Text } from 'react-native'
import { profileStorage } from '~/core/config/storage'
import type { Api } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import { qk } from '~/core/query/keys'
import { useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import analyzeFixture from '../../test/fixtures/openalgo-docs/analyzer-analyze.json'
import orderbookFixture from '../../test/fixtures/openalgo-docs/orderbook.json'
import { memoryKV } from '../../test/helpers/memoryKV'
import { SymbolSchema } from './instruments/meta'
import { useInstrument } from './instruments/useInstrument'
import { createTrading, TradingProvider, type UnknownKeys, useTrading } from './trading'

const NOW = Date.UTC(2026, 10, 24, 5, 0)

function fakeServices() {
  const calls: unknown[] = []
  const api: Api = {
    async call(id, body, schema) {
      if (id === 'analyzer') return schema.parse(analyzeFixture)
      if (id === 'orderbook') return schema.parse(orderbookFixture)
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
    queryClient: new QueryClient({
      defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
    }),
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

let grabbed: UnknownKeys | undefined
const Grab = () => {
  grabbed = useTrading().unknown
  return null
}

describe('Trading', () => {
  test('createTrading holds the instrument cache', () => {
    const { s } = fakeServices()
    const t = createTrading(s, { now: () => NOW })
    expect(typeof t.instruments.get).toBe('function')
  })

  test('createTrading holds the order api and the analyzer gate, on the services query cache', async () => {
    const { s } = fakeServices()
    const t = createTrading(s, { now: () => NOW })
    expect((await t.orders.orderbook()).orders).toHaveLength(2)
    expect(t.analyzer.peek()).toBeNull()
    expect(await t.analyzer.read()).toBe('analyze')
    // the query the header badge reads (useAnalyzer), so the two never disagree
    expect(s.queryClient.getQueryData(qk.analyzer('p1'))).toMatchObject({ mode: 'analyze' })
    s.queryClient.clear()
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

describe('Trading.unknown', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    useConnection.getState().reset()
    grabbed = undefined
  })

  test('clear forgets the keys and moves the epoch on; an empty set stays put', () => {
    const { s } = fakeServices()
    const u = createTrading(s, { now: () => NOW }).unknown
    u.getState().clear()
    expect(u.getState().epoch).toBe(0)
    u.getState().add(['NFO:GONE', 'NFO:GONE'])
    expect([...u.getState().keys]).toEqual(['NFO:GONE'])
    u.getState().clear()
    expect(u.getState().keys.size).toBe(0)
    expect(u.getState().epoch).toBe(1)
  })

  test('rollover clears only on a new IST day', () => {
    const { s } = fakeServices()
    let t = Date.UTC(2026, 10, 24, 18, 0) // 23:30 IST
    const u = createTrading(s, { now: () => t }).unknown
    u.getState().add(['NFO:GONE'])
    t = Date.UTC(2026, 10, 24, 18, 29) // 23:59 IST
    expect(u.getState().rollover()).toBe(false)
    expect(u.getState().keys.has('NFO:GONE')).toBe(true)
    t = Date.UTC(2026, 10, 24, 18, 31) // 00:01 IST, the next day
    expect(u.getState().rollover()).toBe(true)
    expect(u.getState().keys.size).toBe(0)
    expect(u.getState().epoch).toBe(1)
    expect(u.getState().rollover()).toBe(false)
  })

  test('the provider clears it when the broker session turns active', async () => {
    const { s } = fakeServices()
    await mount(<Grab />, s)
    await act(async () => grabbed?.getState().add(['NFO:GONE']))
    await act(async () => useConnection.getState().set({ brokerSession: 'logged_out' }))
    expect(grabbed?.getState().keys.size).toBe(1)
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    expect(grabbed?.getState().keys.size).toBe(0)
  })

  test('the provider rolls it over when the app comes to the foreground on a new IST day', async () => {
    let onChange: ((st: string) => void) | undefined
    const remove = jest.fn()
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _t: string,
      h: (st: string) => void,
    ) => {
      onChange = h
      return { remove }
    }) as never)
    const { s } = fakeServices()
    let t = NOW
    const now = () => t
    const qc = new QueryClient()
    const view = await render(
      <ServicesProvider value={s}>
        <QueryClientProvider client={qc}>
          <TradingProvider now={now}>
            <Grab />
          </TradingProvider>
        </QueryClientProvider>
      </ServicesProvider>,
    )
    await act(async () => grabbed?.getState().add(['NFO:GONE']))
    await act(async () => onChange?.('active'))
    expect(grabbed?.getState().keys.size).toBe(1)
    t = NOW + 86_400_000
    await act(async () => onChange?.('background'))
    expect(grabbed?.getState().keys.size).toBe(1)
    await act(async () => onChange?.('active'))
    expect(grabbed?.getState().keys.size).toBe(0)
    await view.unmount()
    expect(remove).toHaveBeenCalled()
  })
})

describe('Trading.depthDowngrades', () => {
  test('keeps each broker:exchange once, in a new set', () => {
    const { s } = fakeServices()
    const d = createTrading(s, { now: () => NOW }).depthDowngrades
    const before = d.getState().keys
    d.getState().add('dhan:NSE')
    d.getState().add('dhan:NSE')
    expect([...d.getState().keys]).toEqual(['dhan:NSE'])
    expect(before.size).toBe(0)
  })

  test('belongs to its container: a new one (sign-out, a server change) starts empty', () => {
    const { s } = fakeServices()
    const first = createTrading(s, { now: () => NOW })
    first.depthDowngrades.getState().add('dhan:NSE')
    const next = createTrading(fakeServices().s, { now: () => NOW })
    expect(next.depthDowngrades.getState().keys.size).toBe(0)
    expect(first.depthDowngrades.getState().keys.has('dhan:NSE')).toBe(true)
  })
})
