import { NO_REPLY_DELAYS_MS, noReplyDelays, RECONCILE_DELAYS_MS } from '../orders/reconcile'
import { reconcileGttCancel, reconcileGttChange, reconcileGttPlacement } from './reconcile'
import { type GttBook, GttBookSchema, type GttSpec } from './schemas'

const SINGLE: GttSpec = {
  type: 'SINGLE',
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'SELL',
  product: 'CNC',
  quantity: 1,
  trigger: 1500,
  price: 1499,
  above: false,
}
const OCO: GttSpec = {
  type: 'OCO',
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'SELL',
  product: 'CNC',
  quantity: 1,
  sl: { trigger: 1700, price: 1699 },
  tg: { trigger: 1900, price: 1901 },
}

const leg = (price: number, o: Record<string, unknown> = {}) => ({
  action: 'SELL',
  quantity: 1,
  price,
  pricetype: 'LIMIT',
  product: 'CNC',
  ...o,
})

/** One G4 row as the server sends it: the SINGLE above, active, unless overridden. */
const raw = (o: Record<string, unknown> = {}) => ({
  trigger_id: '1001',
  trigger_type: 'single',
  status: 'active',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  trigger_prices: [1500],
  last_price: 1800,
  legs: [leg(1499)],
  created_at: '2026-11-26T04:00:00.000Z',
  updated_at: '2026-11-26T04:00:00.000Z',
  expires_at: '2027-11-26T04:00:00.000Z',
  ...o,
})
const rawOco = (o: Record<string, unknown> = {}) =>
  raw({ trigger_type: 'two-leg', trigger_prices: [1700, 1900], legs: [leg(1699), leg(1901)], ...o })

/** Parsed the way the app reads it. */
const book = (...rows: object[]): GttBook => GttBookSchema.parse({ status: 'success', data: rows })
/** A row the app cannot read (no trigger id): dropped and counted. */
const unreadable = () => raw({ trigger_id: undefined })

/** A fetch answering each call with the next book (the last one repeats); an Error rejects. */
function fetches(...books: (GttBook | Error)[]) {
  let i = 0
  return jest.fn(async () => {
    const b = books[Math.min(i++, books.length - 1)]
    if (b === undefined || b instanceof Error) throw b ?? new Error('no book')
    return b
  })
}

const sleep = jest.fn(async (_ms: number) => {})
const NONE: ReadonlySet<string> = new Set()

beforeEach(() => sleep.mockClear())

