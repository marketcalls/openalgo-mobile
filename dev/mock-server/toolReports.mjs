// Full report replies for the portfolio tools, shaped as the frontend types them (frontend
// api/portfolio.ts BacktestResponse and HoldingsAnalysis, api/sip.ts SipBacktestResponse,
// api/sector-rotation.ts RotationResult). The server's services compute these with openstatz; the
// mock computes nothing, so every number is a deterministic function of the request's dates and
// symbols: enough for each tab to draw a plausible report and for a screenshot to be stable.
// `thinToolReplies` (tools.mjs) serves the empty replies instead, the E-SH-8 error case.

const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
const round = (x, n = 4) => Math.round(x * 10 ** n) / 10 ** n
const wave = (i, seed) => Math.sin(i * 0.9 + seed) * 0.5 + Math.sin(i * 0.23 + seed * 2) * 0.5

/** Evenly spaced dates from `start` to `end`, at most `max`, never fewer than 6. */
function dates(start, end, max = 48) {
  const a = Date.parse(start)
  const b = Date.parse(end)
  const from = Number.isFinite(a) ? a : Date.now() - 365 * DAY
  const to = Number.isFinite(b) && b > from + 30 * DAY ? b : from + 365 * DAY
  const n = Math.max(6, Math.min(max, Math.round((to - from) / (7 * DAY))))
  return Array.from({ length: n }, (_, i) => iso(from + ((to - from) * i) / (n - 1)))
}
const curve = (ds, base, drift, seed, vol = 0.012) => {
  let v = base
  return ds.map((date, i) => {
    v *= 1 + drift + vol * wave(i, seed)
    return { date, value: round(v, 2) }
  })
}
const maxDrawdown = (c) => {
  let peak = 0
  let worst = 0
  for (const p of c) {
    peak = Math.max(peak, p.value)
    worst = Math.min(worst, p.value / peak - 1)
  }
  return round(worst)
}
const grid = (rows, cols, seed) =>
  Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => round(wave(r * cols + c, seed) * 0.05, 4)),
  )
const band = (m) => ({
  p05: round(m * 0.4),
  p25: round(m * 0.7),
  median: round(m),
  p75: round(m * 1.3),
  p95: round(m * 1.7),
})

