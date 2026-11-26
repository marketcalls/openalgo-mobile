// The mock's GTT endpoints per profile (plan C contract G1-G4): the routes, the sandbox and the
// broker gates, the Kite-shaped book, the trigger direction (RF 6), Semi-Auto and the controls.
// On NSE RELIANCE, whose LTP opens at 1,800.30.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROFILES } from './profiles.mjs'
import { call, control, mock, post } from './test-helpers.mjs'

const HTML =
  '<!doctype html><html><head><title>OpenAlgo</title></head><body><div id="root"></div></body></html>'
const GTT_IDS = ['placegttorder', 'modifygttorder', 'cancelgttorder', 'gttorderbook']
const SANDBOX_501 = {
  mode: 'analyze',
  status: 'error',
  message: 'Sandbox GTT support not yet implemented',
}
const NO_BROKER_GTT = (broker) => ({
  status: 'error',
  message: `GTT orders are not supported for broker '${broker}' yet`,
})
const NOT_ACTIVE = (id) => ({ status: 'error', message: `No active GTT with trigger_id '${id}'` })
const SEMI_AUTO = {
  modifygttorder: 'Modify GTT order is not allowed in Semi-Auto mode. Switch to Auto mode.',
  cancelgttorder: 'Cancel GTT order is not allowed in Semi-Auto mode. Switch to Auto mode.',
}
const KITE_ROW_KEYS = [
  'created_at',
  'exchange',
  'expires_at',
  'last_price',
  'legs',
  'status',
  'symbol',
  'trigger_id',
  'trigger_prices',
  'trigger_type',
  'updated_at',
]

// A SINGLE SELL below the LTP, as the app sends it (G2).
const single = (o = {}) => ({
  strategy: 'mobile',
  trigger_type: 'SINGLE',
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'SELL',
  product: 'CNC',
  quantity: 1,
  pricetype: 'LIMIT',
  price: 1499,
  triggerprice_sl: 1500,
  triggerprice_tg: 0,
  ...o,
})
const oco = (o = {}) => ({
  ...single(),
  trigger_type: 'OCO',
  price: 1719,
  triggerprice_sl: 1720,
  stoploss: 1719,
  triggerprice_tg: 1880,
  target: 1881,
  ...o,
})
const modify = (id, o) => ({ trigger_id: id, ...single(o) })
const cancel = (id) => ({ strategy: 'mobile', trigger_id: id })

async function place(m, body = single()) {
  const r = await post(m, 'placegttorder', body)
  assert.equal(r.status, 200, r.text)
  return r.json.trigger_id
}
async function book(m, body = {}) {
  const r = await post(m, 'gttorderbook', body)
  assert.equal(r.status, 200, r.text)
  return r.json
}
const rows = async (m, body) => (await book(m, body)).data
const rowById = async (m, id) => (await rows(m, { status: 'all' })).find((r) => r.trigger_id === id)

// --- Profiles ---------------------------------------------------------------------------

test('profile flags: gtt from 2.0.1.6, the sandbox from 2.0.2.0, status and five brokers on 2.0.3.5', () => {
  const flags = ({ gtt, sandboxGtt, gttStatus, gttBrokers }) => ({
    gtt,
    sandboxGtt,
    gttStatus,
    gttBrokers,
  })
  const none = { gtt: false, sandboxGtt: false, gttStatus: false, gttBrokers: [] }
  assert.deepEqual(flags(PROFILES['1.0.0.41']), none)
  assert.deepEqual(flags(PROFILES['2.0.0.0']), none)
  assert.deepEqual(flags(PROFILES['2.0.1.6']), {
    gtt: true,
    sandboxGtt: false,
    gttStatus: false,
    gttBrokers: ['zerodha', 'dhan'],
  })
  assert.deepEqual(flags(PROFILES['2.0.2.0']), {
    gtt: true,
    sandboxGtt: true,
    gttStatus: false,
    gttBrokers: ['zerodha', 'dhan'],
  })
  assert.deepEqual(flags(PROFILES['2.0.3.5']), {
    gtt: true,
    sandboxGtt: true,
    gttStatus: true,
    gttBrokers: ['zerodha', 'dhan', 'angel', 'fyers', 'upstox', 'pocketful', 'rupeezy'],
  })
})