describe('reconcileGttPlacement', () => {
  test('finds the new row, past known ids and other contracts', async () => {
    const fetchBook = fetches(
      book(
        raw({ trigger_id: '900' }),
        raw({ trigger_id: '901', symbol: 'SBIN' }),
        raw({ trigger_id: '902', exchange: 'BSE' }),
        raw({ trigger_id: '903', trigger_prices: [1510] }),
        raw({ trigger_id: '1001' }),
      ),
    )
    const out = await reconcileGttPlacement({
      fetchBook,
      spec: SINGLE,
      knownIds: new Set(['900']),
      sleep,
    })
    expect(out.checked).toBe(true)
    expect(out.found?.triggerId).toBe('1001')
    expect(fetchBook).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(RECONCILE_DELAYS_MS[0])
  })

  test('matches the triggers at 2 dp and the type: an OCO is not a SINGLE', async () => {
    const fetchBook = fetches(
      book(raw({ trigger_id: '7', trigger_prices: [1700, 1900] }), rawOco({ trigger_id: '8' })),
    )
    const found = await reconcileGttPlacement({
      fetchBook,
      spec: { ...OCO, sl: { trigger: 1700.001, price: 1699 } },
      knownIds: NONE,
      sleep,
    })
    expect(found.found?.triggerId).toBe('8')
  })

  test('the first candidate wins, whatever its status: a GTT that fired at once is still ours', async () => {
    const fetchBook = fetches(
      book(raw({ trigger_id: '1002', status: 'triggered' }), raw({ trigger_id: '1003' })),
    )
    const out = await reconcileGttPlacement({ fetchBook, spec: SINGLE, knownIds: NONE, sleep })
    expect(out.found?.triggerId).toBe('1002')
  })

  test('reads on while the book lags, then finds it', async () => {
    const fetchBook = fetches(book(), new Error('offline'), book(raw()))
    const out = await reconcileGttPlacement({ fetchBook, spec: SINGLE, knownIds: NONE, sleep })
    expect(out).toMatchObject({ found: { triggerId: '1001' }, checked: true })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...RECONCILE_DELAYS_MS])
  })

  test('not in the book after every delay: found null, checked', async () => {
    const fetchBook = fetches(book(raw({ symbol: 'SBIN' })))
    const out = await reconcileGttPlacement({
      fetchBook,
      spec: SINGLE,
      knownIds: NONE,
      sleep,
      delaysMs: noReplyDelays(),
    })
    expect(out).toEqual({ found: null, checked: true })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...NO_REPLY_DELAYS_MS])
  })

  test('a book with an unreadable row and no match could not check: the row may be ours', async () => {
    const fetchBook = fetches(book(raw({ symbol: 'SBIN' }), unreadable()))
    expect(await reconcileGttPlacement({ fetchBook, spec: SINGLE, knownIds: NONE, sleep })).toEqual(
      { found: null, checked: false },
    )
  })

  test('no read worked: not checked', async () => {
    const fetchBook = fetches(new Error('offline'))
    expect(await reconcileGttPlacement({ fetchBook, spec: SINGLE, knownIds: NONE, sleep })).toEqual(
      { found: null, checked: false },
    )
  })
})

