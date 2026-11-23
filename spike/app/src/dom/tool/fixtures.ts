// THROWAWAY SPIKE. Fake OpenAlgo backend for the Max Pain page: answers the exact HTTP calls the unchanged frontend makes, so the tool can open with no server.
//
// Pure TypeScript with no DOM or React Native imports: the DOM side uses it
// directly ('dom' fixture mode) and the native screen uses it to answer
// requests forwarded over the DOM bridge ('native' fixture mode).
//
// The numbers are invented but shaped like a real NSE chain: strikes spaced by
// the index step around spot, CE OI piling up above spot (resistance), PE OI
// below (support), OI in units of quantity (lakhs of shares) and pain computed
// with the same formula as openalgo/services/oi_tracker_service.py.

export interface FixtureRequest {
  method: string;
  /** URL as the page passed it (relative, e.g. '/search/api/expiries?...'). */
  url: string;
  body?: string | null;
}

export interface FixtureResponse {
  status: number;
  body: unknown;
}

interface Spec {
  spot: number;
  step: number;
  lot: number;
}

const SPECS: Record<string, Spec> = {
  NIFTY: { spot: 24012.35, step: 50, lot: 65 },
  BANKNIFTY: { spot: 54230.8, step: 100, lot: 30 },
  FINNIFTY: { spot: 25510.4, step: 50, lot: 60 },
  MIDCPNIFTY: { spot: 12690.15, step: 25, lot: 120 },
  NIFTYNXT50: { spot: 66340.5, step: 100, lot: 25 },
  SENSEX: { spot: 79120.6, step: 100, lot: 20 },
  BANKEX: { spot: 61050.2, step: 100, lot: 30 },
  RELIANCE: { spot: 1412.5, step: 10, lot: 500 },
  HDFCBANK: { spot: 1735.2, step: 10, lot: 550 },
  ICICIBANK: { spot: 1288.4, step: 10, lot: 700 },
  INFY: { spot: 1891.7, step: 20, lot: 400 },
  TCS: { spot: 3922.15, step: 20, lot: 175 },
  SBIN: { spot: 812.35, step: 5, lot: 750 },
  CRUDEOIL: { spot: 5820, step: 50, lot: 100 },
  GOLDM: { spot: 76250, step: 100, lot: 10 },
};