test('1.0.0.41 and 2.0.0.0: no GTT route, and swagger lists none', async (t) => {
  for (const [profile, status] of [
    ['1.0.0.41', 404],
    ['2.0.0.0', 200],
  ]) {
    const m = await mock(t, { profile })
    for (const id of GTT_IDS) {
      const r = await post(m, id, single())
      assert.equal(r.status, status, `${profile} ${id}`)
      assert.equal(r.text, HTML, `${profile} ${id}`)
    }
    const paths = Object.keys((await call(m, 'GET', '/api/v1/swagger.json')).json.paths)
    assert.equal(
      paths.some((p) => /gtt/.test(p)),
      false,
      profile,
    )
  }
})

test('from 2.0.1.6 swagger lists the four GTT ids, and each refuses {} with a 400', async (t) => {
  for (const profile of ['2.0.1.6', '2.0.2.0', '2.0.3.5']) {
    const m = await mock(t, { profile })
    const paths = Object.keys((await call(m, 'GET', '/api/v1/swagger.json')).json.paths)
    for (const id of GTT_IDS) {
      assert.ok(paths.includes(`/${id}/`), `${profile} ${id}`)
      const r = await call(m, 'POST', `/api/v1/${id}`, {})
      assert.equal(r.status, 400, `${profile} ${id}`)
      assert.match(r.text, /apikey/, `${profile} ${id}`)
    }
  }
})

// --- 2.0.1.6: LIVE only, no status field ----------------------------------------------------

test('2.0.1.6 LIVE zerodha: a SINGLE places as 1001 and the book lists it in the Kite shape', async (t) => {
  const m = await mock(t, { profile: '2.0.1.6' })
  const r = await post(m, 'placegttorder', single())
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { status: 'success', trigger_id: '1001' })
  const b = await book(m)
  assert.equal('mode' in b, false)
  assert.equal(b.status, 'success')
  assert.equal(b.data.length, 1)
  const [row] = b.data
  assert.deepEqual(Object.keys(row).sort(), KITE_ROW_KEYS)
  assert.deepEqual(
    [row.trigger_id, row.trigger_type, row.status, row.symbol, row.exchange, row.trigger_prices],
    ['1001', 'single', 'active', 'RELIANCE', 'NSE', [1500]],
  )
  assert.deepEqual(row.legs, [
    { action: 'SELL', quantity: 1, price: 1499, pricetype: 'LIMIT', product: 'CNC' },
  ])
  assert.ok(Math.abs(row.last_price - 1800.3) < 20, String(row.last_price))
  for (const f of ['created_at', 'updated_at', 'expires_at']) {
    assert.match(row[f], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, f)
  }
  assert.ok(Date.parse(row.expires_at) > Date.parse(row.created_at))
})

test('2.0.1.6: the book refuses status as an Unknown field', async (t) => {
  const m = await mock(t, { profile: '2.0.1.6' })
  const r = await post(m, 'gttorderbook', { status: 'all' })
  assert.equal(r.status, 400)
  assert.deepEqual(r.json, { status: 'error', message: { status: ['Unknown field.'] } })
})

test('2.0.1.6 ANALYZE: every GTT id answers the sandbox 501', async (t) => {
  const m = await mock(t, { profile: '2.0.1.6' })
  const id = await place(m)
  await control(m, { analyzer: true })
  for (const [endpoint, body] of [
    ['placegttorder', single()],
    ['modifygttorder', modify(id)],
    ['cancelgttorder', cancel(id)],
    ['gttorderbook', {}],
  ]) {
    const r = await post(m, endpoint, body)
    assert.equal(r.status, 501, endpoint)
    assert.deepEqual(r.json, SANDBOX_501, endpoint)
  }
})

test('2.0.1.6 LIVE with angel: the place and the book answer the broker 501', async (t) => {
  const m = await mock(t, { profile: '2.0.1.6', broker: 'angel' })
  for (const [endpoint, body] of [
    ['placegttorder', single()],
    ['gttorderbook', {}],
  ]) {
    const r = await post(m, endpoint, body)
    assert.equal(r.status, 501, endpoint)
    assert.deepEqual(r.json, NO_BROKER_GTT('angel'), endpoint)
  }
})

// --- 2.0.2.0: the sandbox --------------------------------------------------------------------

