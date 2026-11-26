// The trading endpoints (plan contract C3-C6, openalgo c8b2896): marshmallow's validation of
// the order and book schemas, and an order engine behind the four books. One book serves both
// modes; analyzer mode adds mode:"analyze" to the replies, as the sandbox does.
import { findInstrument } from './instruments.mjs'

// --- Validation, as marshmallow loads restx_api/schemas.py ------------------------------
// loadFields, req, opt and the validators are shared with gtt.mjs.

const NUMBER = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/
const INTEGER = /^\s*[+-]?\d+\s*$/

// Python's float() and int(), as the non-strict Float and Int fields call them. A bool is never
// a number, and int() truncates a float.
function toFloat(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  return typeof v === 'string' && NUMBER.test(v) ? Number(v) : null
}
function toInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null
  return typeof v === 'string' && INTEGER.test(v) ? Number.parseInt(v, 10) : null
}
const TYPES = {
  str: [(v) => (typeof v === 'string' ? v : null), 'Not a valid string.'],
  float: [toFloat, 'Not a valid number.'],
  int: [toInt, 'Not a valid integer.'],
}

export const oneOf = (choices) => (v) =>
  choices.includes(v) ? null : `Must be one of: ${choices.join(', ')}.`
export const atLeast = (min, error) => (v) => (v >= min ? null : error)
export const above = (min, error) => (v) => (v > min ? null : error)
const lengthBetween = (min, max, error) => (v) =>
  v.length >= min && v.length <= max ? null : error

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function loadField(spec, raw) {
  if (spec.type === 'list') return loadList(spec, raw)
  const [cast, invalid] = TYPES[spec.type]
  const value = cast(raw)
  if (value === null) return { error: [invalid] }
  const message = spec.validate?.(value)
  return message ? { error: [message] } : { value }
}

// A List(Nested) reports its items' errors under their index: {0: {'price': [...]}}. A Map keeps
// the index a number, so pyRepr prints it unquoted.
function loadList(spec, raw) {
  if (!Array.isArray(raw)) return { error: ['Not a valid list.'] }
  const errors = new Map()
  const value = raw.map((item, i) => {
    const r = isObject(item)
      ? loadFields(spec.of, item)
      : { errors: { _schema: ['Invalid input type.'] } }
    if (r.errors) errors.set(i, r.errors)
    return r.data
  })
  if (errors.size) return { error: errors }
  const message = spec.validate?.(value)
  return message ? { error: [message] } : { value }
}

/**
 * Schema.load: { data } with the defaults filled in, or { errors } in field order. With
 * `exclude` (Meta.unknown = EXCLUDE) an undeclared field is dropped instead of refused.
 */
export function loadFields(fields, body, { exclude = false } = {}) {
  const errors = {}
  const data = {}
  for (const [name, spec] of Object.entries(fields)) {
    if (!Object.hasOwn(body, name)) {
      if (spec.required) errors[name] = ['Missing data for required field.']
      else if ('missing' in spec) data[name] = spec.missing
    } else if (body[name] === null) {
      if (spec.allowNone) data[name] = null
      else errors[name] = ['Field may not be null.']
    } else {
      const r = loadField(spec, body[name])
      if (r.error) errors[name] = r.error
      else data[name] = r.value
    }
  }
  for (const name of Object.keys(body)) {
    if (!exclude && !Object.hasOwn(fields, name)) errors[name] = ['Unknown field.']
  }
  return Object.keys(errors).length ? { errors } : { data }
}

const CRYPTO_EXCHANGES = ['CRYPTO']
// The post_load of the order schemas from 2.0.0.1 (restx_api/schemas.py:6-19).
export function wholeQuantity(data) {
  const q = data.quantity
  if (CRYPTO_EXCHANGES.includes(data.exchange) || q === Math.trunc(q)) return { data }
  return {
    errors: {
      quantity: [`Fractional quantity (${q}) is not allowed for non-crypto exchanges.`],
    },
  }
}

const ACTIONS = ['BUY', 'SELL', 'buy', 'sell']
const PRICETYPES = ['MARKET', 'LIMIT', 'SL', 'SL-M']
const PRODUCTS = ['MIS', 'NRML', 'CNC']

