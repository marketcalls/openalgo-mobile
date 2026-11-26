// The GTT endpoints (plan C contract G1-G4, openalgo c8b2896): marshmallow's validation of the
// four GTT schemas, and one GTT book behind them. As in orders.mjs, the one book serves both
// modes: analyzer mode adds mode:"analyze" to the replies and the book envelope, and strategy and
// margin_blocked to the rows, as the sandbox does (sandbox/gtt_manager.py:637-701).
import { above, atLeast, loadFields, oneOf, opt, req, wholeQuantity } from './orders.mjs'

// --- Validation, as marshmallow loads restx_api/schemas.py:365-581 -------------------------

const PRODUCT_ERROR =
  'GTT supports only CNC (delivery) or NRML (overnight F&O); MIS is intraday-only.'
const notEmpty = (v) => (v.length >= 1 ? null : 'Shorter than minimum length 1.')
const nullableFloat = { type: 'float', missing: null, allowNone: true }

// PlaceGTTOrderSchema and ModifyGTTOrderSchema in declaration order; modify adds trigger_id.
const orderFields = (v, modify) => ({
  apikey: req('str'),
  strategy: req('str'),
  ...(modify ? { trigger_id: req('str', notEmpty) } : {}),
  trigger_type: req('str'),
  exchange: req('str', oneOf(v.exchanges)),
  symbol: req('str'),
  action: req('str', oneOf(['BUY', 'SELL', 'buy', 'sell'])),
  product: req('str', (p) => (['NRML', 'CNC'].includes(p) ? null : PRODUCT_ERROR)),
  quantity: req('float', above(0, 'Quantity must be a positive number.')),
  pricetype: opt('str', 'LIMIT', oneOf(['LIMIT', 'MARKET'])),
  price: req('float', atLeast(0, 'Price must be a non-negative number.')),
  triggerprice_sl: opt('float', 0, atLeast(0, 'triggerprice_sl must be non-negative.')),
  triggerprice_tg: opt('float', 0, atLeast(0, 'triggerprice_tg must be non-negative.')),
  stoploss: nullableFloat,
  target: nullableFloat,
})
const CANCEL_FIELDS = {
  apikey: req('str'),
  strategy: req('str'),
  trigger_id: req('str', notEmpty),
}
const bookFields = (v) => ({
  apikey: req('str'),
  ...(v.gttStatus ? { status: opt('str', 'active', oneOf(['active', 'all'])) } : {}),
})

// _validate_gtt_place_request (restx_api/schemas.py:365-434): the trigger rules, then the whole
// quantity. A SINGLE with both triggers keeps the stop-loss one.
function checkTriggers(d) {
  const refuse = (field, message) => ({ errors: { [field]: [message] } })
  const type = d.trigger_type.toUpperCase()
  if (type !== 'SINGLE' && type !== 'OCO') {
    return refuse('trigger_type', "Must be 'SINGLE' or 'OCO'.")
  }
  const sl = d.triggerprice_sl
  const tg = d.triggerprice_tg
  const out = { ...d, trigger_type: type, action: d.action.toUpperCase() }
  if (type === 'OCO') {
    if (!sl) return refuse('triggerprice_sl', 'Required for OCO (stoploss trigger).')
    if (!d.stoploss) return refuse('stoploss', 'Required for OCO (stoploss leg limit).')
    if (!tg) return refuse('triggerprice_tg', 'Required for OCO (target trigger).')
    if (!d.target) return refuse('target', 'Required for OCO (target leg limit).')
    if (sl >= tg) {
      return refuse(
        'triggerprice_sl',
        'Stoploss trigger must be less than target trigger (triggerprice_tg).',
      )
    }
  } else {
    if (sl <= 0 && tg <= 0) {
      return refuse(
        'triggerprice_sl',
        'SINGLE GTT requires a positive triggerprice_sl or triggerprice_tg.',
      )
    }
    Object.assign(out, sl > 0 ? { triggerprice_tg: 0 } : {}, { stoploss: null, target: null })
  }
  return wholeQuantity(out)
}