test('2.0.2.0 ANALYZE, any broker: the replies and the book envelope carry mode, the rows do not', async (t) => {
  const m = await mock(t, { profile: '2.0.2.0', broker: 'angel' })
  await control(m, { analyzer: true })
  const placed = await post(m, 'placegttorder', single())
  assert.equal(placed.status, 200)
  assert.deepEqual(placed.json, { status: 'success', mode: 'analyze', trigger_id: '1001' })
  const b = await book(m)
  assert.equal(b.mode, 'analyze')
  assert.equal(b.data.length, 1)
  const [row] = b.data
  assert.equal('mode' in row, false)
  assert.deepEqual(Object.keys(row).sort(), [...KITE_ROW_KEYS, 'margin_blocked', 'strategy'].sort())
  assert.equal(row.strategy, 'mobile')
  assert.equal(row.margin_blocked, 1499)
  const modified = await post(m, 'modifygttorder', modify('1001', { triggerprice_sl: 1510 }))
  assert.deepEqual(modified.json, { status: 'success', mode: 'analyze', trigger_id: '1001' })
  const cancelled = await post(m, 'cancelgttorder', cancel('1001'))
  assert.deepEqual(cancelled.json, { status: 'success', mode: 'analyze', trigger_id: '1001' })
  assert.deepEqual((await book(m)).data, [])
  const gone = await post(m, 'cancelgttorder', cancel('1001'))
  assert.equal(gone.status, 404)
  assert.deepEqual(gone.json, { ...NOT_ACTIVE('1001'), mode: 'analyze' })
})

test('2.0.2.0: a refused write is tagged in ANALYZE as emit_analyzer_error does; the book is not', async (t) => {
  const m = await mock(t, { profile: '2.0.2.0' })
  const message =
    "{'product': ['GTT supports only CNC (delivery) or NRML (overnight F&O); MIS is intraday-only.']}"
  const live = await post(m, 'placegttorder', single({ product: 'MIS' }))
  assert.equal(live.status, 400)
  assert.deepEqual(live.json, { status: 'error', message })
  await control(m, { analyzer: true })
  const analyze = await post(m, 'placegttorder', single({ product: 'MIS' }))
  assert.equal(analyze.status, 400)
  assert.deepEqual(analyze.json, { mode: 'analyze', status: 'error', message })
  const status = await post(m, 'gttorderbook', { status: 'all' })
  assert.equal(status.status, 400)
  assert.deepEqual(status.json, { status: 'error', message: { status: ['Unknown field.'] } })
})

// --- 2.0.3.5 ---------------------------------------------------------------------------------

test('2.0.3.5: an OCO lists as two-leg with ascending triggers and each leg at its own price', async (t) => {
  const m = await mock(t)
  const id = await place(m, oco())
  const [row] = await rows(m)
  assert.equal(row.trigger_id, id)
  assert.equal(row.trigger_type, 'two-leg')
  assert.equal(row.status, 'active')
  assert.deepEqual(row.trigger_prices, [1720, 1880])
  assert.deepEqual(
    row.legs.map((l) => l.price),
    [1719, 1881],
  )
})

test('(RF 6) a trigger on the firing side of the LTP is triggered at once, on place and modify', async (t) => {
  const m = await mock(t)
  const below = await place(m, single({ triggerprice_sl: 1900, triggerprice_tg: 0, price: 1900 }))
  const above = await place(m, single({ triggerprice_sl: 0, triggerprice_tg: 1900, price: 1900 }))
  assert.equal((await rowById(m, below)).status, 'triggered')
  assert.equal((await rowById(m, above)).status, 'active')
  assert.deepEqual(
    (await rows(m)).map((r) => r.trigger_id),
    [above],
  )
  const tgAt = await place(m, single({ triggerprice_sl: 0, triggerprice_tg: 1700, price: 1700 }))
  assert.equal((await rowById(m, tgAt)).status, 'triggered')
  const ocoUp = await place(m, oco({ triggerprice_tg: 1750, target: 1751 }))
  assert.equal((await rowById(m, ocoUp)).status, 'triggered')

  const r = await post(m, 'modifygttorder', modify(above, { triggerprice_sl: 1900 }))
  assert.equal(r.status, 200, r.text)
  const row = await rowById(m, above)
  assert.equal(row.status, 'triggered')
  assert.deepEqual(row.trigger_prices, [1900])
})

