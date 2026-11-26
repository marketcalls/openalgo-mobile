// Stock-server behaviour per OpenAlgo version (plan contract S6 and S10-S12).
//
// | id       | app-info | missing  | 4401 | orderStream | 1012 | omitAbsent | with_greeks | portfolio+sip | sectorrotation |
// | 1.0.0.41 | 404 html | 404 html |  -   |      -      |  -   |     -      |      -      |       -       |       -        |
// | 2.0.0.0  |    ✓     | 200 html |  -   |      -      |  -   |     -      |      -      |       -       |       -        |
// | 2.0.1.6  |    ✓     | 200 html |  ✓   |      ✓      |  -   |     -      |      -      |       -       |       -        |
// | 2.0.2.0  |    ✓     | 200 html |  ✓   |      ✓      |  -   |     -      |      ✓      |       ✓       |       -        |
// | 2.0.3.5  |    ✓     | 404 json |  ✓   |      ✓      |  ✓   |     ✓      |      ✓      |       ✓       |       ✓        |
//
// Every profile from 2.0.0.0 also has multioptiongreeks, the WS ping, history.source and the
// trading endpoints (symbol, the four books, the order writes and margin).
// modeLabels (2.0.1.1): subscribe acks carry the mode label and unsubscribe normalizes the
// mode; before it, the ack echoes the request and unsubscribe matches the numeric mode only.
// exchanges (plan B contract C2, utils/constants.py:52-67): the 2.0.0.0 set, then from 2.0.1.6
// CRYPTO (2.0.0.1) and NCO MCX_INDEX GLOBAL_INDEX (2.0.1.0). fractionalQty (2.0.0.1,
// restx_api/schemas.py:6-19): quantities are Float and a fractional one is refused; before,
// they are Int and 1.5 truncates to 1.

// VALID_EXCHANGES in its own order: the 2.0.0.0 set, and the c8b2896 set.
const EXCHANGES_2_0_0_0 = Object.freeze([
  'NSE',
  'NFO',
  'CDS',
  'BSE',
  'BFO',
  'BCD',
  'MCX',
  'NCDEX',
  'NSE_INDEX',
  'BSE_INDEX',
])
const EXCHANGES_2_0_1_0 = Object.freeze([
  'NSE',
  'NFO',
  'CDS',
  'BSE',
  'BFO',
  'BCD',
  'MCX',
  'NCDEX',
  'NCO',
  'NSE_INDEX',
  'BSE_INDEX',
  'MCX_INDEX',
  'GLOBAL_INDEX',
  'CRYPTO',
])

const V1 = {
  appInfo: false,
  missing: 'html404',
  authDeadline: false,
  orderStream: false,
  close1012: false,
  omitAbsent: false,
  withGreeks: false,
  portfolioSip: false,
  sectorRotation: false,
  multiOptionGreeks: false,
  wsPing: false,
  historySource: false,
  modeLabels: false,
  trading: false,
  exchanges: EXCHANGES_2_0_0_0,
  fractionalQty: false,
}
const V2_0_0_0 = {
  ...V1,
  appInfo: true,
  missing: 'html200',
  multiOptionGreeks: true,
  wsPing: true,
  historySource: true,
  trading: true,
}
const V2_0_1_6 = {
  ...V2_0_0_0,
  authDeadline: true,
  orderStream: true,
  modeLabels: true,
  exchanges: EXCHANGES_2_0_1_0,
  fractionalQty: true,
}
const V2_0_2_0 = { ...V2_0_1_6, withGreeks: true, portfolioSip: true }
const V2_0_3_5 = {
  ...V2_0_2_0,
  missing: 'json404',
  close1012: true,
  omitAbsent: true,
  sectorRotation: true,
}

export const PROFILES = Object.freeze({
  '1.0.0.41': Object.freeze(V1),
  '2.0.0.0': Object.freeze(V2_0_0_0),
  '2.0.1.6': Object.freeze(V2_0_1_6),
  '2.0.2.0': Object.freeze(V2_0_2_0),
  '2.0.3.5': Object.freeze(V2_0_3_5),
})

const BASE_ENDPOINTS = [
  'ping',
  'search',
  'funds',
  'analyzer',
  'analyzer/toggle',
  'quotes',
  'multiquotes',
  'depth',
  'history',
  'optionchain',
]
const TRADING_ENDPOINTS = [
  'symbol',
  'orderbook',
  'tradebook',
  'positionbook',
  'holdings',
  'placeorder',
  'placesmartorder',
  'splitorder',
  'modifyorder',
  'cancelorder',
  'cancelallorder',
  'closeposition',
  'margin',
]

/** The POST endpoint ids a profile serves under /api/v1. */
export function endpointsOf(p) {
  return [
    ...BASE_ENDPOINTS,
    ...(p.multiOptionGreeks ? ['multioptiongreeks'] : []),
    ...(p.trading ? TRADING_ENDPOINTS : []),
    ...(p.portfolioSip ? ['portfolio/backtest', 'sip/backtest'] : []),
    ...(p.sectorRotation ? ['sectorrotation'] : []),
  ]
}

/** The swagger.json `paths` key flask-restx gives an endpoint: route "/" adds a slash. */
export function swaggerKey(id) {
  return ['analyzer/toggle', 'multioptiongreeks', 'portfolio/backtest', 'sip/backtest'].includes(id)
    ? `/${id}`
    : `/${id}/`
}