describe('reconcileGttChange', () => {
  const MODIFIED: GttSpec = { ...SINGLE, trigger: 1510, price: 1509 }

  test('the row by id shows the new values: applied', async () => {
    const fetchBook = fetches(book(raw({ trigger_prices: [1510], legs: [leg(1509)] })))
    expect(
      await reconcileGttChange({ fetchBook, triggerId: '1001', spec: MODIFIED, sleep }),
    ).toEqual({ found: 'applied', checked: true })
    expect(fetchBook).toHaveBeenCalledTimes(1)
  })

  test('the old values after every read: unchanged', async () => {
    const fetchBook = fetches(book(raw()))
    expect(
      await reconcileGttChange({ fetchBook, triggerId: '1001', spec: MODIFIED, sleep }),
    ).toEqual({ found: 'unchanged', checked: true })
    expect(fetchBook).toHaveBeenCalledTimes(RECONCILE_DELAYS_MS.length)
  })

  test('the book lags: unchanged at first, then applied', async () => {
    const fetchBook = fetches(book(raw()), book(raw({ trigger_prices: [1510], legs: [leg(1509)] })))
    expect(
      await reconcileGttChange({ fetchBook, triggerId: '1001', spec: MODIFIED, sleep }),
    ).toEqual({ found: 'applied', checked: true })
    expect(fetchBook).toHaveBeenCalledTimes(2)
  })

  test('a change of the quantity or a limit price alone is not applied until the book shows it', async () => {
    const fetchBook = fetches(book(raw()))
    const qty = await reconcileGttChange({
      fetchBook,
      triggerId: '1001',
      spec: { ...SINGLE, quantity: 2 },
      sleep,
    })
    expect(qty.found).toBe('unchanged')
    const price = await reconcileGttChange({
      fetchBook,
      triggerId: '1001',
      spec: { ...SINGLE, price: 1498 },
      sleep,
    })
    expect(price.found).toBe('unchanged')
  })

  test('an OCO compares each leg with its own trigger', async () => {
    const change = (row: object, spec: GttSpec = OCO) =>
      reconcileGttChange({ fetchBook: fetches(book(row)), triggerId: '1001', spec, sleep })
    const right = rawOco({ trigger_prices: [1900, 1700], legs: [leg(1901), leg(1699)] })
    expect((await change(right)).found).toBe('applied')
    // Limits that sit beyond both triggers keep the row's pairing, so swapped limits differ.
    const low: GttSpec = {
      ...OCO,
      sl: { trigger: 1700, price: 1650 },
      tg: { trigger: 1900, price: 1600 },
    }
    expect((await change(rawOco({ legs: [leg(1650), leg(1600)] }), low)).found).toBe('applied')
    expect((await change(rawOco({ legs: [leg(1600), leg(1650)] }), low)).found).toBe('unchanged')
  })

  test('a Fyers OCO (target leg first, triggers sorted) with the new values is applied', async () => {
    // c8b2896 broker/fyers/mapping/gtt_data.py, map_gtt_book: legs [target, stop-loss].
    const fyers = rawOco({ trigger_prices: [1700, 1900], legs: [leg(1901), leg(1699)] })
    const fetchBook = fetches(book(fyers))
    expect(await reconcileGttChange({ fetchBook, triggerId: '1001', spec: OCO, sleep })).toEqual({
      found: 'applied',
      checked: true,
    })
    expect(fetchBook).toHaveBeenCalledTimes(1)
  })

  test('a broker that replaces the GTT: once the old row has left, a new active row with the new values is applied', async () => {
    const replacement = raw({ trigger_id: '2002', trigger_prices: [1510], legs: [leg(1509)] })
    for (const old of [[raw({ status: 'cancelled' })], []]) {
      const fetchBook = fetches(book(replacement, ...old))
      expect(
        await reconcileGttChange({ fetchBook, triggerId: '1001', spec: MODIFIED, sleep }),
      ).toEqual({ found: 'applied', checked: true })
    }
  })

  test('another active GTT with the new values is not the change while the row is still active with the old ones', async () => {
    // A (1001) is modified to B's (2002) values, and the send never reached the broker.
    const fetchBook = fetches(
      book(raw(), raw({ trigger_id: '2002', trigger_prices: [1510], legs: [leg(1509)] })),
    )
    expect(
      await reconcileGttChange({ fetchBook, triggerId: '1001', spec: MODIFIED, sleep }),
    ).toEqual({ found: 'unchanged', checked: true })
    expect(fetchBook).toHaveBeenCalledTimes(RECONCILE_DELAYS_MS.length)
  })

  test('no longer active, beside an unreadable row that could be its replacement: not checked', async () => {
    const out = await reconcileGttChange({
      fetchBook: fetches(book(raw({ status: 'cancelled' }), unreadable())),
      triggerId: '1001',
      spec: MODIFIED,
      sleep,
    })
    expect(out).toEqual({ found: 'gone', checked: false })
  })

  test('still active with the old values beside an unreadable row: unchanged, checked', async () => {
    const out = await reconcileGttChange({
      fetchBook: fetches(book(raw(), unreadable())),
      triggerId: '1001',
      spec: MODIFIED,
      sleep,
    })
    expect(out).toEqual({ found: 'unchanged', checked: true })
  })

  test('a new row that is not active is not the change', async () => {
    const fetchBook = fetches(
      book(
        raw({ trigger_id: '2002', status: 'triggered', trigger_prices: [1510], legs: [leg(1509)] }),
      ),
    )
    expect(
      (await reconcileGttChange({ fetchBook, triggerId: '1001', spec: MODIFIED, sleep })).found,
    ).toBe('gone')
  })

  test('absent, or no longer active with the old values: gone', async () => {
    const absent = await reconcileGttChange({
      fetchBook: fetches(book()),
      triggerId: '1001',
      spec: MODIFIED,
      sleep,
    })
    expect(absent).toEqual({ found: 'gone', checked: true })
    const fired = await reconcileGttChange({
      fetchBook: fetches(book(raw({ status: 'triggered' }))),
      triggerId: '1001',
      spec: MODIFIED,
      sleep,
    })
    expect(fired).toEqual({ found: 'gone', checked: true })
  })

  test('(Fyers) a row in transit with the old values is still active: unchanged, never gone', async () => {
    // c8b2896 broker/fyers/mapping/gtt_data.py: ord_status 4 is "transit", in ACTIVE_GTT_STATUSES
    const fetchBook = fetches(book(raw({ status: 'transit' })))
    expect(
      await reconcileGttChange({ fetchBook, triggerId: '1001', spec: MODIFIED, sleep }),
    ).toEqual({ found: 'unchanged', checked: true })
    // nor is another GTT with the new values the change while it can still fire
    const beside = fetches(
      book(
        raw({ status: 'transit' }),
        raw({ trigger_id: '2002', trigger_prices: [1510], legs: [leg(1509)] }),
      ),
    )
    expect(
      (await reconcileGttChange({ fetchBook: beside, triggerId: '1001', spec: MODIFIED, sleep }))
        .found,
    ).toBe('unchanged')
  })

  test("(Fyers) a broker's replacement in transit with the new values is the change", async () => {
    const fetchBook = fetches(
      book(
        raw({ trigger_id: '2002', status: 'transit', trigger_prices: [1510], legs: [leg(1509)] }),
      ),
    )
    expect(
      await reconcileGttChange({ fetchBook, triggerId: '1001', spec: MODIFIED, sleep }),
    ).toEqual({ found: 'applied', checked: true })
  })

  test('absent from a book with an unreadable row: not checked', async () => {
    const out = await reconcileGttChange({
      fetchBook: fetches(book(unreadable())),
      triggerId: '1001',
      spec: MODIFIED,
      sleep,
    })
    expect(out.checked).toBe(false)
  })

  test('the row by id with an empty status and the old values is unknown, not gone: read to the deadline', async () => {
    // Nor is another row with the new values its replacement: the row may not have left.
    const fetchBook = fetches(
      book(
        raw({ status: '' }),
        raw({ trigger_id: '2002', trigger_prices: [1510], legs: [leg(1509)] }),
      ),
    )
    expect(
      await reconcileGttChange({ fetchBook, triggerId: '1001', spec: MODIFIED, sleep }),
    ).toEqual({ found: 'unchanged', checked: false })
    expect(fetchBook).toHaveBeenCalledTimes(RECONCILE_DELAYS_MS.length)
  })

  test('the row by id with an empty status and the new values: applied', async () => {
    const fetchBook = fetches(book(raw({ status: '', trigger_prices: [1510], legs: [leg(1509)] })))
    expect(
      await reconcileGttChange({ fetchBook, triggerId: '1001', spec: MODIFIED, sleep }),
    ).toEqual({ found: 'applied', checked: true })
  })
})