test('2.0.3.5: a modify replaces the GTT; a modify or cancel of a row that is not active is the 404', async (t) => {
  const m = await mock(t)
  const id = await place(m)
  const r = await post(m, 'modifygttorder', modify(id, { triggerprice_sl: 1510, quantity: 2 }))
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { status: 'success', trigger_id: id })
  const row = await rowById(m, id)
  assert.deepEqual(row.trigger_prices, [1510])
  assert.equal(row.legs[0].quantity, 2)
  assert.equal((await post(m, 'cancelgttorder', cancel(id))).status, 200)
  for (const [endpoint, body] of [
    ['cancelgttorder', cancel(id)],
    ['modifygttorder', modify(id)],
    ['cancelgttorder', cancel('9999')],
  ]) {
    const again = await post(m, endpoint, body)
    assert.equal(again.status, 404, endpoint)
    assert.deepEqual(again.json, NOT_ACTIVE(body.trigger_id), endpoint)
  }
})

test('2.0.3.5: the G2 refusals, and place and modify drop an unknown field', async (t) => {
  const m = await mock(t)
  const repr = (field, text) => ({ status: 'error', message: `{'${field}': ['${text}']}` })
  const cases = [
    [
      oco({ triggerprice_sl: 1880 }),
      repr(
        'triggerprice_sl',
        'Stoploss trigger must be less than target trigger (triggerprice_tg).',
      ),
    ],
    [
      single({ product: 'MIS' }),
      repr(
        'product',
        'GTT supports only CNC (delivery) or NRML (overnight F&O); MIS is intraday-only.',
      ),
    ],
    [
      single({ triggerprice_sl: 0 }),
      repr('triggerprice_sl', 'SINGLE GTT requires a positive triggerprice_sl or triggerprice_tg.'),
    ],
    [oco({ target: 0 }), repr('target', 'Required for OCO (target leg limit).')],
    [single({ quantity: 0 }), repr('quantity', 'Quantity must be a positive number.')],
    [
      single({ quantity: 1.5 }),
      repr('quantity', 'Fractional quantity (1.5) is not allowed for non-crypto exchanges.'),
    ],
    [
      single({ trigger_type: 'GTT' }),
      { status: 'error', message: `{'trigger_type': ["Must be 'SINGLE' or 'OCO'."]}` },
    ],
  ]
  for (const [body, expected] of cases) {
    const r = await post(m, 'placegttorder', body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, expected, JSON.stringify(body))
  }
  const id = await place(m, single({ last_price: 1800, extra: true }))
  const modified = await post(m, 'modifygttorder', modify(id, { extra: true }))
  assert.equal(modified.status, 200, modified.text)
  const refused = await post(m, 'cancelgttorder', { ...cancel(id), extra: true })
  assert.equal(refused.status, 400)
  assert.deepEqual(refused.json, repr('extra', 'Unknown field.'))
  const bad = await post(m, 'gttorderbook', { status: 'open' })
  assert.equal(bad.status, 400)
  assert.deepEqual(bad.json, {
    status: 'error',
    message: { status: ['Must be one of: active, all.'] },
  })
})

test('2.0.3.5: the default book lists active rows; all lists every row, active first', async (t) => {
  const m = await mock(t)
  const first = await place(m)
  const second = await place(m, oco())
  const third = await place(m, single({ triggerprice_sl: 1400, price: 1399 }))
  assert.equal((await post(m, 'cancelgttorder', cancel(second))).status, 200)
  const active = await rows(m)
  assert.deepEqual(
    active.map((r) => r.trigger_id),
    [third, first],
  )
  assert.deepEqual(
    (await rows(m, { status: 'active' })).map((r) => r.trigger_id),
    [third, first],
  )
  const all = await rows(m, { status: 'all' })
  assert.deepEqual(
    all.map((r) => [r.trigger_id, r.status]),
    [
      [third, 'active'],
      [first, 'active'],
      [second, 'cancelled'],
    ],
  )
})

