// The synthetic golden inputs (design 9.2): the edges no recording reaches in an afternoon, built
// from the mock NIFTY recording so the server's own Python (npm run gen-golden) says what the phone
// must answer. Each is test/golden/inputs/synthetic-<case>.json:
//   nifty-expiry-1500    the expiry day at 15:00 IST, before the 15:30 cut-off (Gamma Density's
//                        intraday horizon past the close);
//   nifty-expired-1545   the expiry day at 15:45 IST, after it: every leg priced at t = 0;
//   nifty-unpriced-1545  the same, with every leg's ltp null and every OI 0 (GEX, IV Smile and
//                        Max Pain with nothing to work with);
//   nifty-gaps           mid-week, with strikes of zero OI on either side and the ATM put unpriced;
//   crudeoil-mcx-2000    CRUDEOIL on MCX at 20:00 IST on its expiry day, before MCX's 23:30 cut-off.
//   node scripts/golden/synthetic.mjs [--check]
// --check exits 1 when a committed file differs from what this builds.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestKey } from '../lib/golden-keys.mjs'

const INPUTS = fileURLToPath(new URL('../../test/golden/inputs/', import.meta.url))
const BASE = 'mock-nifty.json'
const TOP_KEYS = ['case', 'source', 'serverNowMs', 'underlying', 'exchange', 'expiry', 'fut']

/** IST wall time as epoch ms. */
const ist = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - 330 * 60_000

const clone = (x) => JSON.parse(JSON.stringify(x))
const legsOf = (chain) => chain.flatMap((r) => [r.ce, r.pe]).filter(Boolean)

/** `base` with its clock at `nowMs` (every chain's server_ts with it) and `edit(chain)` applied. */
function variant(base, id, nowMs, edit = () => {}) {
  const out = clone(base)
  out.case = id
  out.source = 'synthetic'
  out.serverNowMs = nowMs
  for (const [key, body] of Object.entries(out.responses)) {
    if (!key.startsWith('optionchain ')) continue
    body.server_ts = nowMs / 1000
    edit(body)
  }
  return out
}

/** The NIFTY recording moved to CRUDEOIL on MCX: strikes 18,000 lower around 6,000, the same
 *  premiums and OI, a 100 lot, expiring 16 Dec 26 (options) with futures from 18 Dec 26. */
function crudeoil(base, nowMs) {
  const U = 'CRUDEOIL'
  const X = 'MCX'
  const E = '16DEC26'
  const FUT = 'CRUDEOIL18DEC26FUT'
  const SHIFT = 18_000
  const responses = {}
  for (const [key, body] of Object.entries(base.responses)) {
    const [endpoint, raw] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)]
    const asked = JSON.parse(raw)
    if (endpoint === 'expiry') {
      const futures = asked.instrumenttype === 'futures'
      const data = futures ? ['18-DEC-26', '19-JAN-27'] : ['16-DEC-26', '14-JAN-27']
      const kind = futures ? 'futures' : 'options'
      responses[requestKey('expiry', { ...asked, symbol: U, exchange: X })] = {
        ...body,
        message: `Found ${data.length} expiry dates for ${U} ${kind} in ${X}`,
        data,
      }
    } else if (endpoint === 'optionchain') {
      const c = clone(body)
      c.underlying = U
      c.underlying_symbol = U
      c.underlying_exchange = X
      c.underlying_ltp = Math.round((c.underlying_ltp - SHIFT) * 100) / 100
      c.underlying_prev_close -= SHIFT
      c.expiry_date = E
      c.atm_strike -= SHIFT
      c.expiry_ts = ist(2026, 12, 16, 23, 30) / 1000
      c.server_ts = nowMs / 1000
      for (const row of c.chain) {
        row.strike -= SHIFT
        for (const [side, leg] of [
          ['CE', row.ce],
          ['PE', row.pe],
        ]) {
          if (!leg) continue
          leg.symbol = `${U}${E}${row.strike}${side}`
          leg.lotsize = 100
        }
      }
      responses[
        requestKey('optionchain', { ...asked, underlying: U, exchange: X, expiry_date: E })
      ] = c
    } else if (endpoint === 'quotes') {
      const q = clone(body)
      for (const k of ['open', 'high', 'low', 'ltp', 'prev_close', 'bid', 'ask']) {
        q.data[k] = Math.round((q.data[k] - SHIFT) * 100) / 100
      }
      responses[requestKey('quotes', { symbol: FUT, exchange: X })] = q
    }
  }
  return {
    case: 'crudeoil-mcx-2000',
    source: 'synthetic',
    serverNowMs: nowMs,
    underlying: U,
    exchange: X,
    expiry: E,
    fut: FUT,
    responses,
  }
}

export function synthetic(base) {
  const expiryDay = (h, mi) => ist(2026, 12, 1, h, mi)
  return {
    'nifty-expiry-1500': variant(base, 'nifty-expiry-1500', expiryDay(15, 0)),
    'nifty-expired-1545': variant(base, 'nifty-expired-1545', expiryDay(15, 45)),
    'nifty-unpriced-1545': variant(base, 'nifty-unpriced-1545', expiryDay(15, 45), (c) => {
      for (const leg of legsOf(c.chain)) {
        leg.ltp = null
        leg.oi = 0
      }
    }),
    'nifty-gaps': variant(base, 'nifty-gaps', base.serverNowMs, (c) => {
      for (const [i, row] of c.chain.entries()) {
        // every third strike has no OI on one side, every fifth on both
        if (i % 3 === 0 && row.ce) row.ce.oi = 0
        if (i % 5 === 0) {
          if (row.ce) row.ce.oi = 0
          if (row.pe) row.pe.oi = 0
        }
        if (row.strike === c.atm_strike && row.pe) row.pe.ltp = null
      }
    }),
    'crudeoil-mcx-2000': crudeoil(base, ist(2026, 12, 16, 20, 0)),
  }
}

/** The file's text as record-fixtures writes one: fixed top-level order, sorted responses. */
export function inputText(input) {
  const out = {}
  for (const k of TOP_KEYS) out[k] = input[k]
  out.responses = Object.fromEntries(
    Object.keys(input.responses)
      .sort()
      .map((k) => [k, input.responses[k]]),
  )
  return `${JSON.stringify(out, null, 2)}\n`
}

function main(argv) {
  const base = JSON.parse(readFileSync(join(INPUTS, BASE), 'utf8'))
  const check = argv.includes('--check')
  let stale = 0
  for (const [id, input] of Object.entries(synthetic(base))) {
    const file = join(INPUTS, `synthetic-${id}.json`)
    const text = inputText(input)
    if (check) {
      let now = ''
      try {
        now = readFileSync(file, 'utf8')
      } catch {}
      if (now !== text) {
        console.log(`synthetic-${id}.json: differs from what synthetic.mjs builds`)
        stale += 1
      }
    } else {
      writeFileSync(file, text)
      console.log(`synthetic-${id}.json`)
    }
  }
  return stale ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