describe('reconcileGttCancel', () => {
  const cancel = (fetchBook: ReturnType<typeof fetches>) =>
    reconcileGttCancel({ fetchBook, triggerId: '1001', sleep })

  test('status cancelled: cancelled, at the first read', async () => {
    const fetchBook = fetches(book(raw({ status: 'Cancelled' })))
    expect(await cancel(fetchBook)).toEqual({ found: 'cancelled', checked: true })
    expect(fetchBook).toHaveBeenCalledTimes(1)
  })

  test('absent: gone (a book read without status lists active rows only)', async () => {
    expect(await cancel(fetches(book(raw({ trigger_id: '1002' }))))).toEqual({
      found: 'gone',
      checked: true,
    })
  })

  test.each(['deleted', 'triggered', 'expired', 'triggering'])(
    'status %s is that other status',
    async (status) => {
      expect(await cancel(fetches(book(raw({ status }))))).toEqual({
        found: { other: status },
        checked: true,
      })
    },
  )

  test('(Fyers) a row in transit can still fire: active, read on, never another status', async () => {
    const fetchBook = fetches(book(raw({ status: 'Transit' })))
    expect(await cancel(fetchBook)).toEqual({ found: 'active', checked: true })
    expect(fetchBook).toHaveBeenCalledTimes(RECONCILE_DELAYS_MS.length)
  })

  test('still active after every read: active, checked', async () => {
    const fetchBook = fetches(book(raw()))
    expect(await cancel(fetchBook)).toEqual({ found: 'active', checked: true })
    expect(fetchBook).toHaveBeenCalledTimes(RECONCILE_DELAYS_MS.length)
  })

  test('the book lags: active at first, then cancelled', async () => {
    const fetchBook = fetches(book(raw()), book(raw({ status: 'cancelled' })))
    expect(await cancel(fetchBook)).toEqual({ found: 'cancelled', checked: true })
    expect(fetchBook).toHaveBeenCalledTimes(2)
  })

  test("an active-only book (Dhan's, Angel's, Fyers' and Upstox's ignore status:'all'): the row leaving is gone, checked, and the reads stop", async () => {
    // c8b2896 broker/{dhan,angel,fyers,upstox}/api/gtt_api.py get_gtt_book: include_history is
    // accepted and ignored, so a cancelled GTT leaves the book rather than reading `cancelled`.
    const fetchBook = fetches(
      book(raw(), raw({ trigger_id: '1002' })),
      book(raw({ trigger_id: '1002' })),
    )
    expect(await cancel(fetchBook)).toEqual({ found: 'gone', checked: true })
    expect(fetchBook).toHaveBeenCalledTimes(2)
  })

  test('absent from an empty book: gone, checked, at the first read', async () => {
    const fetchBook = fetches(book())
    expect(await cancel(fetchBook)).toEqual({ found: 'gone', checked: true })
    expect(fetchBook).toHaveBeenCalledTimes(1)
  })

  test('absent from a book with an unreadable row: not checked', async () => {
    expect(await cancel(fetches(book(unreadable())))).toEqual({ found: 'gone', checked: false })
  })

  test.each([
    ['blank', ''],
    ['spaces', '   '],
    ['null', null],
    ['absent', undefined],
    ['unreadable', { code: 3 }],
  ])(
    'a status that parses as empty (%s) is never { other: "" }: unknown, read to the deadline',
    async (_, status) => {
      const row = raw({ status })
      const fetchBook = fetches(book(row))
      expect(book(row).rows[0]?.status).toBe('')
      expect(await cancel(fetchBook)).toEqual({ found: 'active', checked: false })
      expect(fetchBook).toHaveBeenCalledTimes(RECONCILE_DELAYS_MS.length)
    },
  )

  test('an empty status, then the book says: that answer, checked', async () => {
    const cancelled = fetches(book(raw({ status: '' })), book(raw({ status: 'cancelled' })))
    expect(await cancel(cancelled)).toEqual({ found: 'cancelled', checked: true })
    expect(cancelled).toHaveBeenCalledTimes(2)
    const left = fetches(book(raw({ status: '' })), book())
    expect(await cancel(left)).toEqual({ found: 'gone', checked: true })
    expect(left).toHaveBeenCalledTimes(2)
  })

  test('the last read with an empty status, after an earlier active one: unknown, not active', async () => {
    const fetchBook = fetches(book(raw()), book(raw({ status: '' })))
    expect(await cancel(fetchBook)).toEqual({ found: 'active', checked: false })
    expect(fetchBook).toHaveBeenCalledTimes(RECONCILE_DELAYS_MS.length)
  })

  test('the row found is checked, whatever else could not be read', async () => {
    expect(await cancel(fetches(book(raw({ status: 'cancelled' }), unreadable())))).toEqual({
      found: 'cancelled',
      checked: true,
    })
  })
})
