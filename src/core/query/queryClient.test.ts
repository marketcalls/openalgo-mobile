import { createHttpClient } from '~/core/http/client'
import { ApiError, type ApiErrorKind } from '~/core/http/errors'
import { FundsSchema } from '~/core/http/schemas'
import { scriptedFetch } from '../../../test/helpers/fakeFetch'
import { createQueryClient } from './queryClient'

const err = (kind: ApiErrorKind, status = 500) => new ApiError({ kind, status, endpoint: 'funds' })

describe('createQueryClient', () => {
  const qc = createQueryClient()
  const opts = qc.getDefaultOptions()
  const retry = opts.queries?.retry as (n: number, e: unknown) => boolean

  it('sets the query defaults', () => {
    expect(opts.queries?.staleTime).toBe(5_000)
    expect(opts.queries?.gcTime).toBe(300_000)
    expect(opts.queries?.refetchOnWindowFocus).toBe(true)
  })

  it('retries Network and Server errors at most twice', () => {
    expect(retry(0, err('Network', 0))).toBe(true)
    expect(retry(1, err('Server'))).toBe(true)
    expect(retry(2, err('Server'))).toBe(false)
  })

  it.each([
    'KeyInvalid',
    'BrokerLoggedOut',
    'IpBanned',
    'Unsupported',
    'SemiAutoBlocked',
    'Validation',
    'MaybePlaced',
    'RateLimited',
  ] as ApiErrorKind[])('never retries %s', (kind) => {
    expect(retry(0, err(kind, 400))).toBe(false)
  })

  it.each([401, 403, 404])('never retries a Server-classified %i page', (status) => {
    expect(retry(0, err('Server', status))).toBe(false)
  })

  it('never retries a 403 read whose key check failed at the network (GC: never 401/403/404)', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const http = createHttpClient({
      origin: 'https://algo.example.com',
      getKey: () => 'ab'.repeat(32),
      fetch: scriptedFetch({
        'POST /api/v1/funds': {
          status: 403,
          body: { status: 'error', message: 'Invalid openalgo apikey' },
        },
      }),
      resolveAuth403: async () => {
        throw new ApiError({ kind: 'Network', status: 0, endpoint: 'search' })
      },
    })
    const e = await http.request('funds', {}, FundsSchema).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(retry(0, e)).toBe(false)
    jest.restoreAllMocks()
  })

  it('never retries a non-ApiError', () => {
    expect(retry(0, new Error('boom'))).toBe(false)
  })

  it('does not retry mutations', () => {
    expect(opts.mutations?.retry).toBe(0)
  })
})
