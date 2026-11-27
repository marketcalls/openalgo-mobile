// GENERATED from openalgo c8b2896ca8e9cb2d0200be29fbb3e9a162ac5276 (frontend/src/lib/tools.ts and hooks/useSupportedExchanges.ts) by scripts/gen-frontend.mjs. Do not edit.
export type ToolEntry = {
  id: string
  title: string
  description: string
  color: string
  initials: string
}

export const TOOLS: readonly ToolEntry[] = [
  {
    id: 'strategybuilder',
    title: 'Strategy Builder',
    description: 'Build multi-leg option strategies with live Greeks, payoff diagram and what-if simulators',
    color: '#e12afb',
    initials: 'SB',
  },
  {
    id: 'strategybuilder-portfolio',
    title: 'Strategy Portfolio',
    description: 'Saved strategies across MyTrades and Simulation watchlists',
    color: '#8e51ff',
    initials: 'SP',
  },
  {
    id: 'portfolio-backtester',
    title: 'Portfolio Backtester',
    description: 'Backtest a weighted portfolio against an index with real delivery costs, rebalancing rules, crisis periods and a full tearsheet',
    color: '#00bc7d',
    initials: 'PB',
  },
  {
    id: 'sip-backtester',
    title: 'SIP Backtester',
    description: 'What a monthly, weekly or quarterly SIP would actually have returned: XIRR, rupee-cost averaging, start-date sensitivity and how it compares with a lumpsum',
    color: '#00bc7d',
    initials: 'SB',
  },
  {
    id: 'portfolio-analyzer',
    title: 'Portfolio Analyzer',
    description: 'Grade the holdings you actually own: concentration, co-movement, drawdown resilience and behaviour in past crises',
    color: '#00a6f4',
    initials: 'PA',
  },
  {
    id: 'sector-rotation',
    title: 'Sector Rotation',
    description: 'Which NSE sectors, stocks and indices are leading, weakening, lagging or improving against a benchmark, with daily or weekly trails',
    color: '#00b8db',
    initials: 'SR',
  },
  {
    id: 'optionchain',
    title: 'Option Chain',
    description: 'Real-time option chain with live Greeks, OI data, and quick order placement',
    color: '#00bc7d',
    initials: 'OC',
  },
  {
    id: 'ivchart',
    title: 'Option Greeks',
    description: 'Historical IV, Delta, Theta, Vega, and Gamma charts for ATM options',
    color: '#8e51ff',
    initials: 'OG',
  },
  {
    id: 'oitracker',
    title: 'OI Tracker',
    description: 'Open Interest analysis with CE/PE OI bars, PCR overlay, and ATM strike marker',
    color: '#2b7fff',
    initials: 'OT',
  },
  {
    id: 'oirange',
    title: 'OI Range',
    description: 'Open Interest by strike for a custom range with ATM-relative quick selectors and optional 1-minute auto-refresh',
    color: '#00a6f4',
    initials: 'OR',
  },
  {
    id: 'maxpain',
    title: 'Max Pain',
    description: 'Max Pain strike calculation with visual pain distribution across strikes',
    color: '#fd9a00',
    initials: 'MP',
  },
  {
    id: 'straddle',
    title: 'Straddle Chart',
    description: 'Dynamic ATM Straddle chart with rolling strike, Spot, and Synthetic Futures overlay',
    color: '#00bba7',
    initials: 'SC',
  },
  {
    id: 'straddlepnl',
    title: 'Straddle PnL',
    description: 'Simulated intraday ATM straddle P&L with automated N-point adjustments and trade log',
    color: '#ff6900',
    initials: 'SP',
  },
  {
    id: 'volsurface',
    title: 'Vol Surface',
    description: '3D Implied Volatility surface across strikes and expiries using live option chain data',
    color: '#ff2056',
    initials: 'VS',
  },
  {
    id: 'gex',
    title: 'GEX Dashboard',
    description: 'Gamma Exposure analysis with OI Walls, Net GEX per strike, and top gamma strikes',
    color: '#615fff',
    initials: 'GD',
  },
  {
    id: 'strikeprofile',
    title: 'Strike Profile',
    description: 'GEX and DEX heatmap by strike and expiry with per-expiry peaks, gamma flip, call and put walls',
    color: '#155dfc',
    initials: 'SP',
  },
  {
    id: 'gammadensity',
    title: 'Gamma Density',
    description: 'Γ×OI density and convexity zones with intraday & to-expiry views, ATM IV, and ±1σ/±2σ expected-move bands',
    color: '#7ccf00',
    initials: 'GD',
  },
  {
    id: 'ivsmile',
    title: 'IV Smile',
    description: 'Implied Volatility smile with Call/Put IV curves, ATM IV, and skew analysis',
    color: '#00b8db',
    initials: 'IS',
  },
  {
    id: 'oiprofile',
    title: 'OI Profile',
    description: 'Futures candlestick with OI butterfly and daily OI change across strikes',
    color: '#ff6900',
    initials: 'OP',
  },
  {
    id: 'arbitrage',
    title: 'Arbitrage',
    description: 'Realtime futures calendar-spread scanner across NFO & MCX, ranked by executable bid/ask spread % with one-click two-leg orders',
    color: '#00a63e',
    initials: 'A',
  },
]

export const DEFAULT_UNDERLYINGS: Readonly<Record<string, readonly string[]>> = {
  NFO: ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'],
  BFO: ['SENSEX', 'BANKEX'],
  MCX: ['GOLDM', 'CRUDEOIL', 'SILVERM', 'NATURALGAS', 'COPPER'],
  CDS: ['USDINR', 'EURINR', 'GBPINR', 'JPYINR'],
  CRYPTO: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'],
}

export const FALLBACK_EXCHANGES: readonly string[] = ['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'MCX', 'CRYPTO']