/** The BacktestResponse for `holdings` ([{symbol, weight}]) over the request's window. */
export function backtestReport(body) {
  const holdings = Array.isArray(body.holdings) ? body.holdings : []
  const symbols = holdings.map((h) => h.symbol)
  const total = holdings.reduce((s, h) => s + Number(h.weight || 0), 0) || 1
  const w = Object.fromEntries(holdings.map((h) => [h.symbol, round((h.weight / total) * 100, 2)]))
  const capital = body.initial_capital ?? 100_000
  const start = body.start_date
  const end = body.end_date
  const ds = dates(start, end)
  const equity = curve(ds, capital, 0.0042, 1)
  const benchmarkEquity = curve(ds, capital, 0.0034, 2)
  const dd = (() => {
    let peak = 0
    return equity.map((p) => {
      peak = Math.max(peak, p.value)
      return { date: p.date, value: round(p.value / peak - 1) }
    })
  })()
  const last = equity[equity.length - 1].value
  const totalReturn = last / capital - 1
  const years = Math.max(0.5, (Date.parse(ds[ds.length - 1]) - Date.parse(ds[0])) / (365 * DAY))
  const cagr = round((1 + totalReturn) ** (1 / years) - 1)
  const mdd = maxDrawdown(equity)
  const yearList = [...new Set(ds.map((d) => d.slice(0, 4)))]
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const rule = body.rebalance ?? 'never'
  const costs = {
    model: body.cost_model ?? 'indian_equity',
    brokerage: 0,
    stt: round(capital * 0.001, 2),
    exchange_txn: round(capital * 0.00003, 2),
    sebi: round(capital * 0.000001, 2),
    gst: round(capital * 0.000006, 2),
    stamp_duty: round(capital * 0.00015, 2),
    slippage: 0,
    total: round(capital * 0.001186, 2),
    drag: 0.0012,
    turnover: 1.1,
  }
  const sweepRows = [
    ['Never', 'never', 0],
    ['Monthly', 'monthly', 0],
    ['Quarterly', 'quarterly', 0],
    ['Yearly', 'yearly', 0],
  ].map(([label, r, band], i) => ({
    label,
    rule: r,
    drift_band: band,
    total_return: round(totalReturn * (1 - i * 0.03)),
    cagr: round(cagr * (1 - i * 0.03)),
    volatility: round(0.14 + i * 0.004),
    sharpe: round(1.1 - i * 0.05, 2),
    sortino: round(1.5 - i * 0.05, 2),
    max_drawdown: round(mdd * (1 + i * 0.02)),
    calmar: round(0.8 - i * 0.03, 2),
    cost_drag: round(0.0004 * i, 5),
    turnover: round(0.2 * i, 2),
    rebalances: i * 4,
  }))
  const alloc = {
    dates: ds,
    symbols,
    series: Object.fromEntries(symbols.map((s) => [s, ds.map(() => round((w[s] ?? 0) / 100, 4))])),
    average: Object.fromEntries(symbols.map((s) => [s, round((w[s] ?? 0) / 100, 4)])),
  }
  const returns = (i) => round(0.12 - i * 0.015)
  return {
    status: 'success',
    meta: {
      symbols,
      target_weights: Object.fromEntries(holdings.map((h) => [h.symbol, h.weight])),
      rule,
      drift_band: body.drift_band ?? 0,
      cost_bps: body.cost_bps ?? 0,
      slippage: body.slippage ?? 0,
      initial_capital: capital,
      sessions: ds.length * 5,
      source: body.source ?? 'db',
      start,
      end,
      benchmark: body.benchmark ?? null,
      risk_free_rate: body.risk_free_rate ?? 0,
      total_return_basis: 'price',
      data_warnings: {},
    },
    equity,
    benchmark_equity: benchmarkEquity,
    metrics: {
      cagr,
      volatility: 0.142,
      sharpe: 1.08,
      sortino: 1.52,
      calmar: round(cagr / Math.abs(mdd || 1), 2),
      max_drawdown: mdd,
      win_rate: 0.54,
      best_day: 0.041,
      worst_day: -0.038,
      value_at_risk: -0.019,
      cvar: -0.027,
      ulcer_index: 0.052,
      recovery_factor: 1.9,
      tail_ratio: 1.05,
      skew: -0.21,
      kurtosis: 2.4,
      alpha: 0.021,
      beta: 0.93,
      information_ratio: 0.31,
      benchmark_cagr: round(cagr * 0.85),
      excess_cagr: round(cagr * 0.15),
      up_capture: 1.04,
      down_capture: 0.91,
    },
    items: holdings.map((h, i) => ({
      symbol: h.symbol,
      weight_target: w[h.symbol],
      weight_final: round(w[h.symbol] * (1 + 0.02 * (i - 1)), 2),
      invested: round((capital * w[h.symbol]) / 100, 2),
      price_pnl: round(((capital * w[h.symbol]) / 100) * returns(i), 2),
      costs: round(costs.total / Math.max(1, holdings.length), 2),
      net_pnl: round(((capital * w[h.symbol]) / 100) * returns(i) - costs.total / 3, 2),
      contribution_pct: round((w[h.symbol] / 100) * returns(i)),
      symbol_return: returns(i),
    })),
    correlation: {
      symbols,
      matrix: symbols.map((_, r) =>
        symbols.map((_, c) => (r === c ? 1 : round(0.3 + 0.1 * ((r + c) % 3), 2))),
      ),
      average_pairwise: 0.4,
    },
    diversification: {
      hhi: 0.4,
      effective_holdings: round(Math.max(1, symbols.length * 0.8), 2),
      largest_weight: Math.max(0, ...Object.values(w)) / 100,
      holdings: symbols.length,
      diversification_ratio: 1.2,
    },
    walk_forward: {
      windows: [0, 1].map((i) => ({
        start: ds[i * 4],
        end: ds[Math.min(ds.length - 1, i * 4 + 20)],
        total_return: round(0.1 + i * 0.02),
        cagr: round(0.09 + i * 0.02),
        max_drawdown: round(-0.1 - i * 0.02),
        sessions: 120,
      })),
      summary: {
        count: 2,
        window_years: 1,
        step_years: 0.5,
        best: 0.12,
        worst: 0.1,
        median: 0.11,
        positive_share: 1,
        spread: 0.02,
      },
      note: null,
    },
    monte_carlo: {
      paths: 500,
      block: 21,
      seed: 7,
      total_return: band(totalReturn),
      cagr: band(cagr),
      max_drawdown: band(mdd),
      probability_of_loss: 0.12,
      worst_drawdown_seen: round(mdd * 1.6),
      note: null,
    },
    rebalancing_sweep: {
      variants: sweepRows,
      curves: Object.fromEntries(
        sweepRows.map((v, i) => [v.label, curve(ds, capital, 0.0042 - i * 0.0001, 1)]),
      ),
      best_by_sharpe: 'Never',
      best_by_return: 'Never',
      sessions: ds.length * 5,
      start: ds[0],
      end: ds[ds.length - 1],
    },
    attribution: {
      available: true,
      portfolio_return: round(totalReturn),
      equal_weight_return: round(totalReturn * 0.97),
      benchmark_return: round(totalReturn * 0.85),
      excess_return: round(totalReturn * 0.15),
      selection_effect: round(totalReturn * 0.08),
      allocation_effect: round(totalReturn * 0.05),
      cost_effect: -0.0012,
      holdings: holdings.map((h, i) => ({
        symbol: h.symbol,
        weight: round(w[h.symbol] / 100, 4),
        return: returns(i),
        vs_benchmark: round(returns(i) - 0.1),
        contribution: round((w[h.symbol] / 100) * returns(i)),
      })),
      holdings_reason: null,
      method: 'Brinson-style, single period',
    },
    asset_returns: symbols.map((s, i) => ({
      symbol: s,
      last: round(100 + 40 * i, 2),
      '1W': 0.004,
      '1M': 0.012,
      '3M': 0.031,
      '1Y': returns(i),
      '3Y': 0.34,
      '5Y': null,
    })),
    structure: {
      instrument_classes: { equity: 1 },
      instrument_class_basis: 'Instrument master',
      clusters: [{ id: 1, members: symbols, weight: 1, independent: false }],
      threshold: 0.6,
      effective_bets: round(Math.max(1, symbols.length * 0.7), 2),
      largest_cluster_weight: 1,
      sector_note: 'The mock server has no sector data.',
    },
    allocation: alloc,
    crisis: {
      periods: [
        {
          key: 'covid-2020',
          label: 'COVID crash',
          note: 'Feb to Mar 2020',
          start: '2020-02-20',
          end: '2020-03-23',
          scope: 'global',
          days: 32,
          sessions: 22,
          portfolio: -0.31,
          benchmark: -0.34,
          excess: 0.03,
          coverage: 1,
          partial: false,
        },
      ],
      summary: {
        count: 1,
        average_return: -0.31,
        hit_rate: 0,
        worst: -0.31,
        best: -0.31,
        by_scope: { global: { count: 1, average_return: -0.31, hit_rate: 0 } },
      },
    },
    costs,
    series: {
      drawdown: dd,
      drawdown_episodes: [{ start: ds[8], valley: ds[12], end: ds[18], days: 70, depth: mdd }],
      rolling: {
        window: 6,
        sharpe: equity
          .slice(6)
          .map((p, i) => ({ date: p.date, value: round(1 + 0.3 * wave(i, 3), 2) })),
        volatility: equity
          .slice(6)
          .map((p, i) => ({ date: p.date, value: round(0.14 + 0.02 * wave(i, 4)) })),
      },
      monthly_returns: { years: yearList, columns: months, values: grid(yearList.length, 12, 5) },
      seasonality: {
        best_month: 0.062,
        worst_month: -0.048,
        avg_up_month: 0.021,
        avg_down_month: -0.017,
        win_months: 0.58,
        win_quarters: 0.64,
      },
      weekly_returns: equity
        .slice(1)
        .map((p, i) => ({ date: p.date, value: round(0.01 * wave(i, 6)) })),
      weekly_grid: {
        years: yearList,
        weeks: Array.from({ length: 52 }, (_, i) => i + 1),
        values: grid(yearList.length, 52, 8),
      },
      return_quantiles: ['1D', '1W', '1M', '3M', '1Y'].map((period, i) => ({
        period,
        count: 200 - i * 30,
        min: -0.05 * (i + 1),
        q1: -0.01 * (i + 1),
        median: 0.003 * (i + 1),
        q3: 0.012 * (i + 1),
        max: 0.06 * (i + 1),
        mean: 0.004 * (i + 1),
        negative_share: 0.42 - i * 0.05,
      })),
      yearly_returns: yearList.map((year, i) => ({
        year,
        portfolio: round(0.12 + 0.02 * i),
        benchmark: round(0.1 + 0.01 * i),
        difference: round(0.02 + 0.01 * i),
        won: true,
        multiplier: 1.2,
      })),
    },
    health: {
      score: 74,
      grade: 'B',
      pillars: [
        ['returns', 'Returns', 80],
        ['risk', 'Risk', 70],
        ['diversification', 'Diversification', 65],
        ['costs', 'Costs', 90],
      ].map(([key, label, score]) => ({
        key,
        label,
        score,
        weight: 0.25,
        effective_weight: 0.25,
        formula: `${label} score from the report's own numbers`,
        inputs: { cagr, max_drawdown: mdd },
        comment: `${label} reads ${score} of 100 on this window.`,
      })),
      unmeasured: [],
    },
    rebalancing: {
      rule,
      drift_band: body.drift_band ?? 0,
      count: rule === 'never' ? 0 : 4,
      cost_drag: 0.0004,
      turnover_total: 0.8,
      dates: rule === 'never' ? [] : ds.filter((_, i) => i % 12 === 0).slice(1),
    },
  }
}

