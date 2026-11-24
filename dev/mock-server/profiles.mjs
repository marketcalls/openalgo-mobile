// Stock-server behaviour per OpenAlgo version (plan contract S6 and S10-S12).
//
// | id       | app-info | missing  | 4401 | orderStream | 1012 | omitAbsent | with_greeks | portfolio+sip | sectorrotation |
// | 1.0.0.41 | 404 html | 404 html |  -   |      -      |  -   |     -      |      -      |       -       |       -        |
// | 2.0.0.0  |    ✓     | 200 html |  -   |      -      |  -   |     -      |      -      |       -       |       -        |
// | 2.0.1.6  |    ✓     | 200 html |  ✓   |      ✓      |  -   |     -      |      -      |       -       |       -        |
// | 2.0.2.0  |    ✓     | 200 html |  ✓   |      ✓      |  -   |     -      |      ✓      |       ✓       |       -        |
// | 2.0.3.5  |    ✓     | 404 json |  ✓   |      ✓      |  ✓   |     ✓      |      ✓      |       ✓       |       ✓        |
//
// Every profile from 2.0.0.0 also has multioptiongreeks, the WS ping and history.source.
// modeLabels (2.0.1.1): subscribe acks carry the mode label and unsubscribe normalizes the
// mode; before it, the ack echoes the request and unsubscribe matches the numeric mode only.

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
}
const V2_0_0_0 = {
  ...V1,
  appInfo: true,
  missing: 'html200',
  multiOptionGreeks: true,
  wsPing: true,
  historySource: true,
}
const V2_0_1_6 = { ...V2_0_0_0, authDeadline: true, orderStream: true, modeLabels: true }
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

/** The POST endpoint ids a profile serves under /api/v1. */
export function endpointsOf(p) {
  return [
    ...BASE_ENDPOINTS,
    ...(p.multiOptionGreeks ? ['multioptiongreeks'] : []),
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
