import { AUTH_OK, fakeSockets, PONG, wsError } from '../../../test/helpers/fakeSocket'
import { testLiveFeed } from './handshake'
import { authMsg } from './protocol'

const KEY = 'ab'.repeat(32)
const URL = 'ws://192.168.1.5:8765'

beforeEach(() => {
  jest.useFakeTimers({ now: 0 })
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('testLiveFeed', () => {
  test('B1 a success authenticates, pings and reports the broker', async () => {
    const f = fakeSockets()
    const result = testLiveFeed(URL, KEY, { WebSocketImpl: f.WebSocketImpl })
    const s = f.last()
    expect(s.url).toBe(URL)
    s.serverOpen()
    expect(s.sent).toEqual([authMsg(KEY)])
    s.serverSend(AUTH_OK)
    expect(s.actions()).toEqual(['authenticate', 'ping'])
    s.serverSend(PONG)
    await expect(result).resolves.toEqual({ ok: true, broker: 'zerodha', ping: true })
    expect(s.closeCode).toBe(1000)
    expect(f.sockets).toHaveLength(1)
  })

  test('B1 three timeouts give timeout after exactly 3 sockets, 1 s then 2 s apart', async () => {
    const f = fakeSockets()
    let result: unknown
    testLiveFeed(URL, KEY, { WebSocketImpl: f.WebSocketImpl }).then((r) => {
      result = r
    })
    f.last().serverOpen()
    await jest.advanceTimersByTimeAsync(14_999)
    expect(f.last().closeCode).toBeUndefined()
    await jest.advanceTimersByTimeAsync(1)
    expect(f.last().closeCode).toBe(1000)

    await jest.advanceTimersByTimeAsync(999)
    expect(f.sockets).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(f.sockets).toHaveLength(2)

    await jest.advanceTimersByTimeAsync(15_000 + 1_999)
    expect(f.sockets).toHaveLength(2)
    await jest.advanceTimersByTimeAsync(1)
    expect(f.sockets).toHaveLength(3)

    await jest.advanceTimersByTimeAsync(15_000)
    expect(result).toEqual({ ok: false, reason: 'timeout' })
    await jest.advanceTimersByTimeAsync(60_000)
    expect(f.sockets).toHaveLength(3)
  })

  test('B1 AUTHENTICATION_ERROR stops after 1 socket', async () => {
    const f = fakeSockets()
    const result = testLiveFeed(URL, KEY, { WebSocketImpl: f.WebSocketImpl })
    f.last().serverOpen()
    f.last().serverSend(wsError('AUTHENTICATION_ERROR', 'Invalid API key'))
    await expect(result).resolves.toEqual({ ok: false, reason: 'auth_error' })
    await jest.advanceTimersByTimeAsync(60_000)
    expect(f.sockets).toHaveLength(1)
  })

  test('B1 a BROKER_* error stops at once with broker_error', async () => {
    const f = fakeSockets()
    const result = testLiveFeed(URL, KEY, { WebSocketImpl: f.WebSocketImpl })
    f.last().serverOpen()
    f.last().serverSend(wsError('BROKER_ERROR', 'No broker configuration found for user'))
    await expect(result).resolves.toEqual({ ok: false, reason: 'broker_error' })
    expect(f.last().closeCode).toBe(1000)
    await jest.advanceTimersByTimeAsync(60_000)
    expect(f.sockets).toHaveLength(1)
  })

  test('B1 a refused upgrade is closed with its code, and is retried', async () => {
    const f = fakeSockets()
    const result = testLiveFeed(URL, KEY, { WebSocketImpl: f.WebSocketImpl, attempts: 2 })
    f.last().serverClose(1006)
    await jest.advanceTimersByTimeAsync(1_000)
    expect(f.sockets).toHaveLength(2)
    f.last().serverClose(4401, 'auth timeout')
    await expect(result).resolves.toEqual({ ok: false, reason: 'closed', closeCode: 4401 })
  })

  test('B1 a ping refused with INVALID_ACTION still succeeds, with ping false', async () => {
    const f = fakeSockets()
    const result = testLiveFeed(URL, KEY, { WebSocketImpl: f.WebSocketImpl })
    f.last().serverOpen()
    f.last().serverSend({ ...AUTH_OK, broker: 'angel' })
    f.last().serverSend(wsError('INVALID_ACTION', 'Invalid action: ping'))
    await expect(result).resolves.toEqual({ ok: true, broker: 'angel', ping: false })
  })
})