/** The SipBacktestResponse for the request. */
export function sipReport(body) {
  const frequency = body.frequency ?? 'monthly'
  const amount = body.amount ?? 10_000
  const start = body.start_date
  const end = body.end_date
  const ds = dates(start, end, 36)
  const n = ds.length
  const invested = ds.map((date, i) => ({ date, value: amount * (i + 1) }))
  const value = ds.map((date, i) => ({
    date,
    value: round(amount * (i + 1) * (1 + 0.004 * i + 0.02 * wave(i, 1)), 2),
  }))
  const totalIn = invested[n - 1].value
  const final = value[n - 1].value
  const years = Math.max(0.5, (Date.parse(ds[n - 1]) - Date.parse(ds[0])) / (365 * DAY))
  const xirr = round(0.14 + 0.01 * wave(1, 2))
  const headline = (seed) => ({
    invested: totalIn,
    final_value: round(final * seed, 2),
    gain: round(final * seed - totalIn, 2),
    multiple: round((final * seed) / totalIn, 3),
    xirr,
    absolute_return: round((final * seed) / totalIn - 1),
    installments: n,
    units: round(final / 100, 3),
    average_cost: 96.4,
    average_price: 98.1,
    cost_advantage: -0.017,
    charges: round(totalIn * 0.0012, 2),
    cash: 120.5,
    start: ds[0],
    end: ds[n - 1],
    years: round(years, 2),
  })
  const yearList = [...new Set(ds.map((d) => Number(d.slice(0, 4))))]
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const run = (shift) => ({
    start: ds[0],
    invested: totalIn,
    final_value: round(final * (1 + shift), 2),
    installments: n,
    xirr: round(xirr + shift),
    multiple: round((final * (1 + shift)) / totalIn, 3),
    absolute_return: round((final * (1 + shift)) / totalIn - 1),
    average_cost: 96.4,
  })
  return {
    status: 'success',
    request: {
      symbol: body.symbol,
      exchange: body.exchange ?? 'NSE',
      start_date: start,
      end_date: end,
      amount,
      frequency,
      day_of_month: body.day_of_month ?? 1,
      step_up_percent: body.step_up_percent ?? 0,
      source: body.source ?? 'db',
    },
    headline: headline(1),
    underwater: {
      sessions_below: 41,
      sessions_total: n * 5,
      share_below: round(41 / (n * 5)),
      longest_streak_sessions: 18,
      longest_streak_ended: ds[Math.min(n - 1, 10)],
      worst_shortfall: -0.09,
      ever_underwater: true,
    },
    drawdown: {
      max_drawdown: -0.14,
      trough_date: ds[Math.min(n - 1, 12)],
      recovery_sessions: 55,
      recovered: true,
      curve: value.map((p, i) => ({ date: p.date, value: round(-0.05 * Math.abs(wave(i, 3))) })),
    },
    yearly: yearList.map((year, i) => ({
      year,
      invested_during_year: amount * 12,
      invested_to_date: amount * 12 * (i + 1),
      value: round(amount * 12 * (i + 1) * 1.08, 2),
      gain: round(amount * 12 * (i + 1) * 0.08, 2),
      change: 0.08,
    })),
    monthly_heatmap: {
      years: yearList.map(String),
      columns: months,
      values: grid(yearList.length, 12, 4),
    },
    lumpsum: {
      invested: totalIn,
      final_value: round(final * 0.96, 2),
      xirr: round(xirr - 0.01),
      entry_price: 91.2,
      entry_date: ds[0],
      sip_final_value: final,
      difference: round(final * 0.04, 2),
      sip_won: true,
    },
    frequency_comparison: ['weekly', 'fortnightly', 'monthly', 'quarterly'].map((f, i) => ({
      frequency: f,
      amount_per_installment: round(amount / (4 - i), 2),
      installments: n * (4 - i),
      invested: totalIn,
      final_value: round(final * (1 - i * 0.005), 2),
      xirr: round(xirr - i * 0.002),
      average_cost: 96.4 + i,
      charges: round(totalIn * 0.0012, 2),
    })),
    curves: { value, invested },
    installments: ds.map((d, i) => ({
      requested: d,
      executed: iso(Date.parse(d) + (i % 5 === 0 ? DAY : 0)),
      amount,
    })),
    warnings: [],
    charges: {
      total: round(totalIn * 0.0012, 2),
      per_installment: round((totalIn * 0.0012) / n, 2),
      drag: 0.0012,
      breakdown: {
        stt: round(totalIn * 0.001, 2),
        exchange_txn: round(totalIn * 0.00003, 2),
        sebi: 1,
        stamp_duty: round(totalIn * 0.00015, 2),
        tax: 4,
      },
      model: 'indian_equity',
      exchange: body.exchange ?? 'NSE',
    },
    crisis: {
      summary: { crises: 1, early_wins: 1, share: 1, median_advantage: 0.02 },
      periods: [
        {
          key: 'covid-2020',
          label: 'COVID crash',
          note: 'Feb to Mar 2020',
          scope: 'global',
          crisis_start: '2020-02-20',
          crisis_end: '2020-03-23',
          market_move: -0.34,
          market_trough: -0.38,
          started_into_it: run(0.02),
          waited_for_the_end: run(0),
          xirr_advantage: 0.02,
          starting_early_won: true,
        },
      ],
    },
    rolling_xirr: [1, 3].map((y) => ({
      years: y,
      windows: 12,
      points: ds.slice(0, 12).map((d, i) => ({
        start: d,
        end: ds[Math.min(n - 1, i + 6)],
        xirr: round(0.12 + 0.03 * wave(i, y)),
      })),
      best: 0.2,
      worst: 0.04,
      median: 0.12,
      positive_share: 0.9,
    })),
    start_date_heatmap: {
      rows: yearList.map(String),
      columns: months,
      values: grid(yearList.length, 12, 9),
    },
    sip_date_heatmap: {
      days: Array.from({ length: 28 }, (_, i) => i + 1),
      values: Array.from({ length: 28 }, (_, i) => round(0.12 + 0.01 * wave(i, 2))),
      best_day: 6,
      worst_day: 21,
      spread: 0.02,
    },
    ...(body.benchmark
      ? {
          benchmark: {
            symbol: body.benchmark,
            exchange: body.benchmark_exchange ?? 'NSE_INDEX',
            headline: headline(0.95),
            xirr: round(xirr - 0.01),
            excess_xirr: 0.01,
            beat_benchmark: true,
            curve: value.map((p) => ({ date: p.date, value: round(p.value * 0.95, 2) })),
          },
        }
      : {}),
  }
}

