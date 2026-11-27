// The tool endpoints' answers: the GET-only routes' lists, the tearsheet and the empty-series
// replies of the backtest, holdings and sector rotation routes (restx_api/{portfolio,sip,
// sector_rotation}.py and their services at c8b2896). By default the POSTs answer the full report
// fixtures of toolReports.mjs (every tab of the backtest, the SIP report, holdings, two sectors on
// the rotation map). While the control `thinToolReplies` is set they answer the thin replies
// below instead: the pages' first fields with empty series, the E-SH-8 error case.
import { backtestReport, holdingsReport, rotationInstruments, sipReport } from './toolReports.mjs'

// services/portfolio_service.py list_benchmarks: index rows of the master, by exchange, symbol.
export const BENCHMARKS = [
  { symbol: 'SENSEX', exchange: 'BSE_INDEX', name: 'SENSEX' },
  { symbol: 'BANKNIFTY', exchange: 'NSE_INDEX', name: 'NIFTY BANK' },
  { symbol: 'FINNIFTY', exchange: 'NSE_INDEX', name: 'NIFTY FIN SERVICE' },
  { symbol: 'INDIAVIX', exchange: 'NSE_INDEX', name: 'INDIA VIX' },
  { symbol: 'MIDCPNIFTY', exchange: 'NSE_INDEX', name: 'NIFTY MID SELECT' },
  { symbol: 'NIFTY', exchange: 'NSE_INDEX', name: 'NIFTY 50' },
  { symbol: 'NIFTY500', exchange: 'NSE_INDEX', name: 'NIFTY 500' },
  { symbol: 'NIFTYNXT50', exchange: 'NSE_INDEX', name: 'NIFTY NEXT 50' },
]

// services/sip_service.py list_frequencies.
export const SIP_FREQUENCIES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
]

const inst = (symbol, label) => ({ symbol, exchange: 'NSE_INDEX', label })
// services/sector_rotation_service.py list_options.
export const ROTATION_OPTIONS = {
  benchmarks: [
    inst('NIFTY', 'Nifty 50'),
    inst('NIFTY500', 'Nifty 500'),
    inst('BANKNIFTY', 'Bank Nifty'),
    { symbol: 'SENSEX', exchange: 'BSE_INDEX', label: 'Sensex' },
    inst('NIFTYNXT50', 'Nifty Next 50'),
    inst('MIDCPNIFTY', 'Midcap Nifty'),
    inst('FINNIFTY', 'Fin Nifty'),
  ],
  timeframes: ['daily', 'weekly'],
  exchanges: ['NSE', 'BSE', 'NSE_INDEX', 'BSE_INDEX', 'MCX_INDEX', 'GLOBAL_INDEX'],
  max_instruments: 40,
  sectors: [
    inst('NIFTYAUTO', 'Auto'),
    inst('NIFTYCOMMODITIES', 'Commodities'),
    inst('NIFTYENERGY', 'Energy'),
    inst('FINNIFTY', 'Financial Services'),
    inst('NIFTYFMCG', 'FMCG'),
    inst('NIFTYINFRA', 'Infra'),
    inst('NIFTYIT', 'IT'),
    inst('NIFTYMEDIA', 'Media'),
    inst('NIFTYMETAL', 'Metal'),
    inst('NIFTYPHARMA', 'Pharma'),
    inst('NIFTYPVTBANK', 'Private Bank'),
    inst('NIFTYPSE', 'PSE'),
    inst('NIFTYPSUBANK', 'PSU Bank'),
    inst('NIFTYREALTY', 'Realty'),
  ],
  optional_sectors: [
    inst('NIFTYCONSRDURBL', 'Consumer Durables'),
    inst('NIFTYHEALTHCARE', 'Healthcare'),
    inst('NIFTYINDDEFENCE', 'India Defence'),
    inst('NIFTYOILANDGAS', 'Oil & Gas'),
  ],
  max_tail: 30,
}

export const TEARSHEET_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Portfolio tearsheet</title></head>' +
  '<body><h1>Portfolio tearsheet</h1><p>The mock server renders no charts.</p></body></html>'

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)

/**
 * The success body of a tool POST for its request body. `id` is the endpoint id under /api/v1.
 * `thin` serves the empty-series reply (`status`, `meta` or `request`, no analytics).
 */
export function toolReply(id, body, { thin = false } = {}) {
  if (!thin) {
    if (id === 'portfolio/backtest') return backtestReport(body)
    if (id === 'sip/backtest') return sipReport(body)
    if (id === 'portfolio/holdings') return holdingsReport(body)
  }
  if (id === 'portfolio/backtest') {
    const holdings = Array.isArray(body.holdings) ? body.holdings : []
    return {
      status: 'success',
      meta: {
        symbols: holdings.map((h) => h.symbol),
        target_weights: Object.fromEntries(holdings.map((h) => [h.symbol, h.weight])),
        rule: body.rebalance ?? 'none',
        drift_band: body.drift_band ?? 0,
        cost_bps: body.cost_bps ?? 0,
        slippage: body.slippage ?? 0,
        initial_capital: body.initial_capital ?? 100_000,
        sessions: 0,
        source: body.source ?? 'db',
        start: body.start_date,
        end: body.end_date,
        benchmark: body.benchmark ?? null,
        risk_free_rate: body.risk_free_rate ?? 0,
        total_return_basis: 'price',
        data_warnings: {},
      },
      equity: [],
      benchmark_equity: [],
      metrics: {},
    }
  }
  if (id === 'sip/backtest') {
    return {
      status: 'success',
      request: {
        symbol: body.symbol,
        exchange: body.exchange ?? 'NSE',
        start_date: body.start_date,
        end_date: body.end_date,
        amount: body.amount,
        frequency: body.frequency ?? 'monthly',
        day_of_month: body.day_of_month ?? 1,
        step_up_percent: body.step_up_percent ?? 0,
        source: body.source ?? 'db',
      },
      yearly: [],
      curves: { value: [], invested: [] },
      installments: [],
      frequency_comparison: [],
      warnings: [],
    }
  }
  if (id === 'sectorrotation') {
    const benchmark = body.benchmark ?? 'NIFTY'
    const timeframe = body.timeframe ?? 'daily'
    return {
      status: 'success',
      data: {
        benchmark,
        benchmark_exchange: 'NSE_INDEX',
        benchmark_label:
          ROTATION_OPTIONS.benchmarks.find((b) => b.symbol === benchmark)?.label ?? benchmark,
        timeframe,
        source: body.source ?? 'db',
        as_of: thin ? null : '2026-11-22',
        max_tail: ROTATION_OPTIONS.max_tail,
        instruments: thin ? [] : rotationInstruments(timeframe),
        unavailable: [],
      },
    }
  }
  if (id === 'portfolio/holdings') {
    const days = body.lookback_days ?? 365
    const end = Date.now()
    return {
      status: 'success',
      summary: {
        holdings: [],
        weights: {},
        invested: null,
        current: 0,
        pnl: 0,
        pnl_pct: null,
        has_cost_basis: false,
        count: 0,
      },
      analysis: null,
      analysis_error: null,
      skipped: [],
      meta: {
        lookback_days: days,
        start: isoDay(end - days * 86_400_000),
        end: isoDay(end),
        basis: 'Your current holdings run over past prices; the mock server holds none.',
      },
    }
  }
  throw new Error(`no tool reply for ${id}`)
}
