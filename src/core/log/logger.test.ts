import { clearLogs, getLogLines, log, redact } from './logger'

const KEY = 'a'.repeat(64)

beforeEach(() => {
  clearLogs()
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})
afterEach(() => jest.restoreAllMocks())

describe('redact', () => {
  test('masks apikey-like keys at any depth', () => {
    expect(redact({ apikey: KEY, nested: { api_key: 'x', Password: 'y', ok: 1 } })).toEqual({
      apikey: '[redacted]',
      nested: { api_key: '[redacted]', Password: '[redacted]', ok: 1 },
    })
    expect(redact([{ auth_token: 't' }])).toEqual([{ auth_token: '[redacted]' }])
  })

  test('masks apikey= query values in strings', () => {
    expect(redact('x?apikey=K')).toBe('x?apikey=[redacted]')
    expect(redact('x?apikey=K&b=1')).toBe('x?apikey=[redacted]&b=1')
  })

  test('masks a bare 64-hex string but not shorter hex', () => {
    expect(redact(`key ${KEY} end`)).toBe('key [redacted-key] end')
    expect(redact('a'.repeat(63))).toBe('a'.repeat(63))
  })

  test('handles errors, cycles and primitives', () => {
    expect(redact(new Error(`bad ${KEY}`))).toEqual({
      name: 'Error',
      message: 'bad [redacted-key]',
    })
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => redact(a)).not.toThrow()
    expect(redact(5)).toBe(5)
    expect(redact(null)).toBeNull()
  })
})

describe('logger', () => {
  test('lines carry level, tag and redacted data', () => {
    log.info('http', 'sent', { apikey: KEY, n: 1 })
    const [line] = getLogLines()
    expect(line).toContain('INFO [http] sent')
    expect(line).toContain('"n":1')
    expect(line).not.toContain(KEY)
  })

  test('the message is redacted too', () => {
    log.warn('t', `GET /x?apikey=${KEY}`)
    expect(getLogLines()[0]).not.toContain(KEY)
  })

  test('keeps the last 500 lines and honours the limit', () => {
    for (let i = 0; i < 520; i++) log.debug('t', `m${i}`)
    const all = getLogLines()
    expect(all).toHaveLength(500)
    expect(all[0]).toContain('m20')
    expect(all[499]).toContain('m519')
    expect(getLogLines(2)).toHaveLength(2)
  })

  test('clearLogs empties the buffer', () => {
    log.error('t', 'x')
    clearLogs()
    expect(getLogLines()).toEqual([])
  })

  test('mirrors to the console in __DEV__ only', () => {
    log.info('t', 'dev')
    expect(console.info).toHaveBeenCalledTimes(1)
    const g = globalThis as { __DEV__?: boolean }
    const prev = g.__DEV__
    g.__DEV__ = false
    log.info('t', 'prod')
    g.__DEV__ = prev
    expect(console.info).toHaveBeenCalledTimes(1)
  })
})