test('2.0.3.5 LIVE: all adds the history for zerodha, pocketful and rupeezy only; the sandbox for any broker', async (t) => {
  // c8b2896 get_gtt_book: the Dhan, Angel, Fyers and Upstox mappers accept include_history and
  // still list active rows only, so a cancelled or triggered row is simply gone there.
  for (const [broker, history] of [
    ['zerodha', true],
    ['pocketful', true],
    ['rupeezy', true],
    ['dhan', false],
    ['angel', false],
    ['fyers', false],
    ['upstox', false],
  ]) {
    const m = await mock(t, { broker })
    const kept = await place(m)
    const cancelled = await place(m, oco())
    const fired = await place(m, single({ triggerprice_sl: 1900, price: 1900 }))
    assert.equal((await post(m, 'cancelgttorder', cancel(cancelled))).status, 200, broker)
    const listed = async () =>
      (await rows(m, { status: 'all' })).map((r) => [r.trigger_id, r.status])
    const everything = [
      [kept, 'active'],
      [fired, 'triggered'],
      [cancelled, 'cancelled'],
    ]
    assert.deepEqual(await listed(), history ? everything : [[kept, 'active']], broker)
    await control(m, { analyzer: true })
    assert.deepEqual(await listed(), everything, `${broker} ANALYZE`)
  }
})

test('2.0.3.5: place declares expires_at, a string or null; modify drops it as an unknown field', async (t) => {
  const m = await mock(t)
  for (const expires_at of [20270101, true, ['2027-01-01']]) {
    const r = await post(m, 'placegttorder', single({ expires_at }))
    assert.equal(r.status, 400, JSON.stringify(expires_at))
    assert.deepEqual(
      r.json,
      { status: 'error', message: "{'expires_at': ['Not a valid string.']}" },
      JSON.stringify(expires_at),
    )
  }
  const id = await place(m, single({ expires_at: null }))
  await place(m, single({ expires_at: '2027-01-01 15:30:00' }))
  const modified = await post(m, 'modifygttorder', modify(id, { expires_at: 20270101 }))
  assert.equal(modified.status, 200, modified.text)
})

test('2.0.3.5: place and modify read an empty trigger as 0 and an empty leg limit as None (pre_load)', async (t) => {
  const m = await mock(t)
  const repr = (field, text) => ({ status: 'error', message: `{'${field}': ['${text}']}` })
  const refused = async (endpoint, body, expected) => {
    const r = await post(m, endpoint, body)
    assert.equal(r.status, 400, `${endpoint} ${JSON.stringify(body)}`)
    assert.deepEqual(r.json, expected, `${endpoint} ${JSON.stringify(body)}`)
  }
  const noTrigger = repr(
    'triggerprice_sl',
    'SINGLE GTT requires a positive triggerprice_sl or triggerprice_tg.',
  )

  const id = await place(m, single({ triggerprice_tg: '', stoploss: '', target: '' }))
  assert.deepEqual((await rowById(m, id)).trigger_prices, [1500])
  await refused('placegttorder', single({ triggerprice_sl: '', triggerprice_tg: '' }), noTrigger)
  await refused(
    'placegttorder',
    oco({ stoploss: '' }),
    repr('stoploss', 'Required for OCO (stoploss leg limit).'),
  )
  // Only '' is coerced: a blank is no number.
  await refused('placegttorder', single({ triggerprice_tg: ' ' }), {
    status: 'error',
    message: "{'triggerprice_tg': ['Not a valid number.']}",
  })

  const empties = {
    triggerprice_sl: '',
    triggerprice_tg: 1900,
    price: 1900,
    stoploss: '',
    target: '',
  }
  const modified = await post(m, 'modifygttorder', modify(id, empties))
  assert.equal(modified.status, 200, modified.text)
  const row = await rowById(m, id)
  assert.deepEqual([row.status, row.trigger_prices], ['active', [1900]])
  await refused(
    'modifygttorder',
    modify(id, { triggerprice_sl: '', triggerprice_tg: '' }),
    noTrigger,
  )
  await refused(
    'modifygttorder',
    { trigger_id: id, ...oco({ target: '' }) },
    repr('target', 'Required for OCO (target leg limit).'),
  )
})

