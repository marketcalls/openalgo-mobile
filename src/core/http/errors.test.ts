import { ApiError, type ApiErrorKind, invalidSymbols, unknownFields, userMessage } from './errors'

describe('unknownFields reads the four S7 shapes', () => {
  test.each([
    [
      'placeorder/analyzer: a repr string',
      { status: 'error', message: "{'source': ['Unknown field.']}" },
      ['source'],
    ],
    [
      'history/funds/…: a dict message',
      { status: 'error', message: { source: ['Unknown field.'] } },
      ['source'],
    ],
    [
      'optionchain: "Validation error" with errors',
      { status: 'error', message: 'Validation error', errors: { with_greeks: ['Unknown field.'] } },
      ['with_greeks'],
    ],
    [
      'multioptiongreeks: "Validation failed" with errors',
      { status: 'error', message: 'Validation failed', errors: { extra: ['Unknown field.'] } },
      ['extra'],
    ],
  ])('%s', (_name, body, fields) => expect(unknownFields(body)).toEqual(fields))

  test('several fields, mixed with other errors, in the repr and dict forms', () => {
    const repr =
      "{'apikey': ['Missing data for required field.'], 'source': ['Unknown field.'], " +
      "'with_greeks': ['Unknown field.']}"
    expect(unknownFields({ status: 'error', message: repr })).toEqual(['source', 'with_greeks'])
    const dict = { apikey: ['Missing data for required field.'], a: ['Unknown field.'] }
    expect(unknownFields({ status: 'error', message: dict })).toEqual(['a'])
  })

  test('errors wins whenever it is present, whatever message says', () => {
    const body = {
      status: 'error',
      message: { source: ['Unknown field.'] },
      errors: { with_greeks: ['Unknown field.'] },
    }
    expect(unknownFields(body)).toEqual(['with_greeks'])
    expect(
      unknownFields({ status: 'error', message: "{'a': ['Unknown field.']}", errors: {} }),
    ).toBeUndefined()
  })

  test.each([
    [{ status: 'error', message: 'Query parameter is required and cannot be empty' }],
    [{ status: 'error', message: { symbol: ['Missing data for required field.'] } }],
    [{ status: 'error', message: 'Validation error', errors: { x: ['Not a valid boolean.'] } }],
    ['Unknown field.'],
    [null],
    [undefined],
  ])('no unknown field in %p → undefined', (body) => expect(unknownFields(body)).toBeUndefined())
})

describe('invalidSymbols reads a multiquotes 400 with no valid symbol', () => {
  // services/quotes_service.py:237-253
  const error = 'Symbol NIFTY25NOV25FUT not found in exchange NFO'

  test('each entry as {exchange, symbol}, without its error text', () => {
    const body = {
      status: 'error',
      message: error,
      invalid_symbols: [
        { symbol: 'NIFTY25NOV25FUT', exchange: 'NFO', error },
        { symbol: 'TYPO', exchange: 'NSE', error: 'Symbol TYPO not found in exchange NSE' },
      ],
    }
    expect(invalidSymbols(body)).toEqual([
      { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
      { exchange: 'NSE', symbol: 'TYPO' },
    ])
  })

  test('an entry without a string symbol and exchange is skipped', () => {
    const body = {
      status: 'error',
      message: 'Missing symbol or exchange in request',
      invalid_symbols: [
        { symbol: null, exchange: 'NSE' },
        'NSE:X',
        { symbol: 'A', exchange: 'NSE' },
      ],
    }
    expect(invalidSymbols(body)).toEqual([{ exchange: 'NSE', symbol: 'A' }])
  })

  test.each([
    [{ status: 'error', message: error }],
    [{ status: 'error', message: error, invalid_symbols: [] }],
    [{ status: 'error', message: error, invalid_symbols: 'NFO:NIFTY25NOV25FUT' }],
    [{ status: 'error', message: error, invalid_symbols: [{ symbol: null, exchange: null }] }],
    [null],
    ['invalid_symbols'],
  ])('none in %p → undefined', (body) => expect(invalidSymbols(body)).toBeUndefined())
})

describe('userMessage', () => {
  const err = (kind: ApiErrorKind, serverMessage?: string) =>
    new ApiError({ kind, status: 0, endpoint: 'funds', serverMessage })

  test.each<[ApiErrorKind, string | undefined, string]>([
    ['MaybePlaced', undefined, 'Status unknown: checking order book'],
    [
      'IpBanned',
      undefined,
      "This server has banned your IP address. Unban it in OpenAlgo's Security page from another network, then try again.",
    ],
    ['KeyInvalid', undefined, 'Your API key no longer works on this server. Enter it again.'],
    [
      'BrokerLoggedOut',
      undefined,
      'Your broker session has ended. Log in to your broker on the OpenAlgo web.',
    ],
    [
      'SemiAutoBlocked',
      'Cancel order operation is not allowed in Semi-Auto mode.',
      'Cancel order operation is not allowed in Semi-Auto mode.',
    ],
    [
      'Validation',
      'Another mode change is still in progress. Try again in a moment.',
      'Another mode change is still in progress. Try again in a moment.',
    ],
    ['Unsupported', 'ignored', "This server's version of OpenAlgo does not support this."],
    ['RateLimited', 'ignored', 'The server is busy. Wait a few seconds and try again.'],
    ['Server', 'ignored', 'The server ran into a problem. Try again in a moment.'],
    ['Network', undefined, "Can't reach the server. Check your connection and try again."],
    ['Validation', undefined, 'The server did not accept this request.'],
    [
      'SemiAutoBlocked',
      undefined,
      'This server uses Semi-Auto mode, so the web Action Center must approve this.',
    ],
  ])('%s (server message %p)', (kind, serverMessage, text) => {
    expect(userMessage(err(kind, serverMessage))).toBe(text)
  })

  test('an order refused behind a 429 gate says when to try again', () => {
    const e = new ApiError({
      kind: 'RateLimited',
      status: 0,
      endpoint: 'placeorder',
      retryInSec: 7,
    })
    expect(e.retryInSec).toBe(7)
    expect(userMessage(e)).toBe('The server is busy. Try again in 7 s.')
  })
})

test('ApiError carries its fields and is an Error', () => {
  const e = new ApiError({
    kind: 'Unsupported',
    status: 400,
    endpoint: 'history',
    unknownFields: ['source'],
  })
  expect(e).toBeInstanceOf(Error)
  expect(e).toMatchObject({ name: 'ApiError', kind: 'Unsupported', status: 400 })
  expect(e.unknownFields).toEqual(['source'])
  expect(e.message).toBe('history: Unsupported (400)')
  const v = new ApiError({
    kind: 'Validation',
    status: 400,
    endpoint: 'multiquotes',
    invalidSymbols: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
  })
  expect(v.invalidSymbols).toEqual([{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }])
})