export const req = (type, validate) => ({ type, required: true, validate })
export const opt = (type, missing, validate) => ({ type, missing, validate })

const PRICE = atLeast(0, 'Price must be a non-negative number.')
const TRIGGER = atLeast(0, 'Trigger price must be a non-negative number.')
const DISCLOSED = atLeast(0, 'Disclosed quantity must be a non-negative integer.')
// The quantity rule per schema: [Float from 2.0.0.1, Int in 2.0.0.0].
const QUANTITY = {
  order: [
    above(0, 'Quantity must be a positive number.'),
    atLeast(1, 'Quantity must be a positive integer.'),
  ],
  smart: [
    atLeast(0, 'Quantity must be a non-negative number.'),
    atLeast(0, 'Quantity must be a non-negative integer.'),
  ],
  split: [
    above(0, 'Total quantity must be a positive number.'),
    atLeast(1, 'Total quantity must be a positive integer.'),
  ],
}
const quantity = (v, rule) =>
  v.fractionalQty ? req('float', QUANTITY[rule][0]) : req('int', QUANTITY[rule][1])

// The exchange OneOf applies on every profile (plan C2). Trees before openalgo 4da5fbcd0 have a
// plain Str here and refuse a bad exchange in the service instead, as "Invalid exchange. Must be
// one of: …" (90c3d2caf services/place_order_service.py:99); see exchangeField in rest.mjs.
const instrument = (v) => ({
  apikey: req('str'),
  strategy: req('str'),
  exchange: req('str', oneOf(v.exchanges)),
  symbol: req('str'),
  action: req('str', oneOf(ACTIONS)),
})
const terms = {
  pricetype: opt('str', 'MARKET', oneOf(PRICETYPES)),
  product: opt('str', 'MIS', oneOf(PRODUCTS)),
  price: opt('float', 0, PRICE),
  trigger_price: opt('float', 0, TRIGGER),
  disclosed_quantity: opt('int', 0, DISCLOSED),
}
const KEY_ONLY = { apikey: req('str') }
const KEY_AND_STRATEGY = { apikey: req('str'), strategy: req('str') }

// Each schema's fields in declaration order, which is the order its errors are reported in.
const FIELDS = {
  orderbook: () => KEY_ONLY,
  tradebook: () => KEY_ONLY,
  positionbook: () => KEY_ONLY,
  holdings: () => KEY_ONLY,
  placeorder: (v) => ({
    ...instrument(v),
    quantity: quantity(v, 'order'),
    ...terms,
    underlying_ltp: { type: 'float', missing: null, allowNone: true },
  }),
  placesmartorder: (v) => ({
    ...instrument(v),
    quantity: quantity(v, 'smart'),
    position_size: req(v.fractionalQty ? 'float' : 'int'),
    ...terms,
  }),
  splitorder: (v) => ({
    ...instrument(v),
    quantity: quantity(v, 'split'),
    splitsize: req('int', atLeast(1, 'Split size must be a positive integer.')),
    ...terms,
  }),
  modifyorder: (v) => {
    const { apikey, strategy, exchange, symbol, action } = instrument(v)
    return {
      apikey,
      strategy,
      exchange,
      symbol,
      orderid: req('str'),
      action,
      product: req('str', oneOf(PRODUCTS)),
      pricetype: req('str', oneOf(PRICETYPES)),
      price: req('float', PRICE),
      quantity: quantity(v, 'order'),
      disclosed_quantity: req('int', DISCLOSED),
      trigger_price: req('float', TRIGGER),
    }
  },
  cancelorder: () => ({ ...KEY_AND_STRATEGY, orderid: req('str') }),
  cancelallorder: () => KEY_AND_STRATEGY,
  closeposition: () => KEY_AND_STRATEGY,
  // quantity, price and trigger_price are strings (restx_api/schemas.py:339,344-345).
  margin: (v) => ({
    apikey: req('str'),
    positions: {
      type: 'list',
      required: true,
      of: {
        symbol: req('str', lengthBetween(1, 50, 'Symbol must be between 1 and 50 characters.')),
        exchange: req('str', oneOf(v.exchanges)),
        action: req('str', oneOf(ACTIONS)),
        quantity: req('str'),
        product: req('str', oneOf(PRODUCTS)),
        pricetype: req('str', oneOf(PRICETYPES)),
        price: opt('str', '0'),
        trigger_price: opt('str', '0'),
      },
      validate: lengthBetween(1, 50, 'Positions must contain 1 to 50 items.'),
    },
  }),
}
const BOOKS = ['orderbook', 'tradebook', 'positionbook', 'holdings']
const WHOLE_QUANTITY = ['placeorder', 'placesmartorder', 'splitorder', 'modifyorder']

