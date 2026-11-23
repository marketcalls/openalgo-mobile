// THROWAWAY SPIKE. Deterministic test universe: 100 NSE equities and a 40-strike
// NIFTY chain, so runs on different phones see identical work.

export interface Instrument {
  symbol: string;
  exchange: string;
  base: number;
}

const NAMES = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK',
  'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI', 'BAJFINANCE', 'HCLTECH', 'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'WIPRO',
  'NESTLEIND', 'ONGC', 'NTPC', 'POWERGRID', 'TATAMOTORS', 'M&M', 'JSWSTEEL', 'TATASTEEL', 'ADANIENT', 'ADANIPORTS',
  'COALINDIA', 'BAJAJFINSV', 'GRASIM', 'TECHM', 'HINDALCO', 'DIVISLAB', 'DRREDDY', 'CIPLA', 'BRITANNIA', 'EICHERMOT',
  'HEROMOTOCO', 'APOLLOHOSP', 'BPCL', 'INDUSINDBK', 'SBILIFE', 'HDFCLIFE', 'TATACONSUM', 'BAJAJ-AUTO', 'UPL', 'SHREECEM',
  'DMART', 'PIDILITIND', 'HAVELLS', 'DABUR', 'GODREJCP', 'SIEMENS', 'AMBUJACEM', 'ICICIPRULI', 'BERGEPAINT', 'MARICO',
  'COLPAL', 'TORNTPHARM', 'LUPIN', 'BIOCON', 'AUROPHARMA', 'MUTHOOTFIN', 'CHOLAFIN', 'SRF', 'PEL', 'BANDHANBNK',
  'IDFCFIRSTB', 'PNB', 'BANKBARODA', 'CANBK', 'GAIL', 'IOC', 'HINDPETRO', 'VEDL', 'NMDC', 'SAIL',
  'TATAPOWER', 'ADANIGREEN', 'DLF', 'GODREJPROP', 'INDIGO', 'ZOMATO', 'PAYTM', 'NYKAA', 'IRCTC', 'TRENT',
  'JUBLFOOD', 'PAGEIND', 'BOSCHLTD', 'MRF', 'ABB', 'BEL', 'HAL', 'POLYCAB', 'DIXON', 'PERSISTENT',
];

function seeded(i: number): number {
  const x = Math.sin(i * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

export const WATCHLIST: Instrument[] = NAMES.map((symbol, i) => ({
  symbol,
  exchange: 'NSE',
  base: Math.round((100 + seeded(i) * 4900) * 20) / 20,
}));

export const CHAIN_UNDERLYING = { symbol: 'NIFTY', exchange: 'NSE_INDEX', base: 24000 };
export const CHAIN_EXPIRY = '27NOV26';
export const STRIKE_STEP = 50;
export const STRIKE_COUNT = 40;

export interface ChainRow {
  strike: number;
  ce: Instrument;
  pe: Instrument;
}

export const CHAIN: ChainRow[] = Array.from({ length: STRIKE_COUNT }, (_, i) => {
  const strike = CHAIN_UNDERLYING.base + (i - STRIKE_COUNT / 2) * STRIKE_STEP;
  const moneyness = (strike - CHAIN_UNDERLYING.base) / STRIKE_STEP;
  const ceBase = Math.max(0.05, 120 - moneyness * 22 + Math.max(0, -moneyness) * 25);
  const peBase = Math.max(0.05, 120 + moneyness * 22 + Math.max(0, moneyness) * 25);
  return {
    strike,
    ce: { symbol: `NIFTY${CHAIN_EXPIRY}${strike}CE`, exchange: 'NFO', base: Math.round(ceBase * 20) / 20 },
    pe: { symbol: `NIFTY${CHAIN_EXPIRY}${strike}PE`, exchange: 'NFO', base: Math.round(peBase * 20) / 20 },
  };
});

export const ALL_STREAMED: Instrument[] = [
  ...WATCHLIST,
  CHAIN_UNDERLYING,
  ...CHAIN.flatMap((r) => [r.ce, r.pe]),
];

export const keyOf = (symbol: string, exchange: string) => `${exchange}:${symbol}`;