const loadOrder = (modify) => (body, v) => {
  // Meta.unknown = EXCLUDE (restx_api/schemas.py:456-457, 514-515).
  const r = loadFields(orderFields(v, modify), body, { exclude: true })
  return r.errors ? r : checkTriggers(r.data)
}

/**
 * Per endpoint: the error style rest.mjs answers with (the writes send str(), tagged in analyzer
 * mode by emit_analyzer_error; the book sends the dict, restx_api/gtt_orderbook.py:33-34) and
 * load(body, version).
 */
export const GTT_SCHEMAS = {
  placegttorder: { style: 'analyzerRepr', load: loadOrder(false) },
  modifygttorder: { style: 'analyzerRepr', load: loadOrder(true) },
  cancelgttorder: { style: 'analyzerRepr', load: (body) => loadFields(CANCEL_FIELDS, body) },
  gttorderbook: { style: 'dict', load: (body, v) => loadFields(bookFields(v), body) },
}

// --- The engine ------------------------------------------------------------------------------

const FIRST_ID = 1001
const EXPIRY_MS = 365 * 86_400_000 // a GTT with no expiry rests a year (gtt_manager.py:51)
// 4890ccee9:services/gtt_orderbook_service.py:24-33: analyzer mode before the sandbox GTT.
const SANDBOX_501 = {
  mode: 'analyze',
  status: 'error',
  message: 'Sandbox GTT support not yet implemented',
}
// Live mode only (services/modify_gtt_order_service.py:166-186, cancel_gtt_order_service.py:166-182).
const SEMI_AUTO_REFUSALS = {
  modifygttorder: 'Modify GTT order is not allowed in Semi-Auto mode. Switch to Auto mode.',
  cancelgttorder: 'Cancel GTT order is not allowed in Semi-Auto mode. Switch to Auto mode.',
}

const round2 = (x) => Math.round(x * 100) / 100
const iso = (ms) => new Date(ms).toISOString()

// The sandbox's legs (gtt_manager.py:312-376): an OCO's stop-loss below and its target above,
// each at its own limit; a SINGLE's direction is its field's.
function legsOf(d) {
  const leg = (trigger, direction, price) => ({
    trigger,
    direction,
    action: d.action,
    quantity: d.quantity,
    price,
    pricetype: d.pricetype,
    product: d.product,
  })
  if (d.trigger_type === 'OCO') {
    return [leg(d.triggerprice_sl, 'below', d.stoploss), leg(d.triggerprice_tg, 'above', d.target)]
  }
  return d.triggerprice_sl > 0
    ? [leg(d.triggerprice_sl, 'below', d.price)]
    : [leg(d.triggerprice_tg, 'above', d.price)]
}

// leg_is_triggered_by (gtt_manager.py:131-150): inclusive, by the trigger's direction.
const crossed = (leg, ltp) => (leg.direction === 'above' ? ltp >= leg.trigger : ltp <= leg.trigger)

// The larger leg's value, as an OCO blocks one leg (gtt_oco_margin_mode 'max'); a leg without a
// limit is priced at its trigger. The mock keeps no funds, so every product is priced as CNC.
const marginOf = (legs) =>
  round2(Math.max(...legs.map((l) => l.quantity * (l.price > 0 ? l.price : l.trigger))))