const UNDERLYINGS: Record<string, string[]> = {
  NFO: [
    'AXISBANK', 'BAJFINANCE', 'BANKNIFTY', 'BHARTIARTL', 'FINNIFTY', 'HDFCBANK', 'HINDUNILVR',
    'ICICIBANK', 'INFY', 'ITC', 'KOTAKBANK', 'LT', 'M&M', 'MARUTI', 'MIDCPNIFTY', 'NIFTY',
    'NIFTYNXT50', 'RELIANCE', 'SBIN', 'SUNPHARMA', 'TATAMOTORS', 'TATASTEEL', 'TCS', 'TITAN',
    'ULTRACEMCO', 'WIPRO',
  ],
  BFO: ['BANKEX', 'SENSEX'],
  MCX: ['COPPER', 'CRUDEOIL', 'GOLD', 'GOLDM', 'NATURALGAS', 'SILVER', 'SILVERM', 'ZINC'],
  CRYPTO: ['BTC', 'ETH'],
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function fmtExpiry(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  return `${dd}-${MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}

/** Three expiries in OpenAlgo's DD-MMM-YY form, computed from today's date. */
export function expiriesFor(exchange: string, underlying: string): string[] {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  // NSE index weeklies expire on Tuesday, BSE on Thursday.
  const weekday = exchange === 'BFO' ? 4 : 2;
  // Only NIFTY (NSE) and SENSEX (BSE) still have weekly expiries.
  if (underlying === 'NIFTY' || underlying === 'SENSEX') {
    const out: string[] = [];
    const d = new Date(now);
    while (out.length < 2) {
      if (d.getDay() === weekday) out.push(fmtExpiry(d));
      d.setDate(d.getDate() + 1);
    }
    // Plus the monthly: last such weekday of next month.
    const m = new Date(now.getFullYear(), now.getMonth() + 2, 0);
    while (m.getDay() !== weekday) m.setDate(m.getDate() - 1);
    out.push(fmtExpiry(m));
    return out;
  }
  // Everything else: monthly expiries (last weekday of this and next two months).
  const out: string[] = [];
  for (let k = 0; out.length < 3; k++) {
    const m = new Date(now.getFullYear(), now.getMonth() + 1 + k, 0);
    while (m.getDay() !== weekday) m.setDate(m.getDate() - 1);
    if (m >= now) out.push(fmtExpiry(m));
  }
  return out;
}

// Small deterministic PRNG so the same underlying + expiry always gives the same chain.
function seeded(seedText: string) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

export const STRIKE_COUNT = 41;

/** Per-strike CE/PE OI (quantity) for 41 strikes around spot. */
export function chainFor(underlying: string, expiryApi: string) {
  const spec = SPECS[underlying] ?? { spot: 1000, step: 10, lot: 500 };
  const rnd = seeded(`${underlying}|${expiryApi}`);
  const atm = Math.round(spec.spot / spec.step) * spec.step;
  const half = (STRIKE_COUNT - 1) / 2;
  // OI scale: NIFTY near-weekly ATM strikes carry roughly 1 crore (100 lakh) quantity.
  const scale = (underlying === 'NIFTY' ? 1e7 : 3e6) * (0.6 + rnd() * 0.5);
  const rows: { strike: number; ce_oi: number; pe_oi: number; ce_vol: number; pe_vol: number }[] = [];
  for (let i = -half; i <= half; i++) {
    const strike = atm + i * spec.step;
    const ceBias = Math.exp(-(((i - 6) / 9) ** 2)); // CE writers sit above spot
    const peBias = Math.exp(-(((i + 6) / 9) ** 2)); // PE writers sit below spot
    const round = strike % (spec.step * 10) === 0 ? 1.6 : strike % (spec.step * 2) === 0 ? 1.15 : 1;
    const ce_oi = Math.round(scale * (0.06 + ceBias) * round * (0.75 + rnd() * 0.5));
    const pe_oi = Math.round(scale * (0.06 + peBias) * round * (0.75 + rnd() * 0.5));
    rows.push({
      strike,
      ce_oi,
      pe_oi,
      ce_vol: Math.round(ce_oi * (2 + rnd() * 6)),
      pe_vol: Math.round(pe_oi * (2 + rnd() * 6)),
    });
  }
  return { spec, atm, rows };
}

/** Same algorithm as calculate_max_pain() in openalgo/services/oi_tracker_service.py. */
export function maxPainFor(underlying: string, exchange: string, expiryApi: string) {
  const { spec, atm, rows } = chainFor(underlying, expiryApi);
  const painData = rows.map((c) => {
    let ce_pain = 0;
    let pe_pain = 0;
    for (const r of rows) {
      if (c.strike > r.strike && r.ce_oi > 0) ce_pain += (c.strike - r.strike) * r.ce_oi;
      if (c.strike < r.strike && r.pe_oi > 0) pe_pain += (r.strike - c.strike) * r.pe_oi;
    }
    const total = ce_pain + pe_pain;
    return {
      strike: c.strike,
      ce_pain: Math.round(ce_pain * 100) / 100,
      pe_pain: Math.round(pe_pain * 100) / 100,
      total_pain: Math.round(total * 100) / 100,
      total_pain_cr: Math.round((total / 1e7) * 100) / 100,
    };
  });
  const best = painData.reduce((a, b) => (b.total_pain < a.total_pain ? b : a));
  const totCe = rows.reduce((s, r) => s + r.ce_oi, 0);
  const totPe = rows.reduce((s, r) => s + r.pe_oi, 0);
  const volCe = rows.reduce((s, r) => s + r.ce_vol, 0);
  const volPe = rows.reduce((s, r) => s + r.pe_vol, 0);
  const isCommodity = exchange === 'MCX';
  return {
    status: 'success' as const,
    underlying,
    spot_price: spec.spot,
    futures_price: isCommodity ? null : Math.round(spec.spot * 1.0042 * 100) / 100,
    atm_strike: atm,
    max_pain_strike: best.strike,
    lot_size: spec.lot,
    pcr_oi: Math.round((totPe / totCe) * 100) / 100,
    pcr_volume: Math.round((volPe / volCe) * 100) / 100,
    expiry_date: expiryApi,
    pain_data: painData,
  };
}

function parse(url: string) {
  const q = url.indexOf('?');
  const path = (q < 0 ? url : url.slice(0, q)).replace(/^[a-z]+:\/\/[^/]*/i, '');
  const query: Record<string, string> = {};
  if (q >= 0) {
    for (const part of url.slice(q + 1).split('&')) {
      if (!part) continue;
      const [k, v = ''] = part.split('=');
      query[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    }
  }
  return { path, query };
}

export function pathOf(url: string) {
  return parse(url).path;
}

/** Answer one request, or null when the route is not one the spike knows. */
export function respond(req: FixtureRequest): FixtureResponse | null {
  const { path, query } = parse(req.url);
  const method = req.method.toUpperCase();
  if (method === 'GET' && path === '/auth/csrf-token') {
    return { status: 200, body: { csrf_token: 'spike-fixture-csrf-token' } };
  }
  if (method === 'GET' && path === '/search/api/underlyings') {
    return { status: 200, body: { status: 'success', underlyings: UNDERLYINGS[query.exchange] ?? [] } };
  }
  if (method === 'GET' && path === '/search/api/expiries') {
    return {
      status: 200,
      body: { status: 'success', expiries: expiriesFor(query.exchange ?? 'NFO', query.underlying ?? '') },
    };
  }
  if (method === 'POST' && path === '/oitracker/api/maxpain') {
    let p: { underlying?: string; exchange?: string; expiry_date?: string } = {};
    try {
      p = req.body ? JSON.parse(req.body) : {};
    } catch {
      return { status: 400, body: { status: 'error', message: 'Invalid JSON body' } };
    }
    if (!p.underlying || !p.expiry_date) {
      return { status: 400, body: { status: 'error', message: 'underlying and expiry_date are required' } };
    }
    return { status: 200, body: maxPainFor(p.underlying, p.exchange ?? 'NFO', p.expiry_date) };
  }
  return null;
}