/** The HoldingsAnalysis: three held positions run through the same report. */
export function holdingsReport(body) {
  const days = body.lookback_days ?? 365
  const end = Date.now()
  const rows = [
    ['RELIANCE', 'NSE', 40, 2410.5, 2468.2],
    ['INFY', 'NSE', 60, 1502.4, 1561.8],
    ['NIFTYBEES', 'NSE', 300, 268.1, 274.9],
  ]
  const holdings = rows.map(([symbol, exchange, quantity, average_price, last_price]) => {
    const invested = round(quantity * average_price, 2)
    const current = round(quantity * last_price, 2)
    return {
      symbol,
      exchange,
      quantity,
      average_price,
      last_price,
      invested,
      current,
      pnl: round(current - invested, 2),
      pnl_pct: round(((current - invested) / invested) * 100, 2),
      weight: 0,
      product: 'CNC',
    }
  })
  const current = round(
    holdings.reduce((s, h) => s + h.current, 0),
    2,
  )
  for (const h of holdings) h.weight = round((h.current / current) * 100, 2)
  const invested = round(
    holdings.reduce((s, h) => s + h.invested, 0),
    2,
  )
  const start = iso(end - days * DAY)
  return {
    status: 'success',
    summary: {
      holdings,
      weights: Object.fromEntries(holdings.map((h) => [h.symbol, h.weight])),
      invested,
      current,
      pnl: round(current - invested, 2),
      pnl_pct: round(((current - invested) / invested) * 100, 2),
      has_cost_basis: true,
      count: holdings.length,
    },
    analysis: backtestReport({
      holdings: holdings.map((h) => ({ symbol: h.symbol, exchange: h.exchange, weight: h.weight })),
      start_date: start,
      end_date: iso(end),
      benchmark: body.benchmark ?? 'NIFTY',
      risk_free_rate: body.risk_free_rate ?? 0,
      source: body.source ?? 'db',
    }),
    analysis_error: null,
    skipped: [],
    meta: {
      lookback_days: days,
      start,
      end: iso(end),
      basis: 'Your current holdings run over past prices; this is the mock server.',
    },
  }
}

/** Two instruments on the map: one leading, one lagging, each with a three-bar tail. */
export function rotationInstruments(timeframe) {
  const tail = (r, m) =>
    [0, 1, 2].map((i) => ({
      date: iso(Date.parse('2026-11-20') + i * (timeframe === 'weekly' ? 7 : 1) * DAY),
      rs_ratio: round(r - (2 - i) * 0.4, 2),
      rs_momentum: round(m - (2 - i) * 0.3, 2),
    }))
  const entry = (symbol, label, quadrant, r, m) => ({
    symbol,
    exchange: 'NSE_INDEX',
    label,
    quadrant,
    rs_ratio: r,
    rs_momentum: m,
    bars_in_quadrant: 3,
    tail: tail(r, m),
  })
  return [
    entry('NIFTYIT', 'IT', 'leading', 101.2, 100.6),
    entry('NIFTYPHARMA', 'Pharma', 'lagging', 98.7, 99.1),
  ]
}