test('control fireGtts triggers every active GTT and is not stored', async (t) => {
  const m = await mock(t)
  const a = await place(m)
  const b = await place(m, oco())
  await post(m, 'cancelgttorder', cancel(b))
  const c = await place(m, oco())
  const s = await control(m, { fireGtts: true })
  assert.equal('fireGtts' in s, false)
  assert.deepEqual(await rows(m), [])
  const all = await rows(m, { status: 'all' })
  assert.deepEqual(Object.fromEntries(all.map((r) => [r.trigger_id, r.status])), {
    [a]: 'triggered',
    [b]: 'cancelled',
    [c]: 'triggered',
  })
  const bad = await call(m, 'POST', '/__mock/control', { fireGtts: false })
  assert.equal(bad.status, 400)
  assert.equal(typeof bad.json.error, 'string')
})

test('2.0.3.5 LIVE: angel is accepted; a broker outside G5 still gets the 501', async (t) => {
  const m = await mock(t, { broker: 'angel' })
  const r = await post(m, 'placegttorder', single())
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { status: 'success', trigger_id: '1001' })
  assert.equal((await rows(m)).length, 1)
  await control(m, { broker: 'shoonya' })
  const none = await post(m, 'gttorderbook')
  assert.equal(none.status, 501)
  assert.deepEqual(none.json, NO_BROKER_GTT('shoonya'))
})

test('Semi-Auto: a place is queued in either mode; modify and cancel are refused in LIVE only', async (t) => {
  const m = await mock(t)
  const id = await place(m)
  await control(m, { semiAuto: true })
  const queued = await post(m, 'placegttorder', single())
  assert.equal(queued.status, 200)
  assert.deepEqual(queued.json, {
    status: 'success',
    message: 'Order queued for approval in Action Center',
    mode: 'semi_auto',
    pending_order_id: 1,
  })
  for (const [endpoint, body] of [
    ['modifygttorder', modify(id, { triggerprice_sl: 1510 })],
    ['cancelgttorder', cancel(id)],
  ]) {
    const r = await post(m, endpoint, body)
    assert.equal(r.status, 403, endpoint)
    assert.deepEqual(r.json, { status: 'error', message: SEMI_AUTO[endpoint] }, endpoint)
  }
  const b = await book(m)
  assert.deepEqual(
    b.data.map((r) => [r.trigger_id, r.trigger_prices]),
    [[id, [1500]]],
  )

  await control(m, { analyzer: true })
  const analyzeQueued = await post(m, 'placegttorder', single())
  assert.equal(analyzeQueued.json.mode, 'semi_auto')
  assert.equal(analyzeQueued.json.pending_order_id, 2)
  const modified = await post(m, 'modifygttorder', modify(id, { triggerprice_sl: 1510 }))
  assert.equal(modified.status, 200, modified.text)
  assert.deepEqual(modified.json, { status: 'success', mode: 'analyze', trigger_id: id })
  assert.equal((await post(m, 'cancelgttorder', cancel(id))).status, 200)
})

test('failNext afterApply on placegttorder answers 502 with the GTT in the book', async (t) => {
  const m = await mock(t)
  await control(m, { failNext: { path: '/api/v1/placegttorder', status: 502, afterApply: true } })
  const r = await post(m, 'placegttorder', single())
  assert.equal(r.status, 502)
  assert.deepEqual(
    (await rows(m)).map((row) => [row.trigger_id, row.status]),
    [['1001', 'active']],
  )
})

test('the key and the broker session are checked on every GTT id', async (t) => {
  const m = await mock(t)
  const invalid = { status: 'error', message: 'Invalid openalgo apikey' }
  const bodies = {
    placegttorder: single(),
    modifygttorder: modify('1001'),
    cancelgttorder: cancel('1001'),
    gttorderbook: {},
  }
  for (const [id, body] of Object.entries(bodies)) {
    const r = await call(m, 'POST', `/api/v1/${id}`, { apikey: 'cd'.repeat(32), ...body })
    assert.equal(r.status, 403, id)
    assert.deepEqual(r.json, invalid, id)
  }
  await control(m, { brokerLoggedOut: true })
  for (const [id, body] of Object.entries(bodies)) {
    const r = await post(m, id, body)
    assert.equal(r.status, 403, id)
    assert.deepEqual(r.json, invalid, id)
  }
})

test('/__mock/reset empties the GTT book and restarts the ids at 1001', async (t) => {
  const m = await mock(t)
  await place(m)
  await place(m, oco())
  await call(m, 'POST', '/__mock/reset')
  assert.deepEqual(await rows(m, { status: 'all' }), [])
  assert.equal(await place(m), '1001')
})