export function createGttEngine({ state, prices, now = Date.now }) {
  let gtts // by trigger_id, in placement order
  let nextId
  let pendingSeq

  function reset() {
    gtts = new Map()
    nextId = FIRST_ID
    pendingSeq = 0
  }
  reset()

  const analyzer = () => state.current.analyzer
  const withMode = (body) => (analyzer() ? { ...body, mode: 'analyze' } : body)
  const success = (body) => [200, withMode({ status: 'success', ...body })]

  // place_gtt_order_service.py:227: queued before the analyzer and broker checks, in either mode.
  // The mock's Action Center ids are the GTT engine's own.
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
  const refusal = (id) =>
    state.current.semiAuto && !analyzer()
      ? [403, { status: 'error', message: SEMI_AUTO_REFUSALS[id] }]
      : null
  // G1 and G3: analyzer mode needs the sandbox; live mode a broker with a gtt_api module.
  function unserved(version) {
    if (analyzer()) return version.sandboxGtt ? null : [501, SANDBOX_501]
    const { broker } = state.current
    if (version.gttBrokers.includes(broker)) return null
    return [
      501,
      { status: 'error', message: `GTT orders are not supported for broker '${broker}' yet` },
    ]
  }
  const inactive = (id) =>
    gtts.get(id)?.status === 'active'
      ? null
      : [404, withMode({ status: 'error', message: `No active GTT with trigger_id '${id}'` })]

  function settle(g, status) {
    g.status = status
    g.margin = 0
    g.updatedAt = now()
  }

  // A place or a full replacement: the legs and the LTP at that moment. A trigger already on its
  // firing side is triggered at once (RF 6), where the sandbox fires it on its next tick or scan.
  function arm(g, d) {
    const ltp = prices.read(d.symbol, d.exchange).ltp
    const legs = legsOf(d)
    Object.assign(g, {
      strategy: d.strategy,
      type: legs.length === 2 ? 'two-leg' : 'single',
      symbol: d.symbol,
      exchange: d.exchange,
      lastPrice: ltp,
      legs,
      status: 'active',
      margin: marginOf(legs),
      updatedAt: now(),
    })
    if (legs.some((l) => crossed(l, ltp))) settle(g, 'triggered')
  }

  function fire() {
    for (const g of gtts.values()) if (g.status === 'active') settle(g, 'triggered')
  }
  state.onPatch((p) => {
    if (p.fireGtts) fire()
  })

  // G4 in Kite's shape: the legs in ascending trigger order, as arm builds them.
  function row(g) {
    const r = {
      trigger_id: g.id,
      trigger_type: g.type,
      status: g.status,
      symbol: g.symbol,
      exchange: g.exchange,
      trigger_prices: g.legs.map((l) => l.trigger),
      last_price: g.lastPrice,
      legs: g.legs.map(({ action, quantity, price, pricetype, product }) => ({
        action,
        quantity,
        price,
        pricetype,
        product,
      })),
      created_at: iso(g.createdAt),
      updated_at: iso(g.updatedAt),
      expires_at: iso(g.expiresAt),
    }
    return analyzer() ? { ...r, strategy: g.strategy, margin_blocked: g.margin } : r
  }

  // Each runs after validation and the key checks, with the loaded fields, and returns
  // [status, body].
  const handlers = {
    placegttorder(d, { version }) {
      if (state.current.semiAuto) return queued()
      const bad = unserved(version)
      if (bad) return bad
      const at = now()
      const g = { id: String(nextId++), createdAt: at, expiresAt: at + EXPIRY_MS }
      arm(g, d)
      gtts.set(g.id, g)
      return success({ trigger_id: g.id })
    },
    modifygttorder(d, { version }) {
      const bad = refusal('modifygttorder') ?? unserved(version) ?? inactive(d.trigger_id)
      if (bad) return bad
      arm(gtts.get(d.trigger_id), d)
      return success({ trigger_id: d.trigger_id })
    },
    cancelgttorder(d, { version }) {
      const bad = refusal('cancelgttorder') ?? unserved(version) ?? inactive(d.trigger_id)
      if (bad) return bad
      settle(gtts.get(d.trigger_id), 'cancelled')
      return success({ trigger_id: d.trigger_id })
    },
    // Active rows by default; `all` adds the rest after them, each group newest first
    // (services/gtt_orderbook_service.py:21-33).
    gttorderbook(d, { version }) {
      const bad = unserved(version)
      if (bad) return bad
      const newest = [...gtts.values()].reverse()
      const active = newest.filter((g) => g.status === 'active')
      const listed =
        d.status === 'all' ? [...active, ...newest.filter((g) => g.status !== 'active')] : active
      return success({ data: listed.map(row) })
    },
  }

  return { handlers, reset, fire }
}
