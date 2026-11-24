import { ApiError, type ApiErrorKind, unknownFields, userMessage } from './errors'

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
})
