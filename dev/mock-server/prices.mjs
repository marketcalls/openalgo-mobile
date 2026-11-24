// Deterministic per-symbol random walk, ported from spike/mock-feed/server.mjs. REST quotes
// and WS ticks read the same book, so a seed from multiquotes agrees with the first tick.

function hash32(str) {
  let h = 0x811c9dc5 // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const r05 = (x) => Math.max(0.05, Math.round(x * 20) / 20) // NSE tick size 0.05
const r2 = (x) => Math.round(x * 100) / 100

const UNDERLYING = {
  NIFTY: 24000,
  BANKNIFTY: 52000,
  FINNIFTY: 23500,
  MIDCPNIFTY: 12500,
  SENSEX: 79000,
  BANKEX: 58000,
}
const OPTION_RE = /^([A-Z&-]+?)(\d{2}[A-Z]{3}\d{2})(\d+(?:\.\d+)?)(CE|PE)$/
const FUT_RE = /^([A-Z&-]+?)(\d{2}[A-Z]{3}\d{2})FUT$/
const DERIVATIVES = ['NFO', 'BFO', 'MCX', 'CDS']

function basePrice(symbol, exchange, rng) {
  if (exchange === 'NFO' || exchange === 'BFO') {
    const opt = OPTION_RE.exec(symbol)
    if (opt) {
      const und = UNDERLYING[opt[1]] ?? 100 + rng() * 4900
      const strike = Number(opt[3])
      const intrinsic = opt[4] === 'CE' ? Math.max(0, und - strike) : Math.max(0, strike - und)
      const timeValue = 150 * Math.exp(-Math.abs(strike - und) / (und * 0.02))
      return intrinsic + timeValue + 0.05
    }
    const fut = FUT_RE.exec(symbol)
    if (fut) return (UNDERLYING[fut[1]] ?? 100 + rng() * 4900) * 1.003
  }
  if (exchange.endsWith('_INDEX')) return UNDERLYING[symbol] ?? 5000 + rng() * 45000
  return 100 + rng() * 4900
}

function seed(symbol, exchange) {
  const rng = mulberry32(hash32(`${exchange}:${symbol}`))
  const close = r05(basePrice(symbol, exchange, rng))
  const open = r05(close * (1 + (rng() - 0.5) * 0.01))
  const isDeriv = DERIVATIVES.includes(exchange)
  return {
    symbol,
    exchange,
    rng,
    close,
    open,
    ltp: open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    volume: Math.floor(rng() * 2_000_000),
    // Equities have no open interest: the field is absent from their ticks.
    oi: isDeriv ? 75 * Math.floor(rng() * 100_000) : undefined,
    isDeriv,
  }
}

/** One walk per "EXCHANGE:SYMBOL", created on first use. */
export function createPriceBook() {
  const book = new Map()
  return {
    get(symbol, exchange) {
      const key = `${exchange}:${symbol}`
      if (!book.has(key)) book.set(key, seed(symbol, exchange))
      return book.get(key)
    },
    reset() {
      book.clear()
    },
  }
}

export function step(st) {
  const tick = Math.max(0.05, st.close * 0.0005)
  st.ltp = r05(st.ltp + (st.rng() - 0.5) * 2 * tick)
  if (st.ltp > st.high) st.high = st.ltp
  if (st.ltp < st.low) st.low = st.ltp
  st.volume += 1 + Math.floor(st.rng() * 500)
  if (st.isDeriv) st.oi = Math.max(0, st.oi + 75 * Math.round((st.rng() - 0.5) * 20))
}

/** `n` levels on one side of the book, best first: buy below the LTP, sell above it. */
export function depthLevels(st, side, n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const off = 0.05 * (i + 1)
    out.push({
      price: r05(side === 'buy' ? st.ltp - off : st.ltp + off),
      quantity: 1 + Math.floor(st.rng() * 5000),
      orders: 1 + Math.floor(st.rng() * 50),
    })
  }
  return out
}

/** The REST quote fields (quotes, multiquotes). */
export function quote(st) {
  return {
    open: st.open,
    high: st.high,
    low: st.low,
    ltp: st.ltp,
    prev_close: st.close,
    bid: r05(st.ltp - 0.05),
    ask: r05(st.ltp + 0.05),
    volume: st.volume,
    oi: st.oi ?? 0,
  }
}

/**
 * The `data` of a market_data frame (S11). An undefined value is a field the broker did
 * not send; the feed omits it or sends 0, depending on the profile.
 */
export function tickData(st, mode, levels) {
  const ltt = Math.floor(Date.now() / 1000)
  if (mode === 1) return { ltp: st.ltp, ltt }
  const data = {
    ltp: st.ltp,
    ltt,
    open: st.open,
    high: st.high,
    low: st.low,
    close: st.close,
    volume: st.volume,
    oi: st.oi,
    average_price: r2((st.open + st.high + st.low + st.ltp) / 4),
    total_buy_quantity: 1000 + Math.floor(st.rng() * 900_000),
    total_sell_quantity: 1000 + Math.floor(st.rng() * 900_000),
  }
  if (mode === 3) {
    data.depth = { buy: depthLevels(st, 'buy', levels), sell: depthLevels(st, 'sell', levels) }
  }
  return data
}