/**
 * Per endpoint: the error style rest.mjs answers with (the books send the dict, the writes its
 * str(); restx_api/orderbook.py:39-40, place_order.py:33-35) and load(body, version).
 */
export const TRADING_SCHEMAS = Object.fromEntries(
  Object.entries(FIELDS).map(([id, fields]) => [
    id,
    {
      style: BOOKS.includes(id) ? 'dict' : 'repr',
      load(body, version) {
        const r = loadFields(fields(version), body)
        const whole = version.fractionalQty && WHOLE_QUANTITY.includes(id)
        return r.errors || !whole ? r : wholeQuantity(r.data)
      },
    },
  ]),
)

// --- The engine ---------------------------------------------------------------------------

const WORKING = ['open', 'trigger pending']
const DERIVATIVES = ['NFO', 'BFO', 'CDS', 'BCD', 'MCX', 'NCO', 'NCDEX', 'CRYPTO']
const MAX_SPLIT_ORDERS = 100 // services/split_order_service.py:26
const HOLDINGS = [
  { symbol: 'RELIANCE', exchange: 'NSE', product: 'CNC', quantity: 10, average_price: 1300 },
  { symbol: 'TCS', exchange: 'NSE', product: 'CNC', quantity: 5, average_price: 3500 },
]
// C5: live mode only (services/modify_order_service.py:243 and its siblings).
const SEMI_AUTO_REFUSALS = {
  modifyorder:
    'Modify order operation is not allowed in Semi-Auto mode. Please switch to Auto mode to modify orders.',
  cancelorder:
    'Cancel order operation is not allowed in Semi-Auto mode. Please switch to Auto mode to cancel orders.',
  cancelallorder:
    'Cancel all orders operation is not allowed in Semi-Auto mode. Please switch to Auto mode to cancel orders.',
  closeposition:
    'Close position operation is not allowed in Semi-Auto mode. Please switch to Auto mode to close positions.',
}

const round2 = (x) => Math.round(x * 100) / 100
// Python's str(float): a whole number keeps one decimal.
const pyFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x))

// C6 timestamps, in IST: "08-Apr-2025 13:58:03" in the orderbook, "13:58:03" in the tradebook.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const IST_OFFSET_MS = 19_800_000
const p2 = (n) => String(n).padStart(2, '0')
const ist = (ms) => new Date(ms + IST_OFFSET_MS)
const clock = (d) => `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
const orderStamp = (d) =>
  `${p2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${clock(d)}`
const idDate = (d) =>
  `${String(d.getUTCFullYear()).slice(2)}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`

const positionKey = (o) => `${o.exchange}:${o.symbol}:${o.product}`
const isWorking = (o) => WORKING.includes(o.order_status)

export function createOrderEngine({ state, prices, now = Date.now }) {
  let orders
  let trades
  let positions
  let seq
  let pendingSeq
  const listeners = new Set()

  function reset() {
    orders = new Map()
    trades = []
    positions = new Map()
    seq = 0
    pendingSeq = 0
  }
  reset()

  const analyzer = () => state.current.analyzer
  const withMode = (body) => (analyzer() ? { ...body, mode: 'analyze' } : body)
  const success = (body) => [200, withMode({ status: 'success', ...body })]
  const failure = (status, message) => [status, withMode({ status: 'error', message })]
  const ltp = (symbol, exchange) => prices.read(symbol, exchange).ltp

  function changed(o) {
    const update = {
      orderid: o.orderid,
      symbol: o.symbol,
      exchange: o.exchange,
      action: o.action,
      quantity: o.quantity,
      price: o.price,
      trigger_price: o.trigger_price,
      pricetype: o.pricetype,
      product: o.product,
      order_status: o.order_status,
      filled_quantity: o.filled_quantity,
      pending_quantity: isWorking(o) ? o.quantity - o.filled_quantity : 0,
      average_price: o.average_price,
      rejection_reason: '',
    }
    for (const fn of listeners) fn(update)
  }

  function net(o, px) {
    const key = positionKey(o)
    const p = positions.get(key) ?? {
      symbol: o.symbol,
      exchange: o.exchange,
      product: o.product,
      quantity: 0,
      average: 0,
      realized: 0,
    }
    const signed = o.action === 'BUY' ? o.quantity : -o.quantity
    if (p.quantity === 0 || Math.sign(p.quantity) === Math.sign(signed)) {
      const held = Math.abs(p.quantity)
      p.average = (held * p.average + Math.abs(signed) * px) / (held + Math.abs(signed))
    } else {
      const closed = Math.min(Math.abs(p.quantity), Math.abs(signed))
      p.realized += closed * (px - p.average) * Math.sign(p.quantity)
      // Flat keeps no average; a reversal opens the rest at this price.
      if (Math.abs(signed) === Math.abs(p.quantity)) p.average = 0
      else if (Math.abs(signed) > Math.abs(p.quantity)) p.average = px
    }
    p.quantity += signed
    positions.set(key, p)
  }

  function fill(o, px) {
    o.order_status = 'complete'
    o.filled_quantity = o.quantity
    o.average_price = px
    // The docs' orderbook shows a filled MARKET order at its fill price.
    if (o.pricetype === 'MARKET') o.price = px
    trades.push({ order: o, price: px, at: now() })
    net(o, px)
  }

  // MARKET fills at once at the mock price; LIMIT rests open and SL/SL-M wait for their trigger,
  // until fillWorking.
  function settle(o) {
    if (o.pricetype === 'MARKET') fill(o, ltp(o.symbol, o.exchange))
    else o.order_status = o.pricetype === 'LIMIT' ? 'open' : 'trigger pending'
    changed(o)
  }

  function submit(d) {
    seq++
    const o = {
      orderid: `${idDate(ist(now()))}${String(seq).padStart(9, '0')}`,
      symbol: d.symbol,
      exchange: d.exchange,
      action: d.action.toUpperCase(),
      quantity: d.quantity,
      pricetype: d.pricetype,
      product: d.product,
      price: d.price,
      trigger_price: d.trigger_price,
      order_status: 'open',
      filled_quantity: 0,
      average_price: 0,
      placedAt: now(),
    }
    orders.set(o.orderid, o)
    settle(o)
    return o.orderid
  }

  function cancel(o) {
    o.order_status = 'cancelled'
    changed(o)
  }

  function fillWorking() {
    for (const o of orders.values()) {
      if (!isWorking(o)) continue
      fill(o, o.pricetype === 'SL-M' ? o.trigger_price : o.price)
      changed(o)
    }
  }
  state.onPatch((p) => {
    if (p.fillWorking) fillWorking()
  })

  // order_router_service.py:137-146: place, smart and split queue, in analyzer mode too.
  function queued() {
    pendingSeq++
    return [
      200,
      {
        status: 'success',
        message: 'Order queued for approval in Action Center',
        mode: 'semi_auto',
        pending_order_id: pendingSeq,
      },
    ]
  }
  const queues = () => state.current.semiAuto
  const refusal = (id) =>
    state.current.semiAuto && !analyzer()
      ? [403, { status: 'error', message: SEMI_AUTO_REFUSALS[id] }]
      : null
  const unlisted = (d) =>
    findInstrument(d.symbol, d.exchange)
      ? null
      : failure(400, `Symbol ${d.symbol} not found on ${d.exchange}`)
  function unworkable(o, orderid, verb) {
    if (!o) return failure(404, `Order ${orderid} not found`)
    if (!isWorking(o)) return failure(400, `Cannot ${verb} order in ${o.order_status} status`)
    return null
  }

  function orderRow(o) {
    return {
      action: o.action,
      symbol: o.symbol,
      exchange: o.exchange,
      orderid: o.orderid,
      product: o.product,
      quantity: String(o.quantity),
      price: o.price,
      pricetype: o.pricetype,
      order_status: o.order_status,
      trigger_price: o.trigger_price,
      timestamp: orderStamp(ist(o.placedAt)),
    }
  }
  function tradeRow({ order: o, price, at }) {
    return {
      action: o.action,
      symbol: o.symbol,
      exchange: o.exchange,
      orderid: o.orderid,
      product: o.product,
      quantity: o.quantity,
      average_price: price,
      timestamp: clock(ist(at)),
      trade_value: round2(o.quantity * price),
    }
  }
  // Every value a string, as the docs' positionbook sends them.
  function positionRow(p) {
    const last = ltp(p.symbol, p.exchange)
    return {
      symbol: p.symbol,
      exchange: p.exchange,
      product: p.product,
      quantity: String(p.quantity),
      average_price: pyFloat(round2(p.average)),
      ltp: pyFloat(last),
      pnl: round2(p.realized + (last - p.average) * p.quantity).toFixed(2),
    }
  }
  function holdingsData() {
    let value = 0
    let invested = 0
    const holdings = HOLDINGS.map((h) => {
      const last = ltp(h.symbol, h.exchange)
      value += last * h.quantity
      invested += h.average_price * h.quantity
      return {
        symbol: h.symbol,
        exchange: h.exchange,
        product: h.product,
        quantity: h.quantity,
        pnl: round2((last - h.average_price) * h.quantity),
        pnlpercent: round2(((last - h.average_price) / h.average_price) * 100),
        ltp: last,
        average_price: h.average_price,
      }
    })
    const statistics = {
      totalholdingvalue: round2(value),
      totalinvvalue: round2(invested),
      totalprofitandloss: round2(value - invested),
      totalpnlpercentage: round2(((value - invested) / invested) * 100),
    }
    return { holdings, statistics }
  }

  function marginOf(legs) {
    const refuse = (message) => [400, { status: 'error', message }]
    let total = 0
    for (const [i, leg] of legs.entries()) {
      // services/margin_service.py:88-102, positions numbered from 1.
      const n = i + 1
      const qty = toInt(leg.quantity)
      if (qty === null) return refuse(`Position ${n}: Invalid quantity format`)
      if (qty <= 0) return refuse(`Position ${n}: Quantity must be a positive number`)
      const price = toFloat(leg.price)
      if (price === null) return refuse(`Position ${n}: Invalid price format`)
      if (price < 0) return refuse(`Position ${n}: Price cannot be negative`)
      const rate = leg.product === 'CNC' ? 1 : DERIVATIVES.includes(leg.exchange) ? 0.12 : 0.2
      total += qty * (price > 0 ? price : ltp(leg.symbol, leg.exchange)) * rate
    }
    // margin_service.py:184-199: 15 brokers have no margin API.
    if (state.current.marginUnsupported) {
      const message = `Margin calculation not implemented for broker: ${state.current.broker}`
      return [501, { status: 'error', message }]
    }
    const required = round2(total)
    return [
      200,
      {
        status: 'success',
        data: { total_margin_required: required, span_margin: 0, exposure_margin: required },
      },
    ]
  }

  // Each runs after validation and the key checks, with the loaded fields, and returns
  // [status, body].
  const handlers = {
    orderbook() {
      const all = [...orders.values()]
      const count = (pred) => all.filter(pred).length
      const statistics = {
        total_buy_orders: count((o) => o.action === 'BUY'),
        total_sell_orders: count((o) => o.action === 'SELL'),
        total_completed_orders: count((o) => o.order_status === 'complete'),
        total_open_orders: count(isWorking),
        total_rejected_orders: count((o) => o.order_status === 'rejected'),
      }
      return success({ data: { orders: all.map(orderRow), statistics } })
    },
    tradebook: () => success({ data: trades.map(tradeRow) }),
    positionbook: () => success({ data: [...positions.values()].map(positionRow) }),
    holdings: () => success({ data: holdingsData() }),

    placeorder(d) {
      if (queues()) return queued()
      return unlisted(d) ?? success({ orderid: submit(d) })
    },
    // The order that reaches position_size; a fresh trade when both are flat
    // (broker/zerodha/api/order_api.py:364-383, sandbox_service.py:500-532).
    placesmartorder(d) {
      if (queues()) return queued()
      const bad = unlisted(d)
      if (bad) return bad
      const current = positions.get(positionKey(d))?.quantity ?? 0
      const target = Math.trunc(d.position_size)
      if (target === 0 && current === 0 && d.quantity !== 0) return success({ orderid: submit(d) })
      if (target === current) {
        // C4: ibulls, definedge and tradejini answer a flat close with a 500.
        if (state.current.flatCloseError) return failure(500, 'No position to square off')
        const message =
          analyzer() && d.quantity === 0
            ? 'No OpenPosition Found. Not placing Exit order.'
            : 'Positions Already Matched. No Action needed.'
        return success({ message })
      }
      const diff = target - current
      const action = diff > 0 ? 'BUY' : 'SELL'
      return success({ orderid: submit({ ...d, action, quantity: Math.abs(diff) }) })
    },
    // services/split_order_service.py:203-222 and :406-411.
    splitorder(d) {
      if (queues()) return queued()
      const bad = unlisted(d)
      if (bad) return bad
      const size = d.splitsize
      const rest = d.quantity % size
      const count = Math.floor(d.quantity / size) + (rest ? 1 : 0)
      if (count > MAX_SPLIT_ORDERS) {
        return failure(
          400,
          `Total number of orders would exceed maximum limit of ${MAX_SPLIT_ORDERS}`,
        )
      }
      const failFrom = state.current.splitFailFrom
      const results = Array.from({ length: count }, (_, i) => {
        const order_num = i + 1
        const qty = rest && order_num === count ? rest : size
        if (failFrom !== null && order_num >= failFrom) {
          return { order_num, quantity: qty, status: 'error', message: 'Failed to place order' }
        }
        return {
          order_num,
          quantity: qty,
          status: 'success',
          orderid: submit({ ...d, quantity: qty }),
        }
      })
      return success({ total_quantity: d.quantity, split_size: size, results })
    },
    modifyorder(d) {
      const o = orders.get(d.orderid)
      const bad = refusal('modifyorder') ?? unworkable(o, d.orderid, 'modify')
      if (bad) return bad
      Object.assign(o, {
        quantity: d.quantity,
        price: d.price,
        trigger_price: d.trigger_price,
        pricetype: d.pricetype,
      })
      settle(o)
      return success({
        orderid: o.orderid,
        ...(analyzer() ? { message: 'Order modified successfully' } : {}),
      })
    },
    cancelorder(d) {
      const o = orders.get(d.orderid)
      const bad = refusal('cancelorder') ?? unworkable(o, d.orderid, 'cancel')
      if (bad) return bad
      cancel(o)
      return success({
        orderid: o.orderid,
        ...(analyzer() ? { message: 'Order cancelled successfully' } : {}),
      })
    },
    // cancel_all_order_service.py:166-172; sandbox_service.py:575-587 when nothing is open.
    cancelallorder() {
      const bad = refusal('cancelallorder')
      if (bad) return bad
      const working = [...orders.values()].filter(isWorking)
      for (const o of working) cancel(o)
      const message =
        analyzer() && !working.length
          ? 'No open orders to cancel'
          : `Canceled ${working.length} orders. Failed to cancel 0 orders.`
      return success({
        message,
        canceled_orders: working.map((o) => o.orderid),
        failed_cancellations: [],
      })
    },
    // close_position_service.py:181 live; sandbox_service.py:344-395 in analyzer mode.
    closeposition() {
      const bad = refusal('closeposition')
      if (bad) return bad
      const open = [...positions.values()].filter((p) => p.quantity !== 0)
      for (const p of open) {
        submit({
          exchange: p.exchange,
          symbol: p.symbol,
          product: p.product,
          action: p.quantity > 0 ? 'SELL' : 'BUY',
          quantity: Math.abs(p.quantity),
          pricetype: 'MARKET',
          price: 0,
          trigger_price: 0,
        })
      }
      if (!analyzer()) return success({ message: 'All Open Positions Squared Off' })
      if (!open.length) return success({ message: 'No open positions to close' })
      return success({
        message: `Closed ${open.length} positions`,
        closed_positions: open.length,
        failed_closures: 0,
      })
    },
    margin: (d) => marginOf(d.positions),
  }

  return {
    handlers,
    /** Every order change, as the fields of an order_update frame. */
    onUpdate(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** The orders by status, for the control stats. */
    counts() {
      const out = {}
      for (const o of orders.values()) out[o.order_status] = (out[o.order_status] ?? 0) + 1
      return out
    },
    reset,
  }
}
